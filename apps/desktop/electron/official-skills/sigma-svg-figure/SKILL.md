---
name: sigma-svg-figure
description: "図・図解・模式図・イラスト・挿絵・フローチャート・幾何の作図・物理や化学の図を、静的SVG1枚として教材へ挿入・修正するときに使う。画像や図が必要になったら最初に検討する。"
---

# 図・イラストはSVGで入れる

図・図解・イラスト・挿絵が要るときは、迷わず `insert_svg_image` で自己完結したSVGを1枚入れる。AIが教材へ入れられる絵はSVGなので、「画像を入れて」「図解して」「絵を描いて」にもこの入口で応える。関数グラフ・表・立体のように専用の入口がある図だけ、そちらを使う。

SVGは `convert_svg_image`（画面の「図形に変換」と同じ変換器）で線・図形・文字・数式に分解できる（グループ解除で部品ごとに動かせる）。部品ごとに編集したい図もSVGで描けば、作り直さずに分解でき、見た目も元のSVGのまま保たれる。だから下の「変換しやすい書き方」で描く。

## 入口の選び方

| 入れたいもの | 使うtool |
| --- | --- |
| 図解、模式図、イラスト、挿絵、幾何の作図、力や光の図、回路・化学・生物の図、フローチャート、年表、関係図 | `insert_svg_image`（このskill） |
| 部品ごとに動かして編集したい図 | `insert_svg_image`（変換しやすい書き方で描く）→ `convert_svg_image` |
| 関数のグラフ、座標平面、数直線、不等式の領域 | `insert_graph`（sigma-graph-editing） |
| 立体、回転体、断面 | `insert_graph3d`（sigma-graph3d-editing） |
| 表、増減表 | `insert_table`（sigma-table-editing） |
| 図や本文に重ねる文字注記（TeX数式）・強調・吹き出し | `insert_shape`（sigma-shape-editing） |

部品ごとに編集したいと頼まれても、`insert_shape` で部品を1つずつ作り直さない。SVGで描いて `convert_svg_image` で分解する。頼まれていない図は分解しない。三角形1つに頂点ラベルを付けるだけの図も、SVG1枚で足りる。

## 手順

1. 何を伝える図かを一文で決める。前後の本文・問題文・条件（長さ、角度、ラベル）を `get_edit_context` で読む。画像が添付されていれば `get_attached_media` で元画像を見る。
2. 置き場所を決める。`targetId` はそのブロックの直下。問題の中なら `targetId` を problem のIDにして `area`（prompt / solution / hints / lead）を指定する。余白へ置くなら `x` / `y`（ページ左上基準の絶対座標）。ホワイトボードは `targetId` を `CANVAS` にする。
3. 下の規約と「変換しやすい書き方」でSVGを書く。`name` に図の内容を短く付ける。
4. `insert_svg_image` を呼ぶ。`w` は表示幅(px)。省略すると viewBox 幅と480の小さいほうになる。`w` か `h` の片方だけなら縦横比は保たれる。
5. 返った `verification.preview` のPNGを実際に見る。文字の欠け・はみ出し・線の重なり・本文との干渉を確認する。previewが無いときは `render_block_context` か `render_page` で確認する。確認できていないものを「確認済み」と報告しない。
6. 直すときは `update_svg_image`（SVG原文だけを差し替え、位置・サイズ・回転は保たれる）。位置と大きさは `update_shape` の `x` `y` `w` `h` で変える。**`w` と `h` の比は viewBox に合わせる。比が違うと絵の中央だけが切り取られて表示される。**
7. 既存のSVG画像を直すときは、`read_local_document`（detail は full）で画像assetの原文を読み、必要な所だけ変えて `update_svg_image` に渡す。作り直さない。
8. 部品ごとに編集したいと頼まれた図は、previewで直し終えてから `convert_svg_image`（`shapeId` はその画像。同じ会話で挿入したばかりの画像でもよい）を呼ぶ。返った `toolResult.data.conversion` で、部品の数（`convertedCount`）、SVGのまま残った部分（`keptAsSvgCount`。0 が理想）、測り方（`measurement`）を確かめ、`verification.preview` で見た目が変わっていないことを見る。残った部分が多いときは、下の書き方に沿って `update_svg_image` で描き直してから変換し直す。

SVGは本文と独立した画像レイヤーで、本文は回り込まない。直下に本文が続くと重なるので、previewで確認して `update_shape` で動かすか、空いた場所へ置く。

## SVGの規約（この形だけが通る）

- ルートは `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 幅 高さ">` の1つ。`xmlns` と正の `viewBox` は必須。XML宣言・DOCTYPE・コメント・CDATAは置かない。
- 使える要素: `svg` `g` `defs` `title` `desc` `path` `rect` `circle` `ellipse` `line` `polyline` `polygon` `text` `tspan` `clipPath` `mask` `marker` `linearGradient` `radialGradient` `stop`。
- 使えない: `style` `script` `image` `use` `foreignObject` `pattern` `filter`、アニメーション、`class`、外部URL、data URL。色も線もすべて `fill` `stroke` などの**属性**で書く。`url(#id)` は同じSVG内の defs への参照だけ。
- 上限は 256 KiB・要素4096個・入れ子64段。幅・高さは各辺 8192px 以下。
- 背景は透明のままにする。白い全面の `rect` は置かない。
- 配色は白黒基調。線は `#111111`、補助線は `#6b7280` か破線（`stroke-dasharray`）、面は `#f1f1f1`〜`#d1d5db`。色は、ユーザーが求めたとき、または区別に必要なときだけ最小限に使う。
- 文字は本文に近い大きさにする（`font-size` 13〜15）。日本語のために `font-family="'Hiragino Sans','Yu Gothic',Meiryo,sans-serif"` を付ける。中央合わせは `text-anchor="middle"`。
- **TeXは解釈されない。** 図中の記号は Unicode（x y θ π √ ² ∠ ° △ ∥ ⊥ など）で書く。分数・積分・添字の多い式は SVG に入れず、図の上に `insert_shape`（kind は text、tex に式）で重ねる。
- 図の大きさの目安: 1段組の本文幅は約660px、2段組の1段は約320px。viewBox の幅を表示したい幅（240〜480）にして、`w` は省略するか同じ値にする。SVGの1単位が紙面の1pxになり、線の太さと文字の大きさがそのまま紙面の値になる。
- ルートに `aria-label` で図の内容を短く書く。

## 変換しやすい書き方（`convert_svg_image` と「図形に変換」で分解される形）

下の形で描いた部分は、アプリの線・図形・文字・数式になる。外れた部分は分解されず、その部分だけSVG画像のまま残る。

- **線の太さ**は、変換するとアプリの区分（極細0.75・細1.25・中2・太3・極太5px）のいちばん近いものになる。`stroke-width` はこの値から選ぶ: 主線は2、補助線・印は1.25、方眼や細かい目盛りは0.75、強調は3。表示倍率（`w` ÷ viewBox の幅）が掛かった太さで決まるので、viewBox の幅と表示幅をそろえておく。`convert_svg_image` は極細を細(1.25)に切り上げる（極細を読めない古い版のアプリがあるため。画面の「図形に変換」は切り上げない）。
- **破線**は `stroke-dasharray`。最初の値が線の太さ以下なら点線、長ければ破線になる（例 `4 3` は破線、`1 3` は点線）。
- **直線・多角形**は `line` `polyline` `polygon` `rect`（角丸は `rx` だけ）`circle` `ellipse`、または直線だけの `path`（`M` `L` `H` `V` `Z`）。線だけのものには `fill="none"` を付ける（省略すると黒塗り扱いになり、開いた線は分解されない）。塗る形は閉じる（`polygon`、`Z` で閉じた path、`rect`・`circle`）。
- **曲線**は1本の `path` に `M…Q…`（2次ベジェ1つ）だけを書く。3次ベジェ（`C` `S`）、`T`、円弧 `A`、Q の連続、曲線と直線の混在、曲線を `Z` で閉じたものは分解されない。長い曲線は Q ごとに別の path に分ける。
- **円弧は `A` で描かず、Q 曲線で近似する。** 中心 (cx, cy)・半径 r・角 a から b（中心角 60° 以下）の弧は、始点 (cx+r·cos a, cy+r·sin a)、終点 (cx+r·cos b, cy+r·sin b)、制御点は中間の角 m=(a+b)/2 の向きに中心から r÷cos((b−a)/2) 離れた点。60° を超える弧は 60° 以下ずつ別の path に分ける。円全体は `circle`、楕円は `ellipse`。
- **矢印**は defs の `marker` に、次のどれか1つの要素だけを入れる: 塗った三角（`M0,0 L10,5 L0,10 z`）、V字（`M0,1 L10,5 L0,9` を `fill="none"` で線にする）、丸（`circle`）。marker の色（三角・丸は `fill`、V字は `stroke`）は、付ける線の `stroke` と同じ値を書く（どちらも `#111111` など）。終点は `marker-end` と `orient="auto"`、始点は `marker-start` と `orient="auto-start-reverse"`。付ける先は `line` `polyline` と1本の線の `path` だけ。`marker-mid`、色違い、要素が2つ以上の marker は分解されない。
- **文字**は `<text>` 1つに1行。`x` `y` は数値1つ。複数行は `<text>` を分ける。色は `fill` で付け、`stroke`・`fill="none"`・`dominant-baseline`・`letter-spacing` は使わない（縦位置は `y` で合わせる）。`tspan` には `x` `y` `dx` `text-anchor` を付けない。**文字を stroke の付いた `g` に入れない**（stroke を受け継いで分解されない）。線の `g` と文字の `g` を分ける。θ のようなギリシャ文字や、斜体（`font-style="italic"`）の1文字の変数は数式になる。
- 使わない: グラデーション（`url(#…)` の塗り）、`clip-path`、`mask`、`g` の `opacity`。`transform` は `translate` `rotate` と縦横同じ倍率の `scale` までにする。

## 描き方のコツ

- 先に座標を決める。主要な点を A(40,180) B(280,180) C(40,40) のように並べ、辺・ラベル・寸法の位置をそこから導く。目分量で描かない。
- 数値条件は図に反映する。「AB=5cm」「∠A=60°」なら、条件に合うように座標を計算する。三角比や円周上の点は式で求める。
- 円・楕円は `circle` / `ellipse`、弧は上の Q 曲線で描く。多数点の `polyline` で近似しない。
- ラベルは図形から 6〜10 離し、線や別ラベルと重ねない。頂点ラベルは外側へ置く。
- 直角記号・等長の印・平行の印・寸法線は、教材の意図に必要なものだけ。
- 複雑な図は `g` でまとまりごとに分け、`id` を付けておくと後の修正が楽になる。
- 写真のような絵は SVG では再現できない。単純化した線画で描き、その旨を報告する。

## 例

直角三角形ABC。

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 220" aria-label="直角三角形ABC">
  <polygon points="40,180 280,180 40,40" fill="none" stroke="#111111" stroke-width="2" stroke-linejoin="round"/>
  <polyline points="40,160 60,160 60,180" fill="none" stroke="#111111" stroke-width="1.25"/>
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
  <g fill="none" stroke="#111111" stroke-width="1.25">
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

斜面の上の物体と重力。角の印は Q 曲線、力はV字の矢印、補助線は破線。

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 220" aria-label="傾き30°の斜面上の物体にはたらく重力">
  <defs>
    <marker id="v" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto">
      <path d="M0,1 L10,5 L0,9" fill="none" stroke="#111111"/>
    </marker>
  </defs>
  <g fill="none" stroke="#111111" stroke-width="2">
    <polygon points="30,200 330,200 330,26.8"/>
    <rect x="-20" y="-28" width="40" height="28" fill="#f1f1f1" transform="translate(190,107.6) rotate(-30)"/>
    <line x1="183" y1="95.5" x2="183" y2="165" marker-end="url(#v)"/>
    <line x1="183" y1="165" x2="183" y2="200" stroke="#6b7280" stroke-width="1.25" stroke-dasharray="4 3"/>
    <path d="M70,200 Q70,189.3 64.6,180" stroke-width="1.25"/>
  </g>
  <g font-family="'Hiragino Sans','Yu Gothic',Meiryo,sans-serif" font-size="15" fill="#111111">
    <text x="80" y="195">θ</text>
    <text x="192" y="160">重力</text>
  </g>
</svg>
```

## 変換した後の直し方

`convert_svg_image` や「図形に変換」で変換した図は、図形・文字のグループになり（画像のIDがグループのIDになる）、SVG画像ではなくなる。`update_svg_image` では直せない。部品のIDは `convert_svg_image` の `toolResult.data.conversion.shapeIds`、または `get_document_outline` の `overlayShapes` で確かめ、位置・色・線・文字は `update_shape`、そろえるのは `align_shapes`、消すのは `delete_shapes` で直す。分解されずに残った部分は小さなSVG画像なので、`update_svg_image` で直せる。

## 完了時の報告

何を描いたか、previewで何を確認したかを短く伝える。

- `convert_svg_image` で分解したときは、承認すると部品ごとに動かせる（グループ解除で個別に編集できる）こと、極細の線は細にしたこと、SVGのまま残った部分があればその場所を伝える。`measurement` が `"estimate"`（アプリの描画環境が使えず推定で変換した）なら、文字の位置は推定なので、ずれていたら画面の「図形に変換」（SVG画像を右クリック）で分解し直せることを伝える。
- 分解していないときは、部品ごとに動かしたくなったら、画像を右クリックして「図形に変換」を選ぶか、AIに頼めば分解できることを一言添える。変換しやすい書き方から外した部分（写真風の絵・グラデーションなど）があれば、そこは画像のまま残ることも伝える。
