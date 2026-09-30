---
name: sigma-graph-editing
description: "Sigma Studio教材で関数グラフ、座標平面、数直線、不等式の領域図を挿入・更新し、軸・曲線・点・ラベルまで検証するときに使う。座標で値や関係を読ませる図が対象。"
---

# グラフを挿入・更新する

座標系そのものが意味を持つ図（関数のグラフ、座標平面、数直線、方程式・不等式の領域）だけを Graph2D として作る。三角形・円・矢印・模式図・イラストはグラフにせず、`insert_svg_image`（sigma-svg-figure）で描く。立体・回転体・断面は `insert_graph3d`（sigma-graph3d-editing）。

## tool の選び方

- 新しいグラフは `insert_graph`。既存のグラフは作り直さず `update_graph` で必要な項目だけを変える（位置・サイズ・既存スタイルが保たれる）。`delete_shapes` してから作り直すと失われる。
- 問題の解答エリアなどへ置くときは `targetId` を problem のIDにして `area` を指定する。ホワイトボードは `targetId` を `CANVAS` にして `x` / `y` を渡す。
- 概念図としての放物線（座標も式も読ませない）は SVG のほうがよい。

## 組み立て

1. **範囲**: `viewBox`（`xMin` `xMax` `yMin` `yMax`）は文字列で渡す。`pi`、`sqrt(2)`、`1/2`、`-2*pi` のような式も書ける。曲線・点・領域が余白つきで収まる最小の範囲にする。広げすぎると図が小さく見える。
2. **大きさ**: `w` / `h` は軸や曲線が描かれるプロット範囲(px)。目盛り文字などの余白は含まない。紙面に収まる 300〜400px 程度から始める。
3. **軸**: `axes` は通常 `grid:false` `showTicks:false` `showX:true` `showY:true`。グリッドと目盛りは、ユーザーが「方眼」「目盛り」を求めたときだけ true にする。数直線（`kind` を numberLine）は `showY:false`。文脈が s-t 座標などなら `xLabel` / `yLabel` を変える。原点ラベルが要るときだけ `originLabel`（`\mathrm{O}` など）。目盛りを出すなら `xTickStep` / `yTickStep` を範囲に対して多すぎない刻みにし、三角関数では `xTickMode` を pi にする。
4. **曲線**: `curves` に入れる。`expr` は TeX ではなく評価用の式（`x^2 - 5*x + 6`、`(1 - x^2)/2`、`sin(x)`。掛け算は `*`）。`label` は表示用で `y = x^2 - 5x + 6` のように書ける。`mode` は次から選ぶ。
   - `yOfX`: y=f(x)。縦向きの放物線など
   - `xOfY`: x=f(y)。横向きの放物線、境界 x=f(y)
   - `parametric`: 円・リサージュなど。`expr` が x(t)、`yExpr` が y(t)。`domain` は t の範囲
   - `implicit`: F(x,y)=0 の形。`expr` に左辺−右辺（`x^2 - 4*x + y^2 - 22`）、`label` に元の等式
   曲線の一部だけを描くときは `domain:{min,max}`。閉領域の境界は、必要な区間ごとに曲線を分け、IDを付ける。
5. **点・注釈・塗り**: 特別な座標は `points`（`x` `y` は文字列、`label`、必要なら `labelPlacement` を n/ne/e/se/s/sw/w/nw から）。文字の説明は `annotations`。閉領域は `fills`。fill の `x` / `y` は**境界上ではなく領域の内部の点**にし、境界を曲線IDで並べない。解決できないときは境界曲線の `domain`・`viewBox`・`xOfY`/`yOfX` の向きを見直す。
6. **ラベルはグラフ所有**: 軸名・原点・点ラベル・注釈・曲線式ラベルは、tool が動かせる text として作る。別の `insert_shape` に分解しない。ラベル用 text の `w` / `h` も指定しない（自動採寸）。式ラベルは、複数曲線を区別する必要があるときだけ `showFormulaLabels:true`。
7. **配色**: 白黒基調。主曲線は `#0d0d0d` の実線（`strokeWidth` 2.2〜2.4）、補助線・第2曲線は `#6b7280` か `dash` の dashed / dotted で区別する。塗りは `#d1d5db`、`opacity` 0.45〜0.6。色は、ユーザーが求めたときだけ使う。
8. **IDと重複**: curve・point・fill のIDは既存と重ならないよう `ai_curve_1` `ai_point_1` `ai_fill_1` のように付ける。

## 例

放物線 y = x² − 5x + 6 と x 軸との交点。

```json
{
  "id": "ai_graph_1",
  "kind": "cartesian",
  "w": 340,
  "h": 260,
  "viewBox": { "xMin": "-1", "xMax": "6", "yMin": "-1", "yMax": "7" },
  "axes": { "grid": false, "showX": true, "showY": true, "showTicks": false, "xLabel": "x", "yLabel": "y", "originLabel": "\\mathrm{O}" },
  "curves": [
    { "id": "ai_curve_1", "expr": "x^2 - 5*x + 6", "label": "y = x^2 - 5x + 6", "mode": "yOfX", "color": "#0d0d0d", "strokeWidth": 2.2 }
  ],
  "points": [
    { "id": "ai_point_1", "x": "2", "y": "0", "label": "2", "labelPlacement": "s" },
    { "id": "ai_point_2", "x": "3", "y": "0", "label": "3", "labelPlacement": "s" }
  ]
}
```

これに `targetId` `fileId` `runId` `expectedRevision` を添えて `insert_graph` へ渡す。

## 確認と修正

`insert_graph` / `update_graph` が返す `verification.preview` を実際に見る。足りなければ `render_block_context` で周辺の紙面も見る。

- 曲線の形、定義域、交点、極値、塗り領域は数学的に正しいか。
- x軸・y軸・原点・目盛りは意図どおりか。
- 軸ラベル・点ラベル・注釈・式ラベルが、曲線や互いに重なっていないか。
- グラフが小さすぎないか。紙面やshapeの範囲からはみ出していないか。
- 頼まれていないグリッド・目盛り・装飾・色が入っていないか。

問題があれば `update_graph` で範囲・軸・曲線・点・注釈を直し、previewを見直してから完了する。previewが得られないときは、確認できていないと報告する。
