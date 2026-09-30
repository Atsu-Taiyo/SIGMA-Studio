---
name: sigma-shape-editing
description: "個別に動かせる図形・矢印・補助線・吹き出し・文字注記（TeX数式つき）を挿入・更新・整列するとき、SVG図やグラフの上に数式ラベルを重ねるとき、既存の図形やSVG画像の位置・大きさを直すときに使う。"
---

# 図形・矢印・注記を編集する

図や絵そのものは `insert_svg_image`（sigma-svg-figure）で入れる。この skill は、**部品を後から個別に動かしたい**と頼まれた図、そして図の上に重ねる文字注記や強調の線、さらに既存図形の修正のためのもの。

## 選び方

| したいこと | tool |
| --- | --- |
| 部品ごとに編集できる図（ユーザーがそう求めたとき） | `insert_shape` を部品の数だけ |
| 図や本文の上に数式・文字の注記を置く | `insert_shape`（kind は text） |
| 本文の一部を囲む・強調する、手順の向きを示す | `insert_shape`（rectangle / highlight / arrow） |
| 吹き出し | `insert_shape`（kind は callout） |
| 既存の図形・SVG画像の位置・大きさ・色・文字 | `update_shape` |
| 2つ以上の図形をそろえる・等間隔にする | `align_shapes` |
| 図形の削除 | `delete_shapes`（本文ブロックは `organize_blocks`） |

グラフは `update_graph`、表は `update_table`、SVGの絵の中身は `update_svg_image`。`update_shape` では変えられない。

## 挿入（insert_shape）

- `kind`: rectangle / circle / ellipse / triangle / diamond / pentagon / blockArrow / arc / sector / arrow / line / polyline / curve / freehand / highlight / text / callout。**標準の kind で表せる形は、その kind を使う。** 円や円弧を多数点の polyline で近似しない。polyline は折れ線であること自体に意味があるときだけ。
- 位置は、意味で言える場合は `placement`（`anchorBlockId` と below / above / rightOf / leftOf）を優先する。絶対座標の `x` / `y` はページ左上基準で、`get_insertion_candidates` の rect か `get_document_outline` の `blockRects` / `overlayShapes` を基準にする。`placement` と `x` / `y` は同時に指定できない。省略すると、アンカーブロックの24px下。
- circle / arc / sector の `x` `y` は**円全体の外接矩形の左上**（中心は `x+r`, `y+r`）。arc / sector の角度は 0°が右で、画面上の時計回り（上半円は180→360）。
- 文字注記は kind が text。折り返し幅 `w` だけを決め、高さは内容から決まる（`h` は指定できない）。数式は `tex`（`$` なし、例 `\angle ABC=60^\circ`）、文章は `text`、複数段落・リスト混在は `markdown`。
- 吹き出しは kind が callout。本文と口を1つの図形にする。口は `tailBaseStart` / `tailBaseEnd` / `tailTip`、角丸は `cornerRadius`。text を重ねたりグループ化したりしない。
- 線・矢印は `points` か `start` / `end`。端の形は `arrowheadStart` / `arrowheadEnd`。
- 配色は白黒基調（線 `#111111`、補助は `#6b7280` か `dash` の dashed / dotted）。色はユーザーが求めたときだけ。
- 説明文・問題文・解答は、図形の文字ではなく本文（`insert_content`）に書く。図形の文字は、図に付く短いラベルと注記だけ。

## SVG図・グラフの上に数式ラベルを重ねる

SVG内の `<text>` はTeXを解釈しない。分数や添字の多いラベルは、図の上に text 図形で置く。

1. 図の画像の位置と大きさ（`x` `y` `w` `h`）を `get_document_outline` の `overlayShapes` で確認する。
2. ラベルを置きたい点のSVG内座標 (px, py) を、viewBox の幅 VW から換算する: 絶対x = 画像x + px × (w ÷ VW)、絶対y = 画像y + py × (h ÷ VH)。
3. その付近へ kind が text、`tex` に式の `insert_shape` を置き、previewで線やラベルと重ならないことを確認する。

画像を `update_shape` で動かしたり拡大縮小したりしても、重ねたラベルは追従しない。動かしたあとは、ラベルも `update_shape` で置き直す。

## 更新・整列・削除

- 既存図形は**作り直さない**。`delete_shapes` → `insert_shape` は位置・サイズ・スタイルが初期化される。`update_shape` で位置・回転・色・線・大きさ、text の `text` / `tex` / `fontSize`、`points`（line の点列。1点だけ動かすときも全点を渡す）、`start` / `end`（arrow の端点）を直接変える。
- `points` `start` `end` は insert と同じ絶対座標で、現在位置からの相対ではない。
- SVG画像の大きさは `w` と `h` の比を元のまま保つ。比を変えると絵の中央だけが切り取られる。
- 文字のフォントを変えるのは `edit_text` の `format_inline`（`target` は `shape` と `shapeId`、または `overlaySelection`）。`update_shape` の `fontSize` は文字サイズ(pt)。
- 選択中の図形が対象のときは `get_edit_context` の `context.selection.shapeIds` / `shapes`。
- IDは `get_document_outline` の `overlayShapes` か `search_document` で確認する。

## 元画像そっくりに再現するとき

参照図への忠実な再現を求められ、部品ごとの編集も必要なときだけ、visual edit session を使う: `begin_visual_edit_session`（`sourceAnalysis` と `plannedShapes`）→ `visual_insert_shape` / `visual_replace_shape` / `visual_remove_shape` → `render_visual_edit_session` → `inspect_visual_edit_session` → `review_visual_edit_session` → `propose_visual_edit_session`。renderのpreviewを元画像と見比べ、直して繰り返す。輪郭のトレースはしない。それ以外の再現は SVG（sigma-image-material-reconstruction）。

## 確認

`verification.preview` で、種類・位置関係・ラベル・矢印の向き・重なり・はみ出しを確認する。previewが得られないときは `render_block_context` で見て、確認できていなければそう報告する。
