# Box shape rendering

このメモは、TeX 風の箱コマンドを SigmaDoc の `boxBlock` として挿入したとき、どの box shape として描画されるかを整理する。

ここでいう box shape は overlay canvas の `OverlayShape` ではない。本文フロー内の `boxBlock.frame: BoxFrameSpec` と `BoxDecorationSpec` を正本にして、編集画面と印刷画面が同じ CSS 変数から描画する。

実装上の正本は次。

- `src/types/sigma-doc.ts`: `BoxBlockNode`、`BoxFrameSpec`、`BoxDecorationSpec`
- `src/lib/sigma-doc-schema.ts`: 読み込み検証
- `src/lib/box-blocks.ts`: built-in style、`createBoxBlock`、CSS変数/data属性への変換
- `src/components/editor/TextFlowEditor.tsx`: 編集画面の本文フロー描画
- `src/components/print/PrintPreview.tsx`: 印刷プレビュー描画

## 基本方針

- `/itembox` や `/tcolorbox` などの単純な箱は、素材の overlay 図形として挿入しない。
- 挿入される実体は `type: "boxBlock"` の SigmaDoc ブロック。
- 箱の本文は `blocks: BoxBlockChildBlock[]` に入る。通常の paragraph、heading、list に加え、入れ子 `boxBlock` や箱内 `layoutSection` も保持できる。
- 箱内 `layoutSection` の複数段では手動改段を使える。箱直下の子の手動改ページ (`pagination.break`) は、その子の前で箱を分割して次のページ (段組みのページでは次の段) へ続ける (TeX の breakable な箱の `\newpage` と同じ)。長い箱のページ・外側段への継続は自動分割でも処理する。
- 箱の見た目は `styleId` と `frame` で決まる。
- `frame.decorations` は、CSS だけで安全に再現できる装飾を表す。TeX や TikZ を任意実行しない。

## 描画パイプライン

1. Slash command で `/tcolorbox` などを選ぶ。
2. `createBoxBlock(styleId)` が `boxBlock` を作る。
3. `TextFlowEditor` が `boxBlock.frame` を CSS 変数と `data-box-*` 属性に変換する。
4. `globals.css` が `data-box-title-band` や `data-box-left-bar` を見て描画する。
5. `PrintPreview` も同じ `BoxFrameSpec` から CSS 変数を作る。

## Built-in box styles

| Command | styleId | box shape | 主な描画仕様 |
|---|---|---|---|
| `/fancybox` | `fancybox` | 一重枠 | `borderWidthPx`, `borderColor`, `paddingPx`。`framed`, `fbox`, `framebox` は検索 alias。 |
| `/itembox` | `itembox` | 見出しプレート付き枠 | `titlePlate` decoration。既定タイトルは `ポイント`。 |
| `/splitbox` | `splitbox` | 見出しが 2 欄に割れる箱 | `titleBand` + `titleSplit` decoration。サブタイトル欄 (既定 `Point`、濃い地に白抜き) とタイトル欄 (既定 `解法`、灰色の帯) が 1 本の帯に並ぶ。欄の幅の比・間隔・左右の順・サブタイトルの位置は自由。参考書の解法・要点枠向け。 |
| `/tcolorbox` | `tcolorbox` | タイトル帯付き枠 | `titleBand` decoration。既定タイトルは `定理`。 |
| `/tcolorbox-note` | `tcolorbox-note` | ノート罫付き枠 | `notebookRules` decoration。左リング、縦綴じ罫、横罫をCSSで描く。`/ノート` でも検索できる。 |
| `/doublebox` | `doublebox` | 二重罫枠 | `doubleRule` decoration。外枠は通常 border、内枠は inset border。 |
| `/shadebox` | `shadebox` | 薄い地色の枠 | `backgroundColor` と角丸。補足やコラム向け。 |
| `/leftbar` | `leftbar` | 左罫付き枠 | `leftBar` decoration。背景は薄く、左だけ太い罫線。 |
| `/dashedbox` | `dashedbox` | 破線枠 | `borderStyle: "dashed"`。記入欄やメモ向け。 |
| `/ruledbox` | `ruledbox` | 上下罫だけの箱 | `horizontalRules` decoration。左右罫は持たない。 |
| `/screenbox` | `screenbox` | 影付きカード | `shadow` decoration。例題や問題カード向け。 |
| `/ovalbox` | `ovalbox` | 角丸枠 | `cornerStyle: "round"` と `radiusPx: 18`。 |
| `/cornerbox` | `cornerbox` | 四隅の黒四角と二重ガイド罫 | 画像の `cornerbox` コマンド相当。`titleDoubleRule` と `cornerSquares` decoration を組み合わせる。 |

## Decoration mapping

| Decoration | CSS/data attribute | 用途 |
|---|---|---|
| `doubleRule` | `data-box-double-rule` | 箱の内側にもう一本の罫線を描く。 |
| `titleBand` | `data-box-title-band` | タイトル行を横幅いっぱいの帯として描く。 |
| `titleSplit` | `data-box-title-split` | 帯を 2 欄 (サブタイトルとタイトル) に割る。編集面は内容の `div`、印刷は箱そのものが grid になり、幅の比・隙間・左右は CSS 変数 (`--sigma-doc-box-split-*`) で決まる。 |
| `titlePlate` | `data-box-title-plate` | タイトルだけを小さなラベル板として描く。 |
| `leftBar` | `data-box-left-bar` | 左側に太いアクセント罫を描く。 |
| `shadow` | `data-box-shadow` | `box-shadow` でカード風の影を描く。 |
| `horizontalRules` | `data-box-horizontal-rules` | 上下罫だけを描く。 |
| `notebookRules` | `data-box-notebook-rules` | ノート罫、左綴じ罫、リングを描く。 |
| `titleDoubleRule` | `data-box-title-double-rule` | `cornerbox` 用の黒罫とガイド罫を背景 gradient で描く。 |
| `cornerSquares` | `data-box-corner-squares` | 四隅の黒四角を absolute 要素で描く。 |

## 素材として残すもの

単純な箱とノート罫は `boxBlock` に寄せる。一方で、タイトル扉のように複数のテキスト領域や細かい図形を含むものは、現時点では「複合素材」として扱う。

これらは純粋な箱というより、教材テンプレートに近い。将来 `boxBlock` に複数スロットや内部ラベルを持たせる設計を入れるまでは、overlay 付き素材のまま分けておく。

## 2 欄の見出し (`titleSplit`)

`boxBlock.subtitle` は `titleSplit` を持つ枠だけが描く 2 つ目のタイトル。中身はタイトルと同じインライン (数式も入る)。

- **保存**: `subtitle?: InlineNode[]` と、枠の `decorations` の `titleSplit` (`subtitleShare` 0.05〜0.95 / `gapPx` / `order: "subtitleFirst" | "titleFirst"` / `subtitleBackgroundColor` / `subtitleColor` / `subtitleAlign`)。
- **編集面**: Tiptap の `boxBlock` は `boxBlockTitle boxBlockSubtitle? boxBlockBody`。サブタイトル欄の有無は枠の装飾に従い、設定ダイアログでスタイルを替えると欄を足す/消す (`syncBoxSubtitleNode`)。
- **幅の変更**: 段組みの列と同じく、境界のつまみ (`box-split-handle.ts`) をドラッグする。離したときに 1 回だけ `subtitleShare` を書き込む。設定ダイアログの数値・並び順・隙間からも変えられる。
- **印刷・ビューア**: `print-box-title` と `print-box-title print-box-subtitle` の 2 つを出す。どちらも空なら帯ごと出さない。
