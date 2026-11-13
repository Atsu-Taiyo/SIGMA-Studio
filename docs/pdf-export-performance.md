# PDF書き出し性能の再現と計測

合成教材だけを使う。ローカルの一時プロファイルに作成・保存・再読込し、終了時に削除する。
既存アプリ、他worktree、本番サービスには接続しない。結果は `apps/desktop/test-results/` に出る。

## 再現

```sh
mise exec -- npm ci --no-audit --no-fund
NEXT_PUBLIC_SIGMA_PERF=1 mise exec -- npm --workspace @sigma-studio/desktop run electron:prepare
SIGMA_PDF_BENCH=1 SIGMA_PDF_BENCH_PAGES=10,20,40 SIGMA_PDF_BENCH_REPEATS=1 \
  mise exec -- npm run test:e2e:electron -- pdf-export-benchmark
```

`electron:prepare` はローカルの静的ビルドだけで、パッケージ公開・配布物作成・デプロイは行わない。
開発サーバー経由でも `SIGMA_STUDIO_E2E_BASE_URL` を指定して同じElectronテストを実行できる。
性能比較には静的ビルドを使い、dev/HMR確認の数値とは分ける。

1ページあたり問題・解説10段落、数式20個（分数・根号・総和）、TikZ由来SVG1枚、
960×480 PNG1枚、3×3表1個。40ページでは数式800個、図・画像・表120個。
TikZは実際のbridge/workerで1回コンパイルして結果を各ページで再利用する。
ソースと環境も保存するため編集可能。教材作成時のコンパイル時間とPDF保存時間を混ぜない。

`metrics.json`、`fixture.sigma`、`workbook.pdf`、`preview.cpuprofile`、`save.cpuprofile`、
`desktop.png` を保存する。CPUプロファイルはChrome DevToolsで開ける。
`SIGMA_STUDIO_PDF_PROFILE=1` はmain側のステージ時間を `[pdf-profile]` JSONとして出す。
教材本文・画像URL・保存パスをこの計測ログには記録しない。
rendererの `NEXT_PUBLIC_SIGMA_PERF=1` は既存の計測バッファへページ窓作成、レイアウト、
数式markup生成を記録する。通常のproduction buildではrenderer計測は無効。

Playwrightのtraceを無効にし、待機中のUIを `waitForFunction` で観測する。
`expect(locator).toBeVisible()` 等は未成立時のARIAスナップショットが文書全体を走査し、
巨大なDOMでは実際の出力と競合する。探索時にこの負荷を確認したため比較値から除外した。
CPUプロファイル採取自体の負荷と、他のローカル処理の影響は残る。

## コード上の経路

| ステージ | 所有するコード・動作 |
|---|---|
| UI起動・保存 | `editor-shell/chrome/editor-chrome.tsx` → `use-document-print-controller.ts`。teacherプレビューを開き、保存時に現在の教材を保存して同一OutputSessionを渡す |
| 投影・レイアウト・分割 | `PagedRenderSurface.tsx` → `getPrintableDocument` → `PageCanvasEditor` / `use-page-canvas-measurement.ts`。フォント・画像待ち、100ms×5の安定観測後に `page-windows.ts` で確定DOMをページ窓へ複製 |
| 数式 | `rendering/adapters/math-html.ts` → `lib/math-tex.ts`。MathLiveの静的markupが第一候補、KaTeXがfallback。LRUキャッシュあり。MathJaxはこの経路にない。PDF保存時の再組版はない |
| TikZ・SVG | `tikz/use-tikz-editor.tsx` → IPC → `tikz-renderer.ts` → `tikz-worker.ts` / node-tikzjax。挿入・編集時にSVG画像化。PDF保存時のTeXコンパイルはない。通常の図形は画面と共通のSVG/React描画 |
| 画像 | `overlay-canvas/shape-renderer.tsx` のimg。出力時はcanvas→PNG、blob→data URL、private storage→解決済みdata URL、APNG→先頭フレーム。`writeHiddenPdfPage` が読み込みを待つ。出力専用のリサイズ処理はない |
| IPC・capture | `preload.ts` → `ipc/file.ts` → `pdf-output-session.ts`。起動元WebContentsから1ページをclone・CSS絶対URL化・serializeし、同じsessionの隠しBrowserWindowへ渡す |
| フォント・座標固定 | `pdf-font-settle.ts` で先にlayoutを起こしてfont loadingを待つ（20秒上限・失敗時中止）。`pdf-flow-snapshot.ts` で確定矩形を固定し2フレーム待つ |
| PDF生成・埋込 | Electron/Chromium `printToPDF` をページごとに1回。文字・数式・SVGはベクター。フォントsubset/埋込と最終画像decode・paintはこの内部で実行され、個別の公開計測APIはない |
| 検証・結合・保存 | pdf-libで1ページ/MediaBox検証→copyPages→用紙寸法正規化→結合後再検証→revision照合済みのPDFをfs.writeFile。異なるrevisionは混ぜない |

`prepare-ipc` の内訳（HTML parse・image load・font/layout settle・flow snapshot・paint frames）は
親の時間に含まれる。合計へ二重加算しない。画像loadはdecode単独値ではない。
プレビュー時間は組版・レイアウト・安定待ち・ページ窓作成を含み、保存時間とは別。

## 2026-11-13の結果

Apple M5 Pro / arm64 / RAM 64GiB / Electron 45.2.3。修正前はorigin/mainの
`6ddd41a0` (v0.535.1) に計測プローブだけを追加。各サイズ・各実装1回、毎回新しい
アプリプロセス・空の検証プロファイルで、プレビューがフォントを読み込んだ後に保存した。
これは単一マシンの比較であり、中央値・p95やOS全体のcold cache値ではない。
元の測定値は [JSON](benchmarks/pdf-export-2026-11-13.json) に保存した。

| ページ数 | プレビュー前→後 (秒) | 保存前→後 (秒) | 保存短縮 | プレビューDOM前→後 |
|---|---:|---:|---:|---:|
| 10 | 3.32 → 2.58 | 8.28 → 2.94 | 64.5% | 138,110 → 19,850 |
| 20 | 8.77 → 3.41 | 29.21 → 5.70 | 80.5% | 551,220 → 51,900 |
| 40 | 34.39 → 7.56 | 124.98 → 15.67 | 87.5% | 2,202,440 → 152,600 |

### ステージ別（秒、各ページの合計）

| ステージ | 前10 | 後10 | 前20 | 後20 | 前40 | 後40 |
|---|---:|---:|---:|---:|---:|---:|
| プレビュー全体 | 3.322 | 2.585 | 8.771 | 3.410 | 34.387 | 7.560 |
| 内: ページ窓作成 | 0.147 | 0.074 | 0.558 | 0.102 | 2.835 | 0.265 |
| 隠しウィンドウload | 0.141 | 0.150 | 0.144 | 0.141 | 0.154 | 0.144 |
| DOM/CSS取得・IPC | 0.298 | 0.233 | 0.837 | 0.480 | 3.623 | 1.271 |
| private画像参照解決/HTML置換 | 0.019 | 0.061 | 0.214 | 0.032 | 0.731 | 0.289 |
| 隠しDOM準備・IPC | 2.131 | 0.713 | 7.488 | 1.364 | 33.440 | 3.763 |
| 内: HTML parse | 0.948 | 0.207 | 3.726 | 0.450 | 18.233 | 1.256 |
| 内: 画像load待ち | 0.077 | 0.044 | 0.143 | 0.049 | 0.222 | 0.056 |
| 内: フォント/layout settle | 0.466 | 0.154 | 1.584 | 0.267 | 6.567 | 0.729 |
| 内: flow座標固定 | 0.303 | 0.058 | 1.208 | 0.175 | 5.730 | 0.779 |
| 内: 描画フレーム待ち | 0.121 | 0.057 | 0.394 | 0.136 | 1.528 | 0.357 |
| printToPDF (画像paint/フォント埋込含む) | 5.363 | 1.576 | 19.522 | 3.378 | 84.108 | 9.583 |
| 単ページ検証 | 0.013 | 0.013 | 0.022 | 0.020 | 0.047 | 0.040 |
| ページ結合 | 0.045 | 0.043 | 0.081 | 0.075 | 0.152 | 0.141 |
| 結合後検証 | 0.018 | 0.021 | 0.041 | 0.038 | 0.076 | 0.072 |
| ファイル書込 | 0.013 | 0.013 | 0.029 | 0.013 | 0.029 | 0.019 |
| 保存全体 (UI/教材保存含む) | 8.283 | 2.937 | 29.206 | 5.701 | 124.985 | 15.666 |

TikZ初回コンパイル（教材作成時）は前10/20/40で2.16/1.34/1.70秒、
後は2.19/1.23/1.51秒。PDF保存中には呼ばれない。
数式の初回markup生成は修正後追加のrendererプローブで0.121/0.117/0.223秒
（初回教材表示を含む集計）。保存時には確定したmarkupをコピーし、数式エンジンは再実行しない。
フォント埋込と最終decodeはprintToPDF内のため、単独の計測値として分離できていない。

### 根本原因と変更

元のページ窓は、ページ外の絶対配置図形を省く一方、本文は全文を各ページへ複製していた。
文書量をページ数に比例して増やすと、数式glyphのDOMがページ数の二乗に比例して増える。
この全文DOMを各ページで再解析・layout・printするため、40ページではprintToPDF 84.108秒、
準備33.440秒となった。10→20→40の保存時間は3.53倍・4.28倍で、二次増加と整合する。
数式TeXの再コンパイルやPDF結合が支配的なのではない。

`page-windows.ts` で、実測済みの段落・見出しの外箱（高さ、余白、順序）を維持し、
当該ページから完全に外れる内側の文字・数式DOMだけをゼロ幅文字に置き換える。
子要素の矩形と32pxのink余白を含め、ページをまたぐ内容は両方に残す。
未計測の箱・SVG/画像等・箱タイトルは保守的に保持する。
TiptapのsrcなしProseMirror-separator画像はカーソル用のダミーとして区別する。
確定PageCanvas・同じOutputSession・1ページずつのprint・revision/MediaBox検証は維持する。
本文model、ページ分割、保存内容、フォント待ちの失敗時中止は変更しない。

40ページの保存は124.985→15.666秒（約8.0倍、87.5%短縮）、
プレビューを含む操作時間は159.372→23.225秒。
修正後も段落の外箱・wrapperは各窓に残すため、完全なO(n)化ではない。
10→20→40の保存は1.94倍・2.75倍で、残る増加を線形とは断定しない。

### 修正案の優先順位

1. **ページ外の数式DOMを省く（今回実装）**。40ページで約109秒短縮。最も大きい反復DOM処理を減らす。
2. **隠し文書のCSS/FontFaceをセッション内で再利用する**。修正後40ページでも準備3.76秒、CSS取得を含むcapture 1.27秒。再解析を減らせる可能性があるが、font faceの重複・未ロード・CSS更新の扱いを別途検証してから行う。
3. **大きな画像・private assetの出力内キャッシュを別教材で評価する**。今回のPNGは小さく、load待ちは40ページで0.056秒。高解像度写真・大量の異なる画像・remote assetはこの合成教材の範囲外。文書をまたぐキャッシュは導入しない。
4. **単ページPDFの読み込み/結合の重複を減らす**。修正後40ページで検証＋結合は約0.253秒。優先度は低い。ページ数・用紙寸法検証は省略しない。

### 検証と未決事項

- 10/20/40ページすべてでページ数、全MediaBox、ページ固有の日本語見出し、保存後のSigmaDoc content、隠しウィンドウの破棄を確認。
- 修正前後の全70ページをPDF.jsで108dpi rasterizeし、全RGBA値が一致。先頭・中間・末尾は画像としても確認する。
- 単体回帰はページ境界・はみ出す数式・未計測要素・SVG定義・カーソル用separator・元DOM非変更、計測の通常時無効/失敗時の記録を確認。
- Windowsでの実測、巨大写真、異なるTikZ図を大量に持つ教材、p95は未測定。
- 追加の仕様決定は不要。より広い性能保証が必要なら、この未測定の入力とOSを次の計測対象にする。

全ページ比較の再実行例（before/afterへPlaywright結果ディレクトリをそれぞれ退避する）:

```sh
mise exec -- node apps/desktop/scripts/compare-pdf-benchmark.mjs tmp/pdf-perf/before tmp/pdf-perf/after
```

実行済みチェック: `npm run lint`、`npm run typecheck`、全体Vitest
(990 files passed / 13,167 passed、既存skip・expected failあり)、
変更箇所のfocused 46 tests、実ElectronのB4縦横3段組×100/125/150%・連続本文・
9/18pt数式のwarm/cold delayed fonts計11ケース、合成教材3ケース。

画像確認では、合成教材の手動改ページと問題番号の組合せで、次問の番号枠が前ページ下端に
現れる例も見つかった。これは修正前のPDFにも同じ位置にあり、70ページのpixel一致で
今回の差分によるものではないと確認した。番号の配置の別件調査はこのPRに含めない。
