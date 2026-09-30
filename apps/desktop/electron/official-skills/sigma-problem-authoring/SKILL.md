---
name: sigma-problem-authoring
description: "問題文・導入文・解答・解説・ヒント（コメント）をSigmaDocの problem として作成・更新するときに使う。問題の追加、解説の書き足し、小問の構成、既存問題の一部修正が対象。"
---

# 問題・解答・解説を作成・更新する

演習として意味を持つ内容は、本文の段落ではなく `problem` に入れる。`edit_problem` が入口で、`action` は create（新規）と update（既存の一部だけ変更）。

## problem の構造

| エリア | 入るもの | 表示 |
| --- | --- | --- |
| `lead` | 導入文（1ブロックまで） | 問題番号の右隣 |
| `prompt` | 問題文 | 本文 |
| `answer` | 採点・解答表示用の短い正答（1つ） | 解答欄 |
| `solution` | 解答・解説 | 「解答」エリア |
| `hints` | ヒント（画面上の「コメント」） | 「コメント」エリア |

- 各エリアは段落・見出し・リスト（と箱・段組み）の並び。`prompt` `solution` `hints` は複数ブロックにできる。
- **問題番号、「問題」「解答」「コメント」の見出しは自動で付く。本文には書かない。** 番号は本文順から決まる。
- 番号の指定・枠線・書き込み欄の高さは `edit_problem` の入力にない。頼まれたら、アプリの問題設定で行う操作だと伝える。

## 新規作成（create）

1. `get_edit_context` で挿入位置とrevisionを確認する。位置は `targetId`（その後ろに入る）か `selectedId`。文書の末尾なら `END_OF_DOCUMENT`。
2. `edit` に `prompt` を必ず入れる。短い問題は文字列でよく、数式を含むときは runs にする。
   - `["方程式 ", {"type":"math","id":"ai_m_1","tex":"x^2-4=0"}, " を解け。"]`
   - 数式のTeXには `$` を付けない。改行が要る式は `aligned` などTeXの環境で書く。
3. **元の資料に解答・解説があるとき、またはユーザーが作成を明示したときだけ** `answerTex`（数式）/ `answerText`（文章）/ `solution` / `hints` を渡す。問題文だけの依頼や画像の再現で、解答を推測して足さない。
4. 小問は、`prompt` の中に番号つきリスト（`(1)` `(2)`。`list` の `markerStyle` は paren）で書く。小問ごとに別の problem を作らない。
5. 複数の問題を作るときは、1件ずつ順に作る。前の problem のIDを次の `targetId` にする。

## 既存問題の更新（update）

- `targetId` は problem のID、またはその内側のブロックID。指定した項目だけが変わり、指定しない項目と problem のIDは保たれる。
- `solution` `hints` `lead` は空配列で消せる。`answer` は null か空の `answerText` / `answerTex` で消せる。`answer` `answerText` `answerTex` は1つだけ指定する。
- 解説を書き足すなら `solution` に**既存ブロック＋新ブロック**を渡す（渡した配列が丸ごと置き換わる）。先に `get_blocks` で現状を読む。
- 1か所の文言修正なら、`edit_text` の patch（`replace_text`）で差分だけ送る。problem 全体を作り直さない。
- 改ページ指定は `pagination:{break:true}`。解除は `pagination:null`。

## 書き方

- 問題文は条件・設問・答え方（「最も簡単な形で」「小数第2位まで」）が分かる形にする。条件は元資料のとおりに写し、変えない。
- 解説は、方針 → 計算 → 結論の順に短く。式変形は1行ずつ paragraph に分け、式の途中の説明文を数式の `\text{}` へ押し込まない。
- 解答欄に入れる `answer` は最終結果だけ。途中式は `solution` に置く。
- 図が要る問題は、problem を作ってから、`insert_svg_image`（図）/ `insert_graph`（グラフ）/ `insert_table`（表）を `targetId` に problem のID、`area` に置き先（prompt など）を指定して入れる。図は本文と独立した画像レイヤーなので、書き込み欄や本文と重ならない位置か確認する。
- 数学的な内容（計算結果、場合分け、答えの形）は、書いたあとにもう一度自分で検算する。

## 確認

書き込み後の `data.verification.validation` にSigmaDocのエラーが無いこと、`verification.preview` で番号・エリアの並び・数式の表示が想定どおりであることを確認する。承認前の提案は本体に反映されていないので、「反映済み」と報告しない。
