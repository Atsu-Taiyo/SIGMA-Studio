---
name: sigma-image-material-reconstruction
description: "画像、写真、スクリーンショット、手書きラフを基に、本文・数式・表・グラフ・図形・注記を編集可能なSigma Studio教材として再構成するときに使う。"
---

# 画像からSigma Studio教材を作成

画像を単一の貼り付け画像にせず、編集可能なSigmaDoc要素へ分解して再構成する。

## 手順

1. `get_attached_media` で添付画像を取得し、元画像を実際に確認する。完成教材、印刷物、スクリーンショット、手書きラフのどれに近いかを判断する。
2. 画像を本文、数式、表、グラフ、図形、注記に分解する。文字の内容だけでなく、問題と解答の対応、要素の順序、相対位置、強調表現も記録する。
3. 新規作成の前に `list_materials` と `get_material` で保存済み素材を探し、`search_library` で類似教材を探す。内容を確認して再利用できる素材は `insert_material` で挿入する。
4. 本文、見出し、箇条書き、本文中の数式は、意味に合うsemantic SigmaDoc blockとして `insert_body_content` で作る。問題文、解答、解説、ヒントが一体のものは `create_problem_content` で作る。数式は本文文字列へTeXを混ぜず、mathInline相当のmath runとして保持する。
5. 紙面上で独立して配置される表、座標グラフ、図形・注記はoverlay-nativeにする。表は `insert_table`、関数・座標平面・数直線は `insert_graph`、通常図形・矢印・補助線・文字注記は `insert_shape` を使う。
6. 図解や複数部品の配置を作るときは、可能な限り `begin_visual_edit_session` → `visual_insert_shape` → `render_visual_edit_session` → `inspect_visual_edit_session` → `review_visual_edit_session` → `propose_visual_edit_session` の順で作業する。プレビューを見ずに提案しない。
7. 作成結果のpreviewを元画像と並べて比較する。本文と数式の欠落、表の行列、曲線・軸・ラベル、図形の種類、位置関係、重なり、はみ出しを確認し、相違があれば修正して再確認する。

## 判断ルール

- ユーザーが忠実な再現を求めた場合は、OCR忠実度、内容の網羅、レイアウト近似、SigmaDoc構造化の順に優先する。
- 手書きラフや教材案では意図を保ちながら読みやすく整えるが、問題条件や数式の意味は変えない。
- 画像内の文字や数式が読めない場合は推測しない。該当箇所を警告として残し、必要な確認質問を短く示す。
- 複数の解釈が同程度にあり得る場合は、誤った内容を確定して挿入せず、選択肢または質問としてユーザーへ返す。
- 元画像を紙面に残すのは、ユーザーが画像自体の掲載を求めた場合だけにする。
