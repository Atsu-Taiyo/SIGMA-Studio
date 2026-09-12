# WebMCP integration

Sigma Studio のWeb版は、対応ブラウザで開かれたときだけ `document.modelContext.registerTool(...)` で、現在開いているSigmaDocを編集するツールを登録します。Electronデスクトップ版は従来の `sigma-local` MCPを使い、SDK埋め込みではWebMCP UIとツールを公開しません。

## Architecture

```text
browser agent
  -> document.modelContext.registerTool(...)
  -> WebMcpBridge (registration and one pending draft)
  -> webmcp-tools
  -> sigma-doc-agent-tools (shared renderer-safe execution layer)
  -> AiEditSessionDraft live preview
  -> human apply or discard
  -> EditorShell.commitDocumentChange (one Undo unit)
  -> SigmaDoc
```

WebMCP用の別文書はありません。SigmaDocが唯一の正本です。読み取りは現在の文書を参照し、書き込みは共有実行層の `SigmaDocAgentSession` に操作を追加します。エージェントが複数回write toolを呼んでも独立した変更案は増えず、1つの作業ドラフトが更新されます。紙面上の既存AI差分カードでライブプレビューし、デスクトップ版と共通のキャンバス左上「AIタスク」をホバー展開して適用または破棄します。適用は `commitDocumentChange` を1回だけ通るため、1回のUndoで戻せます。

ドラフト開始時のWeb revisionとSigmaDocを保持します。次のwriteまたは人間の適用時に本文ブロック、問題内ブロック、overlay図形、ページ設定を比較し、前提が変わっていれば `STALE_DRAFT` と変更IDを返します。`edit_text` の引用・範囲と、各overlay更新ツールの完全な `expectedShape` も対象単位で照合します。エージェントは再読取後に `withdraw_pending_proposal` で古いドラフトを破棄して作り直します。

主な実装箇所:

- `apps/desktop/src/lib/webmcp-tools.ts`: JSON Schema、共有実行層への変換、鮮度ガード、単一ドラフト
- `apps/desktop/src/components/editor/webmcp/WebMcpBridge.tsx`: ブラウザAPI登録、ライブプレビュー、既存AI操作面への適用・破棄接続
- `apps/desktop/src/components/editor/webmcp/WebMcpDockSection.tsx`: AIタスクdock内の接続状態とエージェント指示
- `apps/desktop/src/components/editor/webmcp/webmcp-history.ts`: 決着したドラフトのセッション内履歴の型
- `apps/desktop/src/components/editor/CommentAuthorAvatar.tsx`: 提供元ロゴのアバター (人は頭文字)
- `apps/desktop/src/lib/comment-agents.ts`: `vendor` の正規化とブランド色
- `apps/desktop/src/components/editor/EditorShell.tsx`: Web限定gate、既存`AiTaskDock`へのpreview統合、1 undo単位のcommit
- `apps/desktop/src/lib/webmcp-tools.test.ts`: ツール意味論と単一ドラフトのユニットテスト
- `apps/desktop/tests/e2e/webmcp.spec.ts`: Web上の登録、Markdown数式変換、プレビュー、承認、reference UI非表示
- `apps/desktop/tests/e2e/webmcp-challenge.spec.ts`: 1エージェントと人間編集のstaleシナリオ

## Registered tools

ブラウザへ公開するのは28ツールです。通常図形、表、2Dグラフ、3Dグラフは入力単位と更新規則が異なるため、それぞれ一意の専用入口を持ちます。全write toolは `expectedRevision` を必須とし、初回編集前に `get_agent_instructions` と `inspect_document` を呼ぶようdescriptionで案内します。座標はページ左上基準の絶対px、回転と弧角度は度、用紙と余白はmmです。update系は未指定fieldを保持します。tool callbackはJavaScriptオブジェクトを返し、WebMCPブラウザにJSONシリアライズを任せます。

| Tool | Mode | Purpose |
|---|---|---|
| `get_agent_instructions` | read | ユーザーの自由記述指示と組み込み編集ガイダンス |
| `inspect_document` | read | 通常はrevision、選択、対象、前後文脈、outline、pageLayout、overlayを返し、必要時だけ完全SigmaDocを返す |
| `read_blocks` | read | ID指定した1個以上の本文・問題内ブロックの完全JSON |
| `search_document` | read | 本文、TeX、表セル、overlayテキスト検索 |
| `validate_document` | read | 現在の文書またはpending draftを正規スキーマで検証 |
| `get_pending_proposal` | read | 単一ドラフトの操作数、対象、操作概要、base revision |
| `withdraw_pending_proposal` | read action | 文書を書き換えずpending draftを破棄 |
| `insert_markdown` | proposal | MarkdownからWord風の本文、数式、コード、リスト、任意のネイティブ囲み枠を挿入 |
| `edit_text` | proposal | 既存本文をrange/text/block対象で置換・インライン書式変更 |
| `edit_problem` | proposal | lead/prompt/answer/solution/hintsを持つ問題を作成・部分更新 |
| `organize_blocks` | proposal | 本文ブロックを移動・削除 |
| `update_layout` | proposal | 用紙・余白・文書全体または局所段組みを目的指定で更新 |
| `insert_svg_image` | proposal | 自己完結した静的SVGを画像として挿入。原文はasset.props.srcに保持。最大256 KiB、xmlns/viewBox必須、style・script・外部参照等は拒否 |
| `update_svg_image` | proposal | SVG原文を差し替え。expectedShapeで鮮度を確認し、位置・サイズ・回転・アンカーを保持。画面上のプレビューで確認 |
| `create_overlay` | proposal | 通常図形・テキスト・吹き出しを作成。`kind:"text"`は複数段落の`markdown`に対応 |
| `update_overlay` | proposal | 通常図形・テキスト・吹き出しをその場で部分更新 |
| `arrange_overlay` | proposal | 複数overlayを整列・等間隔配置 |
| `delete_overlay` | proposal | 通常図形・テキスト・表・グラフを削除 |
| `insert_table` | proposal | 通常表または増減表を作成 |
| `update_table` | proposal | セル・罫線・行列設定をIDと未指定fieldを保って部分更新 |
| `insert_graph` | proposal | 2D関数グラフ・座標平面・数直線を作成し所有ラベルを同期 |
| `update_graph` | proposal | 2Dグラフと所有ラベルをID・位置・未指定fieldを保って部分更新 |
| `insert_graph3d` | proposal | preset起点またはGraph3DSpecで3Dグラフを挿入（zUp・rotationはラジアン） |
| `update_graph3d` | proposal | 3D specの指定fieldだけをその場で更新。ID・位置・サイズ・未指定fieldは保持 |
| `list_comments` | read | コメントスレッドの位置・差出人・解決状態の一覧 |
| `add_comment` | comment | 本文ブロック・引用箇所・インライン数式・図形のいずれかにコメントを立てる |
| `reply_comment` | comment | 既存スレッドへ返信する |
| `resolve_comment` | comment | スレッドを解決済みにする / 再開する |

内部実装には従来の粒度別ツールを残し、公開ツールがそこへ安全に振り分けます。これにより、表のセル更新、グラフ更新、図形更新などの正確なSigmaDoc操作と鮮度ガードは維持しつつ、エージェントが毎回選ぶツール候補とスキーマ量を減らします。低レベルの完全ブロック置換は公開しません。

本文を新しく挿入する場合は `insert_markdown` の `markdown` へまとめて渡します。`$...$` と `$$...$$` はSigmaDocの `mathInline` へ変換され、文字として `$` を出す場合は `\$` と書きます。変換後も書き込みは直接確定せず、通常どおり紙面上のproposal previewを人が確認します。

```json
{
  "expectedRevision": 12,
  "targetId": "p_intro",
  "markdown": "## 円の方程式\n\n式 $x^2+y^2=1$ を考える。金額は \\$5。\n\n- 中心は $O$\n- 半径は $1$"
}
```

対応範囲は、空行区切りの段落、ATX見出し、箇条書き・番号付きリストとその入れ子、`**太字**`、`*斜体*`、fenced code、`$...$` / `$$...$$` です。Markdownの表、リンク、画像、blockquote、inline codeはまだ構造変換しません。paginationは同じ呼び出しの`pagination`、囲み枠は`container`で指定します。段組みは`update_layout`を使います。

表の1セルだけを直すときは削除して作り直さず、`update_table.cellPatches`を使います。2Dグラフは`update_graph`、3Dグラフは`update_graph3d`、通常図形は`update_overlay`を使います。どの更新も完全な`expectedShape`で対象の鮮度を確認し、ID・位置・サイズ・未指定fieldを保持します。

## Whiteboard

`inspect_document`は`documentMode`として`"whiteboard"`または`"paged"`を返します。ホワイトボードには本文フローがないため、`insert_markdown`、`edit_text`、`edit_problem`、`organize_blocks`などの本文ツールは`WHITEBOARD_NO_BODY`を返します。

文章は`create_overlay`の`kind:"text"`と`markdown`でキャンバスへ置きます。表・2Dグラフ・3Dグラフはそれぞれのinsertツールに`targetId:"CANVAS"`と絶対座標`x`/`y`を渡します。作成されたproposalはキャンバス上に破線のghost shapeとして表示され、同じキャンバス上の承認widgetから適用または破棄できます。

## Comments

コメントは**本文・図形・ページ設定のどれも書き換えない注釈**なので、提案ドラフトを通さずそのまま文書へ入ります (Figmaと同じく、コメントは承認の対象ではありません)。取り消しは⌘Zとパネル上の削除です。1本しか持てない作業ドラフトをコメント1件が占有しないので、**編集の提案が承認待ちのあいだもコメントできます**。

- `add_comment` の `target` は、`shapeIds` で図形、`blockId` + `mathInlineId` で数式、`blockId` + `text` で本文中の語句 (完全一致・`occurrence` で何個目か指定)、`blockId` だけでブロック全体を指します。語句指定のオフセットは `$tex$` を含む平文の文字数で、エディタ側の外部ハイライトと同じ座標系です。
- `author` は必須で、`name` (表示名) と `vendor` (提供元) を求めます。`vendor` はコメント欄のアバターに出すロゴを決めます。`openai` / `anthropic` / `google` / `microsoft` はロゴを、それ以外は頭文字とAIバッジを描きます。製品名 (`"claude"`, `"gemini"` など) で来た場合も提供元へ寄せます。
- 本文の `text` は `$...$` が数式に、`**...**` などが書式になります (本文挿入と同じ規則)。
- コメントツールは `expectedRevision` を取りません。対象が消えていれば解決に失敗するので、それ自体が鮮度の確認になります。**コメントで進んだrevisionは、エージェントへ見せるrevisionから差し引きます**。コメントを書いても、直前に読んだ `expectedRevision` がそのまま使えます。
- 承認は同じ文書の中で解決します。ドラフトは開始時のスナップショットから育つので、適用時に**そのあいだ付いたコメントを持ち越します** (承認でコメントが消えない)。

デスクトップ版のコメント`@`メンション経由のAI返信にも同じ素性を載せるので、ChatGPT / Claude / Antigravity の返信は同じロゴで表示されます。

## Single-agent UI and instructions

Web版のAI面は**キャンバス左上の`AiTaskDock`ひとつだけ**です。デスクトップ版と同じdockをそのまま使い、ホバーで開いた中に上から順に表示します。

1. `document.modelContext` の利用可否、登録中・接続済み・一部失敗・失敗の状態、登録できなかったツール名
2. agent.md相当の自由記述指示。教材IDごとの設定データとしてlocalStorageに保存
3. 単一ドラフトの保留行（適用・破棄）と、決着したドラフトの結果行（適用済み・破棄）

右上の独自カードやWeb専用のAIサイドパネルは持ちません。Web版ではAIチャット面自体が無いため、上部メニューの「AI」、⌘K、コマンド `ai.chat` からもパネルは開きません。ドックは提案が無いときも常駐します。

結果行はページを開いているあいだだけのメモリ保持で、リロードで消えます（指示はlocalStorageなので残ります）。デスクトップにある「元に戻す」「再提案」はWebでは出しません。承認バッチ (`appliedRevision`) とmainの巻き戻し判定がWebには無く、取り消しは⌘Z一本（`commitDocumentChange`が1 undo単位）だからです。紙面上のAI差分カードは実際の挿入結果を確認するため引き続き表示します。

ユーザー入力の指示は ambient context へ混ぜず、`untrustedContentHint` を付けた `get_agent_instructions` からだけ取得できます。ブラウザが `modelContext.provideContext` を提供する場合も、渡すのは固定のアプリケーションガイダンスだけです。Web版では選択箇所を「AIに追加」するワンドとreference蓄積経路を作りません。選択の受け渡しはエージェント側UIの責務です。

## Intentionally unavailable desktop tools

次のデスクトップMCP機能はWebMCPに公開しません。

- library/folder CRUD、`search_library`: Webページで開いている1文書の権限境界を越えるため
- materials: デスクトップのworkspaceライブラリとファイル保存に依存するため
- AI resource CRUD、`update_ai_settings`: Webではユーザー指示をlocalStorage設定として扱い、desktop userDataへ書かないため
- visual PNG session、`render_page`: Webでは同じ紙面のライブghost previewで確認できるため
- `get_active_reference` などrun-context系: reference選択はエージェント側UIの責務とするため

## Challenge demo and PDF parity

`apps/desktop/public/demo/webmcp-challenge.sigmadoc.json` は、本文・本文中数式・通常図形・2Dグラフ・表を1ページに含むデモ教材です。fixture自体はWebMCPツール刷新では変更しません。

`pdf-parity.spec.ts` はこのfixtureを通常の編集面とdesktop PDF用の `PagedRenderSurface` の両方で描画し、本文・数式・3種類のoverlayについてページ番号とページ内のx/y/w/hを0.5 CSS px以内で比較します。WebMCP Challenge E2Eは、単一エージェントがドラフトを作った後に人間が本文を編集し、適用と次のwriteの両方でstale guardが働く流れを確認します。

## Local testing

1. Chrome 149以降で `chrome://flags/#enable-webmcp-testing` を開く。
2. WebMCP testingをEnabledにしてChromeを再起動する。
3. リポジトリルートで `npm install`、`npm run dev` を実行する。
4. 表示されたローカルURLをChromeで開く。
5. AIパネルの接続状態と登録ツール数を確認する。

自動テスト:

```sh
npm run typecheck
npm --workspace @sigma-studio/desktop exec vitest run src/lib/webmcp-tools.test.ts
cd apps/desktop
npm exec playwright test tests/e2e/webmcp.spec.ts tests/e2e/webmcp-challenge.spec.ts
npm exec playwright test tests/e2e/pdf-parity.spec.ts --grep "WebMCP Challenge fixture"
```

## Challenge provenance

このWebMCP作業は、2026-08-28に `origin/main` の `937311481f6bfbde39b755d0cfca81493632c9a1`（`v0.393.0`）へ応募用ブランチをfast-forwardした後に追加しています。既存のSigma Studioと応募期間中に追加したWebMCP部分を区別するときは、このcommitを比較元にします。

```sh
git diff 937311481f6bfbde39b755d0cfca81493632c9a1...HEAD -- \
  apps/desktop/src/components/editor/EditorShell.tsx \
  apps/desktop/src/components/editor/webmcp \
  apps/desktop/src/lib/webmcp-tools.ts \
  apps/desktop/src/lib/webmcp-tools.test.ts \
  apps/desktop/tests/e2e/webmcp.spec.ts \
  docs/webmcp.md README.md
```

## Public submission repository

WebMCP Challengeへの提出時は、審査員がアクセスできる公開リポジトリが必要です。リポジトリには動作に必要なソースとアセット、導入・テスト・デプロイ手順、`document.modelContext.registerTool(...)` の実装、既存部分と応募期間中の実装の区別を含めます。

応募用の公開リポジトリは、ルートの `LICENSE` に記載したMIT Licenseで公開します。公開前には秘密情報と第三者アセットを確認し、動作に必要なソースと手順が揃っていることを再確認します。
