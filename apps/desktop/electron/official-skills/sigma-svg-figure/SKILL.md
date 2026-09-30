---
name: sigma-svg-figure
description: "図・図解・模式図・イラスト・挿絵・フローチャート・幾何の作図・物理や化学の図を、静的SVG1枚として教材へ挿入・修正するときに使う。画像や図が必要になったら最初に検討する。"
---

# 図・イラストはSVGで入れる

図・図解・イラスト・挿絵が要るときは、迷わず `insert_svg_image` で自己完結したSVGを1枚入れる。AIが教材へ入れられる絵はSVGなので、「画像を入れて」「図解して」「絵を描いて」にもこの入口で応える。関数グラフ・表・立体のように専用の入口がある図だけ、そちらを使う。

## 入口の選び方

| 入れたいもの | 使うtool |
| --- | --- |
| 図解、模式図、イラスト、挿絵、幾何の作図、力や光の図、回路・化学・生物の図、フローチャート、年表、関係図 | `insert_svg_image`（このskill） |
| 関数のグラフ、座標平面、数直線、不等式の領域 | `insert_graph`（sigma-graph-editing） |
| 立体、回転体、断面 | `insert_graph3d`（sigma-graph3d-editing） |
| 表、増減表 | `insert_table`（sigma-table-editing） |
| 部品ごとに動かして編集したいと頼まれた図、独立した文字注記 | `insert_shape`（sigma-shape-editing） |

「個別に編集できる図形のほうがよいのでは」と先回りして `insert_shape` を選ばない。ユーザーが部品単位の編集を求めたときだけ切り替える。三角形1つに頂点ラベルを付けるだけの図も、SVG1枚で足りる。

## 手順

1. 何を伝える図かを一文で決める。前後の本文・問題文・条件（長さ、角度、ラベル）を `get_edit_context` で読む。画像が添付されていれば `get_attached_media` で元画像を見る。
2. 置き場所を決める。`targetId` はそのブロックの直下。問題の中なら `targetId` を problem のIDにして `area`（prompt / solution / hints / lead）を指定する。余白へ置くなら `x` / `y`（ページ左上基準の絶対座標）。ホワイトボードは `targetId` を `CANVAS` にする。
3. 下の規約でSVGを書く。`name` に図の内容を短く付ける。
4. `insert_svg_image` を呼ぶ。`w` は表示幅(px)。省略すると viewBox 幅と480の小さいほうになる。`w` か `h` の片方だけなら縦横比は保たれる。
5. 返った `verification.preview` のPNGを実際に見る。文字の欠け・はみ出し・線の重なり・本文との干渉を確認する。previewが無いときは `render_block_context` か `render_page` で確認する。確認できていないものを「確認済み」と報告しない。
6. 直すときは `update_svg_image`（SVG原文だけを差し替え、位置・サイズ・回転は保たれる）。位置と大きさは `update_shape` の `x` `y` `w` `h` で変える。**`w` と `h` の比は viewBox に合わせる。比が違うと絵の中央だけが切り取られて表示される。**
7. 既存のSVG画像を直すときは、`read_local_document`（detail は full）で画像assetの原文を読み、必要な所だけ変えて `update_svg_image` に渡す。作り直さない。

SVGは本文と独立した画像レイヤーで、本文は回り込まない。直下に本文が続くと重なるので、previewで確認して `update_shape` で動かすか、空いた場所へ置く。

## SVGの規約（この形だけが通る）

- ルートは `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 幅 高さ">` の1つ。`xmlns` と正の `viewBox` は必須。XML宣言・DOCTYPE・コメント・CDATAは置かない。
- 使える要素: `svg` `g` `defs` `title` `desc` `path` `rect` `circle` `ellipse` `line` `polyline` `polygon` `text` `tspan` `clipPath` `mask` `marker` `linearGradient` `radialGradient` `stop`。
- 使えない: `style` `script` `image` `use` `foreignObject` `pattern` `filter`、アニメーション、`class`、外部URL、data URL。色も線もすべて `fill` `stroke` などの**属性**で書く。`url(#id)` は同じSVG内の defs への参照だけ。
- 上限は 256 KiB・要素4096個・入れ子64段。幅・高さは各辺 8192px 以下。
- 矢印は defs に `marker` を定義して `marker-end="url(#arrow)"` で付ける（下の例）。
- 背景は透明のままにする。白い全面の `rect` は置かない。
- 配色は白黒基調。線は `#111111`、補助線は `#6b7280` か破線（`stroke-dasharray`）、面は `#f1f1f1`〜`#d1d5db`。色は、ユーザーが求めたとき、または区別に必要なときだけ最小限に使う。
- 線の太さは 1.5〜2。文字は本文に近い大きさにする（表示幅400pxなら `font-size` 13〜15）。
- 文字は `<text>` で書く。日本語のために `font-family="'Hiragino Sans','Yu Gothic',Meiryo,sans-serif"` を付ける。中央合わせは `text-anchor="middle"`。
- **TeXは解釈されない。** 図中の記号は Unicode（x y θ π √ ² ∠ ° △ ∥ ⊥ など）で書く。分数・積分・添字の多い式は SVG に入れず、図の上に `insert_shape`（kind は text、tex に式）で重ねる。
- 図の大きさの目安: 1段組の本文幅は約660px、2段組の1段は約320px。`w` は 240〜480 から始める。
- ルートに `aria-label` で図の内容を短く書く。

## 描き方のコツ

- 先に座標を決める。主要な点を A(40,180) B(280,180) C(40,40) のように並べ、辺・ラベル・寸法の位置をそこから導く。目分量で描かない。
- 数値条件は図に反映する。「AB=5cm」「∠A=60°」なら、条件に合うように座標を計算する。三角比や円周上の点は式で求める。
- 円・楕円は `circle` / `ellipse`、円弧は `path` の `A` コマンドで描く。多数点の `polyline` で近似しない。
- ラベルは図形から 6〜10 離し、線や別ラベルと重ねない。頂点ラベルは外側へ置く。
- 直角記号・等長の印・平行の印・寸法線は、教材の意図に必要なものだけ。
- 複雑な図は `g` でまとまりごとに分け、`id` を付けておくと後の修正が楽になる。
- 写真のような絵は SVG では再現できない。単純化した線画で描き、その旨を報告する。

## 例

直角三角形ABC。

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 220" aria-label="直角三角形ABC">
  <polygon points="40,180 280,180 40,40" fill="none" stroke="#111111" stroke-width="2" stroke-linejoin="round"/>
  <polyline points="40,160 60,160 60,180" fill="none" stroke="#111111" stroke-width="1.5"/>
  <g font-family="'Hiragino Sans','Yu Gothic',Meiryo,sans-serif" font-size="15" fill="#111111" text-anchor="middle">
    <text x="26" y="196">A</text>
    <text x="294" y="196">B</text>
    <text x="26" y="36">C</text>
    <text x="160" y="204">4 cm</text>
  </g>
</svg>
```

矢印（marker）でつなぐ流れ図。

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 120" aria-label="実験の手順">
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#111111"/>
    </marker>
  </defs>
  <g fill="none" stroke="#111111" stroke-width="1.5">
    <rect x="10" y="35" width="90" height="50" rx="6"/>
    <rect x="135" y="35" width="90" height="50" rx="6"/>
    <rect x="260" y="35" width="90" height="50" rx="6"/>
    <line x1="100" y1="60" x2="133" y2="60" marker-end="url(#arrow)"/>
    <line x1="225" y1="60" x2="258" y2="60" marker-end="url(#arrow)"/>
  </g>
  <g font-family="'Hiragino Sans','Yu Gothic',Meiryo,sans-serif" font-size="14" fill="#111111" text-anchor="middle">
    <text x="55" y="65">加熱する</text>
    <text x="180" y="65">冷やす</text>
    <text x="305" y="65">質量を測る</text>
  </g>
</svg>
```

## 完了時の報告

何を描いたか、previewで何を確認したかを短く伝える。SVGは1枚の画像として入るので、部品ごとの編集が必要なら言ってもらえれば図形として作り直せることを一言添える。
