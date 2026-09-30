---
name: sigma-table-editing
description: "教材に表や増減表を挿入・更新するときに使う。対応表、集計表、値の一覧、関数の増減表の作成と、既存の表のセル単位の修正が対象。"
---

# 表・増減表を挿入・更新する

表は本文ブロックではなく、紙面上の `tableShape`（別レイヤー）として入る。本文の中でタブや空白、Markdown、LaTeXの `array` を並べて表に見せない。

| したいこと | tool |
| --- | --- |
| 新しい表 | `insert_table`（`kind` は plain か variation） |
| 既存の表の修正 | `update_table` |
| 表の削除 | `delete_shapes` |

**既存の表は作り直さない。** `delete_shapes` → `insert_table` は列幅・行の高さ・スタイルを失う。直すのは `update_table`。

## 通常の表（kind が plain）

- `cells` に二次元配列（行の配列の配列）で渡す。最大24行×12列。セルの中身は次のどれか。
  - 文字列・数値・null（空欄）
  - `{"text":"…","tex":"…","rowSpan":2,"colSpan":1,"style":{…}}`。数式のセルは `tex`（`$` を付けない）。結合は `rowSpan` / `colSpan`。
- 行ごとの高さや列幅を指定するなら `rows`（`height`、`cells`）と `columns`（`width`）。幅・高さは `auto` / `fixed` / `fr` のどれか。指定しなければ自動。
- 見出し行・見出し列は、`defaultCellStyle`（`fontWeight:"bold"`、`backgroundColor`）や個別セルの `style` で示す。教材の既定は白黒。強い色を付けない。
- 罫線は `grid`（`borderStyle` は solid / dashed / dotted / double、`borderColor`、`borderWidth`、`showOuterBorder`、`showInnerBorders`）。
- 配置は `targetId`（そのブロックの直下）。問題の中は `targetId` を problem のIDにして `area`。ホワイトボードは `targetId` を `CANVAS` にして `x` / `y`。表は本文に回り込まないので、直下の本文と重ならないか preview で見る。

## 増減表（kind が variation）

関数を調べたうえで、意味のある値を左から右の順に渡す。線分や `array` で組まない。

- `criticalPoints`: 有限の臨界点（n個）
- `intervalSigns`: 各区間の導関数の符号（**n+1個**）
- `trends`: 各区間の増減（`up` / `down` / `flat`、n+1個）
- `criticalValues`: 各臨界点での関数値（n個）
- `leftEndpoint` / `rightEndpoint`: 定義域の左右端。そこでの値や極限は `endpointValues:[左, 右]`
- 見出しの名前を変えるときだけ `variableLabel` / `derivativeLabel` / `functionLabel`
- 数式の値はTeX文字列（`-\infty`、`\frac{1}{2}` など。`$` は付けない）

例: f(x) = x² − 1（臨界点 x = 0、極小値 −1）

```json
{
  "kind": "variation",
  "leftEndpoint": "-\\infty",
  "rightEndpoint": "\\infty",
  "criticalPoints": ["0"],
  "intervalSigns": ["-", "+"],
  "trends": ["down", "up"],
  "criticalValues": ["-1"],
  "endpointValues": ["\\infty", "\\infty"]
}
```

## 更新（update_table）

- 1セルだけなら `cellPatches`（`row` / `col` は0始まり、`content` は必須。空にするなら null か空文字を明示）。他のセル・列幅・行高さ・罫線・スタイルは一切変わらない。
- `cells` `rows` `columns` で内容を組み替えても、明示しなかった列幅・行高さ・`grid`・`defaultCellStyle` は既存の表から引き継がれる。
- `w` / `h` だけを渡すと、内容を保ったままサイズだけが変わる。
- 位置・anchor・shapeId は保たれる。

## 確認

`verification.preview` を見て、次を確かめる。

- 行と列の対応、結合セル、空欄の位置。
- 増減表なら、臨界点の順序、符号と矢印の向き、極値、定義域の端点が、元の関数と数学的に一致するか。
- 文字が枠からはみ出していない、表が本文や図と重なっていない。

数値や結果は、書いたあとにもう一度自分で計算して照らす。previewが得られないときは、確認できていないと報告する。
