# 性能予算と計測

「機能を足しても軽い」を人の記憶ではなく機械で守るための取り決め。
数値は `apps/desktop/perf-budget.json`、計測は `npm run perf:probe`。

## 使い方

```bash
cd apps/desktop
npm run perf:probe                    # 本番ビルド → 計測 → 予算 assert（既定で有効）
npm run perf:probe -- --no-build      # 直前の計測ビルドを使い回す
npm run perf:probe -- --fixture body  # フィクスチャを絞る
npm run perf:probe -- --report-only   # 予算 assert を外して数値だけ見る
```

- **所要時間**: ビルド込みで 10〜20 分（`--no-build` なら 3〜5 分）。
  このため `npm run test:e2e` の既定には**含めない**（`SIGMA_PERF_PROBE` gate を維持）。
- 出力は `apps/desktop/perf-reports/<timestamp>/` に 4 フィクスチャ分の
  `<name>.json` / `<name>.summary.md` と、それらを束ねた `summary.md`。
  `summary.md` の先頭に **予算 assert の有効/無効と計測したビルドの revision** が入る。
- 予算違反があると **exit 1**。`SIGMA_PERF_REPORT_ONLY=1`（または `--report-only`）でだけ外れる。

## 予算（2026-08 時点）

**計測されるフィクスチャは 4 つ**: `body-150` / `body-600` / `body`（本文型のサイズ違い）と
`problem`（問題型）。予算は「既定値 + フィクスチャ別の上書き」で、`problem` だけ打鍵コストの
水準が違うので上書きしている。1 つの緩い予算を全部に当てると、重い方に合わせた値が
軽い方の退行を見逃す（本文型は processing 2.5〜3.7ms なので、問題型に合わせた 16 では
4 倍の退行が素通りする）。

基準は現在の統合ブランチの本番ビルドを **フィクスチャごとに 6〜11 回**実行した観測最大値。
方針は **「0 でなければならない系は厳格、ms 系は実測の 1.5〜2 倍、duration 系は観測最大値の 1 段上」**。

### 既定値（`body-150` / `body-600` / `body`）

| 指標 | 予算 | 観測最大 | 根拠 |
| --- | ---: | ---: | --- |
| `idle.reactRenders` / `recomputes` / `longTasks` | 0 | 0 | 厳格 |
| `typing.longTasksPerChar` | 0 | 0.125※ | 厳格（※下記「既知の揺れ」） |
| `typing.inputDurationP50Ms` | 40 | 32 | 8ms 量子化の 1 段上 |
| `typing.inputProcP50Ms` | 8 | 3.7 | 約 2.2 倍 |
| `typing.pageScaleRatio` | 3 | 2.06 | 約 1.5 倍 |
| `enter.keydownDurationMs` | 50 | 32 | 約 1.6 倍 |
| `enter.unchangedMathRemounts` | 1 | 1 | 下記 |
| `arrow.keydownDurationMs` | 24 | 16 | 1 段上 |
| `scroll.frameP90Ms` | 20 | 10.3 | 約 1.9 倍 |
| `save.rendererLongTasks` | 0 | 0 | 厳格 |
| `save.rendererMainThreadMs` | 1 | 0.1 | 約 10 倍（実測がほぼ 0 なので比では決めない） |
| `pagination.oscillations` | 0 | 0 | 厳格 |
| `pagination.idleRecomputes` | 0 | 0 | **`problem` でのみ評価**（本文型は `idle.recomputes` と二重計上になるため skip） |

### `problem` の上書き

| 指標 | 予算 | 観測最大 | 根拠 |
| --- | ---: | ---: | --- |
| `typing.inputDurationP50Ms` | 32 | 24 | 1 段上 |
| `typing.inputProcP50Ms` | 16 | 9.1 | 約 1.8 倍 |
| `typing.pageScaleRatio` | 12 | 7.5 | 約 1.6 倍 |
| `enter.unchangedMathRemounts` | 0 | 0 | 問題型は 1 件も出ないので厳格にできる |

### 個別の注記

- **`enter.unchangedMathRemounts`**: このフェーズで作られた数式ノードビューの**生の数**で、
  引き算はしていない。Enter が作るのは段落なので、本文型で観測される 1 は
  「編集したユニットが作り直されて巻き込まれた既存の数式 1 件」。
  **文書サイズに比例しない**（120 ノードでも 1200 ノードでも 1）ので 1 を許容にしてある。
  打鍵ごとの退行が戻れば 4 件以上になる（この指標の歴史的な最悪値は 196）。
- **`typing.pageScaleRatio`** は「文書の下へ行くほど打鍵が重くなる」を見る指標だが、
  **`inputProcP50Ms` に先を越されやすい**（比が発火するには「最遅位置が proc 予算以下、かつ
  最速位置の N 倍超」が同時に要る）。本文型では独立に発火しうる値にしてあるが、
  問題型では実質 `inputProcP50Ms` が位置スケーリングの門になっている。
- **`arrow.keydownDurationMs`** は観測件数が少ない（n=0〜10）。**1 件も報告が無い実行では
  自動的に通る**（16ms 未満は Event Timing に出ないため「速かった」と解釈する）。
  実質「矢印キーの中央値が 32ms に達したら落とす」という粗い門。

**開く時間（`open.msToBlocks` / `open.msToSettled`）は予算に入れない（report のみ）。**
目標 1.5s / 3.0s に対し現状は約 1.0s / 3.3s で `settled` が未達。支配項は
「数式ノードビューが 1 つあたり 2 回構築されている」ことで、エディタのライフサイクル変更が要る。
届いていない数値を予算にすると門が最初から赤になり、結局誰かが門を切る。

## 計測の作法（ここを外すと数字が嘘になる）

1. **本番ビルドで測る。** `next dev` は React の development ビルドで、打鍵コストが数倍に膨らむ。
   ランナーは `next build` の出力を配信する。`assertPerfInstrumentedBuild` は
   (a) 計測が有効か、(b) **`NODE_ENV === "production"` のビルドか**、
   (c) 数式ノードビューの計測点が生きているか、の 3 つを確認して違えば落とす。
   (b) が要るのは、development ビルドでは計測が常に有効なので「計測できている」だけでは
   `next dev` を見分けられないため（spec を直接 playwright で叩くと dev サーバが立つ）。
   (c) が要るのは、`enter.unchangedMathRemounts` の「カウンタが無い = 再構築されていない」
   という読み方が、計測点の消滅と区別できないため。
2. **`open` と `save` は desktop runtime を mock して測っている。** つまり **main プロセス側の
   仕事は probe に映らない**。main 側（zod・ファイル書き込み・台帳）の退行は vitest
   （`electron/*.test.ts`）で守る。probe の数字が動かないことは「速くなっていない」証明にならない。
3. **Event Timing の `duration` は 8ms 刻み**でしか観測できない。16 と 24 の差は量子化 1 段で、
   実際の差ではない。duration 系の予算は実測の 1 段上に置く。
4. **比は `processing` で取る。** `pageScaleRatio` に duration を使うと、本文型・問題型が
   そろって 1.50 になる（24 ÷ 16）。これは重さではなく量子化の段差を読んでいる。
   `processingEnd - processingStart` は量子化されない。
5. **`processing` は「16ms 以上の入力」の中でしか観測できない。** 報告 0 件は「速かった」では
   なく「分からない」なので、0 として合格させず skip する。
6. **`measures` はリングバッファ（上限 2000）**。長いフェーズで古い値が押し出されるので、
   件数ではなく時刻で切って読む。**時刻は `Date.now()` 系で揃える** —
   `performance.now()` の値で `at`（`Date.now()`）を切ると常に全件通り、
   フェーズの窓が無効になる（保存フェーズで実際に起きていた）。
7. **カウンタは「増えたときだけ」キーを作る。** レポートの差分は 0 を落とすので、
   キーが無い = 一度も起きていない、と読んでよい。
8. **未計測は 0 にしない。** 計測できなかった指標は skip として報告する。`0` を返すと
   「発火しなかった」と「速かった」が区別できず、予算を素通りして全部合格に見える。

### 既知の揺れ

- `typing.longTasksPerChar: 0` は厳格な予算なので、**計測機が重いと 1 回だけ長タスクを拾って
  赤になる**ことがある（本セッション中、ビルドと probe を連続実行していた状態で 1 度観測。
  同条件で 3 回再実行するとすべて緑）。赤が出たら、まず idle な状態で再実行して再現するかを見る。
  再現するなら本物の退行。
- 数値そのものは計測機の負荷で上下する（`open` は同一コードで 1036〜1642ms の幅を観測）。
  **比較は同一条件の連続実行で行う。**

## レビュー観点（性能を壊しやすい形）

新しいコードを入れるとき、この 6 つは毎回見る。

1. **新しい effect の deps に「毎回変わる参照」を入れていないか。**
   打鍵ごとに identity が変わる関数を deps に入れると、その effect は毎打鍵で貼り直される。
   `document.fonts.ready` のように「解決済み promise の then」を持つ effect だと、
   毎打鍵で全体計測が立つ。ref 越しに呼ぶ。
2. **新しい decoration は plugin state に入れているか。**
   `props.decorations` に積むと文書全体の再走査になる。
3. **新しい DOM 走査はユニット単位か。** 紙面全体に `querySelectorAll` を投げると、
   ページ数に比例した仕事が打鍵ごとに増える。
4. **`PageCanvasEditor` に足す props は安定した identity か。**
   ここは巨大な木の根なので、props が 1 つ揺れると下が全部描き直る。
5. **`document` を受け取る `useMemo` は、打鍵ごとに再計算されると自覚しているか。**
   自覚した上でそれでよいならよい。気付かずに重い計算を置くと打鍵に乗る。
6. **`perf-probe` の数値を PR に貼ったか。** 貼っていない性能主張は「速くなった気がする」と同じ。

### 計測の前に確かめること

- **その経路はいつマウントされるか。** overlay エディタは編集モードでしか mount されず、
  本文打鍵の probe には映らない。「二重計測を消した」つもりでも、そもそも走っていない。
- **その重さはどのプロセスの主スレッドか。** renderer が固まる原因が main にあるとは限らない。
  main と renderer は別プロセスなので、main を別プロセスへ出しても renderer の指標は動かない。
- **減ったものだけでなく増えたものも測る。** マウントを減らす代わりに observer が増えることがある。

## 本セッションの before/after

`main` のベースライン（WI-1 計測）→ 現在。すべて本番ビルドの実測。

| 指標 | before | after |
| --- | ---: | ---: |
| 待機 3 秒の React 描画 | 2,209 | **0** |
| 待機 3 秒のページ割り再計算 | 60Hz で回り続け | **0** |
| 打鍵あたりの長タスク | 22 | **0** |
| 連打 20 文字 | 71 ms/文字 | **9 ms/文字** |
| 打鍵あたり `TextFlowEditor` 描画 | 128 | **2〜5** |
| Enter 4 回の数式ノード再構築 | 196 | **1** |
| 打鍵あたり decoration 全文走査 | 18〜25 | **0** |
| 矢印キーの全文走査 / dispatch | 1,956 / 470 | **0 / 28** |
| 50 ページのページ割り 1 回 | 7.6〜8.2 ms | **3.1〜4.1 ms** |
| Overlay 編集中のドラッグ 30 手: shape view 描画 | 9,940 | **908** |
| 同: マウント中 shape view | 510 | **70** |
| 同: 本文の全件計測 | 25 | **4** |
| 保存 1 回の renderer 主スレッド | 20.4 ms | **≈0 ms** |
| 保存 1 回の main（履歴 60 / 150 revision） | 80.7 / 93.2 ms | **40.2 / 40.6 ms** |
| 文書読み込みの zod | 34.4 ms | **13.9 ms** |
| 同: ブロック単位 `safeParse` | 1,500 | **0** |
| 開く直後の全体計測パス | 4 | **3** |

## 未達・見送り（本セッションの引き継ぎメモと対応）

- **開く時間**（本文型 約 1.0s / settled 3.3s）。支配項は **数式ノードビューの二重構築**
  （`InlineMathNodeView.mount` が 1,200 ノードに対し 2,400）と `lineBoxMeasure` 1,650。
- **WI-12 遅延マウント（静的降格）**: 撤回。改ページ隙間が PM decoration で描かれ、
  DOM から読み戻して収束する設計と衝突する。再挑戦には (1) 静的ユニット側でも同じ契約で
  spacer を描く設計、(2) `.text-flow-shell` 相当の外形、(3) per-block observer の総量計測が前提。
- **`content-visibility`**: DOM 矩形を読む現行のページ割りとは**両立しない**（強制レイアウトと
  intrinsic-size の往復で非収束、recompute 3.5→14〜38ms）。使うには「画面外の幾何を
  state から引くページ割り」への作り替えが要る。
- **WI-15 画像の外出し**（`sigma-asset://`）: ユーザー判断で見送り。web viewer が解決できない・
  素材/テンプレートが fileId を持たず dangling 参照になる・SVG 書き出しが解決できず画像が消える。
- **保存 I/O の utility process 化**: renderer 指標は二重 zod 廃止で達成済み。効くのは 100MB 級。
- **問題型の `PageCanvasEditor.render` 6〜10/文字**と `refreshDispatch` 18/文字。
- **MathLive 変換の idle 先読み**（数式の二重構築と絡むため未着手）。
- **実機 Electron での体感確認**は未実施（headless Chromium は paint / 合成を含まない）。
- **PR CI が無い**ため、この門もローカル実行が唯一のゲート。
