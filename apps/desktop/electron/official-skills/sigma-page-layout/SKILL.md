---
name: sigma-page-layout
description: "教材の用紙サイズ・向き・余白・段組み（文書全体または本文の一部）・改ページ／改段を変更するときに使う。A4からB5への変更、横向き、2段組み、本文の途中だけ段組み、次のページから始める指定が対象。"
---

# ページ設定・段組み・改ページを整える

紙面のかたちに関わる変更は、本文の文章ではなくページ設定・段組み・改ページ指定で行う。空段落や空白を並べて位置を作らない。

| したいこと | tool |
| --- | --- |
| 用紙サイズ・向き・余白 | `update_page_layout` |
| 文書全体、または本文の一部の段組み | `update_column_layout` |
| このブロックから次のページ（段）へ送る | `pagination:{break:true}` を本文の書き込みで指定 |

## 先に現状を見る

`get_document_outline` か `read_local_document`（summary）で、現在の `pageLayout`・段組み・`layoutSection` のID・revision を確認してから変更する。ホワイトボードの教材には用紙・余白・段組みが無い。

## 用紙と余白（update_page_layout）

- 変更するフィールドだけを渡す。渡さないフィールドと、段組み・ヘッダー・フッターは保たれる。
- `preset` は A4 / A3 / B5 / B4 / custom、`orientation` は portrait（縦）/ landscape（横）。
- 任意の用紙は `preset:"custom"` と `customSizeMm:{widthMm,heightMm}` を**同時に**渡す。
- `marginsMm` は上下左右のmm。ヘッダー・フッターの内容や高さを変えるtoolは無い。頼まれたらアプリの設定画面での操作を案内する。
- 余白を広げすぎると本文領域がなくなる（上下は本文高さを30mm以上残す）。極端な値は避ける。

## 段組み（update_column_layout）

段数は 1〜4。`scope` で対象を選ぶ。

- `document`: 教材全体。`columnCount`（と任意の `columnGapMm`）を渡す。**revisionが完全一致していないと拒否される**ので、直前に取り直す。
- `blocks`: 連続した本文ブロック（`blockIds`）を、新しい段組みのまとまり（`layoutSection`）で囲む。「この部分だけ2段」に使う。問題の解答エリアや囲み枠の中の段落にも使える。
- `section`: 既存の `layoutSection`（`sectionId`）の段数・段間を変える。解除は `unwrap:true` だけを指定する（`columnCount:1` は「1段のまとまり」として残るだけで、解除ではない）。

段組みの中の `pagination:{break:true}` は改ページではなく**改段**になる。段間は未指定なら文書全体の設定に揃う。

## 改ページ・改段

- 改ページを入れたいブロックに `pagination:{break:true}` を付ける（`insert_content` の blocks、`edit_text` の update、`edit_problem`）。その位置で次のページ（段組みでは次の段）へ送られる。解除は `pagination:null`。
- ページや段の先頭にあるブロックの指定は何も起こさない。文書の先頭に付けない。
- 箱・引用・問題エリアの中のブロックにも効き、その位置で箱が分割されて次のページへ続く。
- 自動の改ページは、収まらない行だけが次のページへ送られる。ブロックごと送りたいときだけ手動の `break` を使う。
- 昔の `keepTogether` / `keepWithNext` は廃止済みで、渡しても無視される。

## 確認

書き込み後の `verification.preview` と、必要なら `render_page`（`pageNumber` か `blockId`）で、用紙の向き・本文領域・段・改ページの位置を見る。ページをまたぐ図・表は本文と独立して置かれるので、段組みや余白を変えたあとに、図が本文に重なっていないかを確認し、必要なら `update_shape` などで動かす。
