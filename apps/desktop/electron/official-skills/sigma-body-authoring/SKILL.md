---
name: sigma-body-authoring
description: "見出し・段落・箇条書き・数式・囲み枠・コードなど、教材の本文を新しく書く、または既存の文章を最小の差分で直すときに使う。書式（フォント・文字サイズ・囲み）の変更や本文の並べ替えも含む。"
---

# 本文・数式・囲み枠を書く

本文は SigmaDoc の `content`（本文フロー）に入れる。入口は3つ。図・表・グラフは本文ではなく紙面上の別レイヤーなので、それぞれ `insert_svg_image` / `insert_table` / `insert_graph` を使う。

| したいこと | tool |
| --- | --- |
| 新しい本文を足す | `insert_content` |
| 既存の文章を直す・書式を変える | `edit_text` |
| ブロックを動かす・消す | `organize_blocks` |

問題（問題文・解答・解説）は `edit_problem`（sigma-problem-authoring）で作る。

## 書き始める前に

- `get_edit_context` で revision・対象・前後の文脈を1回で取る。ユーザーが「選択部分だけ」と言うときは `context.selection` の全参照・全ブロックが対象。選択は編集位置の手がかりであって、編集をその1ブロックに閉じ込める制約ではない。
- 対象が分からないときは `get_document_outline` → `search_document`（文言・TeXで検索）→ `get_blocks`（複数を軽量に読む）の順。教材全体を読む（`read_local_document` の full）のは、全体の比較や広い範囲の変更が要るときだけ。
- 大きな作業は、先に対象を列挙して1件ずつ処理する。

## 新しい本文（insert_content）

- `targetId` はそのブロックの後ろに入る。文書の末尾は `END_OF_DOCUMENT`。問題の中の段落の直後なら、その段落IDを `targetId` にして `area` は付けない。問題エリアの末尾へ足すときだけ `area`（lead / prompt / solution / hints）を指定する。ホワイトボードでは使えない（文字は `insert_shape` の kind を text にする）。
- **Markdown が基本**（`content.format` が markdown）。段落・見出し（`#` `##` `###`）・入れ子リスト・コードの囲み・太字・斜体・`$...$` / `$$...$$` の数式が構造になる。ドル記号そのものは `\$` と書く。表・リンク・画像・引用・インラインのコードは構造にならないので使わない。
- 囲み枠・フォントや文字サイズ・改ページを付けたいときは blocks（`content.format` が blocks）。
  - 段落 `{"type":"paragraph","id":"ai_p_1","runs":["式 ",{"type":"math","id":"ai_m_1","tex":"x^2+1"},"を考える。"]}`（`align` `lineHeight` `fontFamily` `fontSize` も指定できる）
  - 見出し `{"type":"heading","level":2,"text":"…"}`（level は 1〜3）
  - リスト `{"type":"list","listType":"ordered","markerStyle":"paren","items":["…","…"]}`（`markerStyle` は decimal か paren。入れ子は項目の `nested`、項目内の続きは `continuations`）
  - 囲み枠 `{"type":"boxBlock","styleId":"itembox","title":"ポイント","blocks":[…]}`
  - コード `{"type":"codeBlock","language":"python","text":"…"}`
  - 改ページ `pagination:{"break":true}`（段組みでは改段）
- 囲み枠の `styleId`: `fancybox` `itembox` `tcolorbox` `tcolorbox-note` `doublebox` `shadebox` `leftbar` `dashedbox` `ruledbox` `screenbox` `ovalbox` `cornerbox`。定義・公式・注意には `itembox` か `tcolorbox-note`、強調の帯には `leftbar` などが素直。単純な枠付き本文を図形で作らない。

## 数式

- 本文中の数式は必ず math（`mathInline`）。TeXに `$` `\(` を付けない（Markdownの `$...$` は変換の区切りであってTeXの一部ではない）。
- 別行立ての式は、`align:"center"` の段落に math を1つだけ入れる。複数行の式は `aligned` `cases` などのTeX環境。
- 式の途中の説明文を `\text{}` や `aligned` の1行に押し込まない。「よって、両辺を k 倍すると」のような文は左揃えの段落に分け、前後の式を別段落の math にする。
- 数式は保存前に検証される。未対応のコマンドや括弧の不一致は返値の `verification.validation` に出るので直す。

## 既存の文章を直す（edit_text）

- **局所修正は `edit.action` を patch にして、`replace_text` で差分だけ送る。** 段落を作り直さない。対象の指定は次のいずれか。
  - `{"type":"range","blockId","from","to","quote"}`（`quote` が古いと拒否される。`get_edit_context` の offset を使う）
  - `{"type":"text","blockId","text","occurrence"}`（完全一致。同じ文字列が複数あるときは `occurrence`）
  - `{"type":"activeSelection"}`（選択範囲）／`{"type":"block","blockId"}`（段落全体）
  元のフォント・ptサイズ・太字・色・囲みと、範囲外の内容は保たれる。
- 書式だけの変更は同じ patch の中で `format_inline`（`style` に `fontFamilyToken` の body / sans / mincho / m-plus-1p、`fontSizePt`、`boxed`）。文字サイズは **pt** で、pxへ換算しない。`activeSelection` は本文の選択を優先し、無ければ選択中の text / callout 図形へ適用される。
- 段落のrun構造やページ指定を組み替えるなら `edit.action` を update。ID・type・見出しlevel・指定しない項目は保たれる。
- ブロックの種類そのものを変えるとき（段落→箱など）だけ `replace_structure`。先に `get_blocks` か `get_edit_context` で完全な現在値を読み、同じ id / type と変えない項目を保って渡す。これは patch ではない。

## 並べ替え・削除（organize_blocks）

`edit.action` が move なら `blockIds` を `targetId` の前後へ（`position` は before / after。末尾は `END_OF_DOCUMENT` と after）。delete は `blockIds` の本文ブロックを消す。表・グラフ・図・SVGは本文ブロックではないので `delete_shapes` を使う。

## 確認

書き込み後は `data.verification.validation` のSigmaDocエラー、`verification.preview` の表示を確認する。提案は承認されるまで教材本体に反映されないので、「反映済み」と言わない。
