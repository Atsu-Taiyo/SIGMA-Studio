---
name: sigma-image-material-reconstruction
description: "画像、写真、スクリーンショット、手書きラフ、PDFの1ページを基に、本文・数式・問題・表・グラフ・図を編集可能なSigma Studio教材として再構成するときに使う。"
---

# 画像からSigma Studio教材を作成

画像を1枚の貼り付け画像で済ませず、編集できるSigmaDocの要素へ分解して作り直す。文字は本文・数式に、表は表に、グラフはグラフに、図はSVGに変える。

## 手順

1. `get_attached_media` で添付を取得し、元画像を実際に見る。複数ページのPDFは `pageStart` で範囲を分けて読む。完成教材・印刷物・スクリーンショット・手書きラフのどれに近いかを判断する。
2. 画像を **本文 / 数式 / 問題 / 表 / グラフ / 図** に分ける。文字の内容だけでなく、問題と解答の対応、要素の順序、相対位置、強調（太字・囲み・番号）も控える。
3. 作り始める前に、再利用できるものを探す。`list_materials`（用途・形状の言い換えで数回）で保存済み素材を、`search_library` で過去の似た教材を探す。中身を `get_material` で確かめ、使えるものは `insert_material`（sigma-material-library）。
4. 本文・見出し・箇条書き・数式は `insert_content`。Markdown（`content.format` が markdown）が基本で、囲み枠や明示的な書式・改ページが要るときだけ blocks を使う。数式は `$...$` か math run に入れ、本文へTeXの生文字列を混ぜない。問題文・解答・解説・ヒントが一体のものは `edit_problem`（sigma-problem-authoring）。
5. 紙面上に独立して置く要素を作る。
   - 表は `insert_table`（増減表は kind を variation にする）
   - 関数・座標平面・数直線は `insert_graph`
   - 立体・回転体・断面は `insert_graph3d`
   - **それ以外の図（幾何の作図、模式図、図解、イラスト、装置の絵、フローチャート）は `insert_svg_image`**（sigma-svg-figure）。輪郭の写経ではなく、「何をどう作図した図か」を読み取って、座標を決めてから描く。
6. 図の部品を後から個別に動かしたいと頼まれたときだけ、`insert_shape` か visual edit session（`begin_visual_edit_session` → `visual_insert_shape` → `render_visual_edit_session` → `inspect_visual_edit_session` → `review_visual_edit_session` → `propose_visual_edit_session`）を使う。previewを見ずに提案しない。
7. 作成後の `verification.preview` を元画像と見比べる。本文や数式の欠落、表の行列、曲線・軸・ラベル、図の要素と位置関係、重なり、はみ出しを確認し、違いがあれば `update_svg_image` / `update_graph` / `update_table` / `edit_text` で直して再確認する。SVGは本文と独立した画像レイヤーなので、本文と重なっていないかも見る。

## 判断ルール

- 「そのまま」「同じ」「再現」「文字起こし」「1文字も変えない」と頼まれたら、忠実な再現として扱う。優先順位は、OCRの忠実度、画像内に実在する内容の網羅、レイアウトの近似、SigmaDocの構造化。OCR誤りらしい箇所も勝手に直さない。
- 「案」「ラフ」「手書き」の画像は、意図を保ちながら読みやすく整える。ただし問題の条件・数式の意味は変えない。
- 画像に無い解答・解説・途中式・ヒント・補足は作らない。問題文だけが写っているなら、`answer` / `solution` / `hints` は空にする。作るのは、画像内に実在するとき、またはユーザーが作成を明示したときだけ。
- 読めない文字・数式は推測しない。該当箇所を警告として残し、確認したいことを1〜3件、短く聞く。解釈が同程度に割れるときも、誤った内容を確定させず質問として返す。
- 元画像そのものを紙面に貼るのはユーザーがアプリ上で行う操作。AIは描き起こして入れる。写真のような絵はSVGで再現できないので、単純化した線画にして、その旨を報告する。
- 問題番号・「解答」「コメント」の見出しは自動で付くので、本文へ書き写さない。

## 完了時の報告

再構成できたもの、そのまま残したもの、読み取れず確認が要るものを分けて短く伝える。確認していない項目を「確認済み」と書かない。
