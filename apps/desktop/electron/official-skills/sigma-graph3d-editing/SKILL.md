---
name: sigma-graph3d-editing
description: "立体・回転体・曲面・断面・立体どうしの共通部分を3Dグラフとして教材へ挿入・更新するときに使う。空間座標、球・円柱・円錐・多面体、回転体の体積の図が対象。"
---

# 立体（3Dグラフ）を挿入・更新する

立体・回転体・曲面・断面・共通部分は `insert_graph3d` で作る。関数のグラフや座標平面は `insert_graph`（sigma-graph-editing）、立体でない図解・模式図は `insert_svg_image`（sigma-svg-figure）。

## 基本

- 新規は `insert_graph3d`、既存は `update_graph3d`。**作り直さない**。`delete_shapes` してから挿入すると位置・サイズ・カメラが失われる。
- 数学座標は **z軸が上向きの右手系**。式は TeX ではなく評価用の式（`x^2+y^2+z^2=1`、`sqrt(2*z^2+1)`）。
- 配列（`objects` `regions` `annotations` `parameters`）は指定すると**丸ごと置き換わる**。1つ足したいときも既存を含めて全部渡す。`camera` と `view` は指定したキーだけが既存へマージされる。
- 角度の単位に注意。`objects` の `rotation`・`angleRange` はラジアンの式（90度は `pi/2`、一周は `0` から `2*pi`）。overlay図形の `rotationDeg`（度）とは別。`camera.fov` だけが度。`w` `h` はpx。
- 問題の中へ置くなら `targetId` を problem のIDにして `area` を指定する。ホワイトボードは `targetId` を `CANVAS` にして `x` / `y` を渡す。
- 挿入時に静止画も作られるので、アプリを開かなくても印刷・PDFに図が出る。

## 組み立て

1. **preset から始める**: `revolution`（回転体と断面）、`surface`（曲面と等高線）、`tricylinder`（3円柱の共通部分）、`sphereTetrahedron`（球と正四面体）、`blank`（軸とグリッドのみ）。近いものを選び、必要な配列だけ上書きする。
2. **objects の kind**:
   - `implicitSurface` 陰関数曲面（`expression` と `bounds`）
   - `parametricCurve` / `parametricSurface` 媒介変数の曲線・曲面
   - `primitive` 球・円柱・円錐・直方体（`center` と `size`）
   - `solidOfRevolution` 回転体（`axis` は x/y/z か2平面の交線、`radius` は軸上の位置の式、`axisRange`）
   - `polyhedron` 多面体（`vertices` と、0始まりの添字で書く `faces`）
   - `boundedSolid` 不等式で囲まれた立体（`inequalities` と `bounds`）
   - `point` `segment` `plane`（`plane` は equation / threePoints / pointNormal のどれか）
3. **bounds は狭く**: サンプリングする直方体。図の範囲より少し大きい程度にする。`resolution` を上げると計算が急に重くなる（立体は3乗で効く）。
4. **断面と共通部分**: `regions` の `objectIntersection` は、2つ以上の object が共有する部分を別の色で描く（切り取りではなく、何も削られない）。平面を含めると断面図になる。共通部分が空なら何も描かれない。
5. **ラベルと寸法**: `annotations` の `label`（`position` と `labelTex`）と `dimension`（`from` `to` `labelTex`）。`labelTex` は TeX で、印刷・PDFでもベクタで重なる。
6. **パラメータ**: 式から参照する可変値は `parameters`（`name` `value` `min` `max`）。動かして見せる教材では `animation` を付けられる。
7. **視点**: `camera` の `position` `target` `up`。まず `preset` の既定のまま挿入し、見えにくければ `position` だけを動かす。断面が手前の面に隠れるなら、視点を変える前に透明度（`style.opacity`）や `wireframe` を検討する。
8. **配色**: 白黒基調にする。面は薄いグレーと `wireframe`、強調したい断面・共通部分だけに色や `fill` の pattern（diagonal / cross / dots）を使う。

## 確認と修正

`verification.preview` を実際に見る。

- 形が式と一致しているか（半径、高さ、回転軸、範囲）。
- 断面・共通部分が意図した位置に出ているか。空になっていないか。
- ラベル・寸法が形や互いに重なっていないか。
- 全体が見切れていないか。`bounds` と `camera` を見直す。

直すときは `update_graph3d`（必要な配列とキーだけ）。previewが得られないときは、確認できていないと報告する。
