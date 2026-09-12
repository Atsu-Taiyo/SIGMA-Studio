# Local AI Collaboration

## Status

この文書は、現在の Sigma Studio デスクトップ版でのローカルAI連携境界を説明する。正本は Electron main process が管理する `data` 配下の library / workspace / document ファイルであり、AI編集はアプリ側の検証と承認境界を通す。

## Current Model

```text
Electron renderer
  EditorShell / PageCanvasEditor / AiEditPanel
      │
      ▼
Electron main process
  LocalSigmaDocStore
  LocalMcpEditProposalStore
  Codex app-server client / Claude stream client / Gemini headless client
      │
      ▼
app.getPath("userData")/data
  library.json
  workspace.json
  documents/<fileId>.sigmadoc.json
  proposals/*.proposal.json
  codex-agent-home/
  codex-agent-workspace/
  claude-agent-home/
  antigravity-agent-workspace/ (.agents/mcp_config.json を含む)
  ~/.gemini/config/mcp_config.json (Antigravity 2.0 / IDE / CLI 共有のMCP設定)
  ai-run-context/ (プロバイダごとの <provider>.run-context.json、Antigravityは <provider>[-<runId>].tool-activity.jsonl も)
```

`documents/<fileId>.sigmadoc.json` の中身はSigmaDoc JSONです。`library.json` は workspace / folder / file / revision の管理正本、`workspace.json` は開いているタブとactive fileだけを持つUI状態です。

`fileId` はローカルlibrary上の管理IDです。`docId` はSigmaDoc内部IDで、ファイル一覧やrevision管理のキーにはしません。

## Data Ownership

- SigmaDoc JSONが教材の正本です。
- Tiptap JSON、HTML、LaTeX全文、PDF、SVG、overlay編集途中状態は正本にしません。
- 画像、図形、表、グラフは `pageLayout.overlay.overlaySnapshot` に保存します。
- 単純な枠付き本文はoverlayではなく `boxBlock` に保存します。
- renderer の `localStorage` / IndexedDB は標準のデスクトップ教材保存経路ではありません。

## Desktop AI Sidebar

アプリ内AI編集は `AiEditPanel` から Electron bridge (`desktopAPI.aiEdit.run`) を通って `electron/ai-edit.ts` に入ります。プロバイダ(Codex app-server / Claude CLI `--mcp-config` / Antigravity CLI `agy --print`)ごとのクライアントが、共通ローカルMCPサーバー (`apps/desktop/mcp/sigma-doc-mcp-server-core.ts`) をツールとして呼び出しながらturnを進めます。

```text
AiEditPanel
  → desktopAPI.aiEdit.run
  → electron/ai-edit.ts (Codex) / ai-edit-shared-runner.ts の runMcpEditForIpc (Claude / Gemini)
  → provider client (CodexAppServerClient / ClaudeStreamClient / GeminiHeadlessClient)
  → 共通ローカルMCPサーバー (sigma-doc-mcp-server-core.ts) のツール呼び出し
  → pending proposal (data/proposals)
  → デスクトップ側の承認UIで反映
```

どのプロバイダも任意の教材ファイルを直接書き換えません。モデルはMCPツール経由でしか教材を読み書きできず、書き込み系ツールは`expectedRevision`必須のうえ既定でproposal化されます。アプリ実行時はアプリの実行コンテキストファイル(`ai-run-context/<provider>.run-context.json`)と `get_selected_block` などのapp-context系ツールで選択ブロックや添付ファイルを渡します。画像はimage content、その他の形式はresource contentとして `get_attached_media` から取得できます。

overlay図形を選択してAI編集を送るときは、選択範囲を1枚のPNGサムネイルにしてユーザーturnへ添付し、会話履歴にも保持します。これは見た目を確認するための派生画像であり、編集対象の正本は `selectedShapeIds` と選択図形JSON、挿入位置の正本は対象ブロックIDとanchorです。AIが作った図形挿入案もproposal内のネイティブ図形から小さなSVGを派生表示し、承認・却下後もproposalが残る間は同じassistant turnで確認できます。PNG/SVGをSigmaDoc図形の代わりに保存したり、派生画像を重複挿入したりはしません。

通常のAI作図は、完成レイアウトの自動生成ではなく、ユーザーがクライアント上で選択・移動・サイズ変更・内容編集できるネイティブ図形の叩き台を作ることを優先します。元画像や参照図への忠実な再現が依頼された場合だけvisual edit sessionで見た目を反復確認し、通常の図形挿入では細かな位置・重なりの調整を完了条件にしません。

MCPツール呼び出しの承認プロンプトはプロバイダごとに無効化しています。Codexは`approval_policy = "never"`だけではread-only sandboxでMCPツール承認が抑止されないため、アプリ生成の`codex-agent-home/config.toml`で`[mcp_servers.sigma-studio-local]`に`default_tools_approval_mode = "approve"`を設定して承認要求自体を出させません。加えて`CodexAppServerClient`は、承認要求(`mcpServer/elicitation/request`)が届いた場合に備えて`sigma-studio-local`宛に限り自動許可し、他サーバー宛はエラー応答で拒否します。ClaudeはallowedTools指定、Geminiは`trust: true`で同等の自動許可をしています。教材反映の承認境界はプロバイダ側ではなくアプリのproposal承認UIです。

ユーザーが承認するまで、開いているSigmaDocの正本は更新しません。

アプリ内AI編集中は、明示した本文の文字範囲・インライン数式・ブロック・overlay図形をロックし、対象外は編集できます。文字範囲を渡した場合は同じ段落の範囲外も入力・書式変更できます。開始時の本文を一時的な基準として範囲を追跡し、ProseMirrorの変更位置とSigmaDocへの確定時の内容比較の両方で保護します。基準を持たない旧形式のrunやブロック全体への依頼はブロック単位です。図形グループのメンバーやグラフの所有ラベルは、その図形と一緒に保護します。

pending proposalは実際に置換・削除・変更するブロックや図形を適用・破棄までロックします。本文や図形を挿入するだけの案、および移動先として参照するだけの本文はロックしません。文書全体の編集停止は、承認などで文書を差し替える書き込み中だけです。提案の競合判定は引き続きブロック・図形単位で行うため、同じ段落の範囲外を人間が編集した場合も古い置換案は競合になりえます。その場合は通常の適用を止め、人間の編集を黙って上書きしません。

Antigravity CLI (`agy --print`) は実機確認で以下の癖があり、`GeminiHeadlessClient` / `gemini-edit.ts` はこれを前提に組んでいます(詳細は `docs/mcp-local-app.md` の「Antigravity CLI (`agy --print`) 実行時の注意」を参照)。

- `--print` は値を取るstringフラグなので `--print=`(空値)を明示し、プロンプト本体はargvではなくstdinで渡します。`--print-timeout` / `--model` / `--conversation` / `--log-file` はその後ろに続けます。
- printモードのstdoutは最終応答のプレーンテキストのみで、ツール呼び出しイベントも会話IDも一切流れません。会話IDは `--log-file` に書かれるログ行から回収してresumeに使います。
- ツール呼び出しの検知手段がCLI側にないため、共有MCPサーバー (`mcp/tool-activity.ts`) が呼び出しをJSONLへ自己記録し、デスクトップ側 (`gemini-tool-activity-watcher.ts`) がポーリングしてUIの「ツール実行中...」表示に変換します。
- `@ファイル参照` の添付画像はモデルに届かないため、`get_attached_media` が返すimage content経由で渡します。
- 画像や文書の「そのまま再現」「文字起こし」「レイアウト再現」は転記・構造化として扱います。ユーザーが解答・解説の作成を明示しない限り、元資料にない解答、途中式、ヒント、補足、ラベルをAIが追加してはいけません。問題文だけの画像ではproblemのanswer / solution / hintsを空または未指定にします。

## Local MCP Server

Claude Code / Codex / Antigravity CLI など外部AIからローカル教材を読む・編集提案を作る場合は、stdio MCP server を使います。
アプリ内 Claude MCP 実行の並列化計画は `docs/claude-mcp-parallel-sessions-plan.md` に置きます。

```bash
node apps/desktop/scripts/run-sigma-doc-mcp.mjs
```

project scoped 設定は次です。

- Claude Code: `.mcp.json`
- Codex: `.codex/config.toml`

MCP server は `apps/desktop/mcp/sigma-doc-mcp-server.ts` をビルドして起動し、`SIGMA_STUDIO_USER_DATA_DIR` または `SIGMA_STUDIO_DATA_DIR` が指定されていなければ Electron と同じ userData 保存先を探します。

## MCP Write Policy

MCPの書き込み系ツールは、既定では教材を直接保存しません。`data/proposals` に承認待ち提案を作り、デスクトップアプリ側で承認・却下します。

編集前の基本手順:

1. `list_local_documents` で `fileId` と `revision` を確認する。
2. `get_document_outline` / `get_block` で対象IDを確認する。
3. 書き込み系toolは `expectedRevision` が必須(schemaで強制)。省略はMCPツール入力エラーになる。
4. 通常は `writeMode` を省略してpending proposalを作る。
5. 検証だけしたい場合は `writeMode: "dryRun"` にする。

MCPから教材本体へ直接commitする経路はありません。標準運用ではproposalを作り、デスクトップ側の承認UIで反映します。承認時、提案は現在の教材へ再適用されます。対象ブロック自体が削除・変更されて適用できない場合は、最新の `revision` と対象IDを読んで作り直します。

教材本文の更新は、rendererの自動保存・名前変更・提案承認・revertを含めて `LocalSigmaDocStore.saveDocument` のCASを必須とします。rendererは文書payloadと「そのpayloadを組み立てた時点で観測したrevision」を `ObservedDocumentWrite` として同時に保持し、保存直前の一覧再取得で新しいrevisionへ差し替えません。CAS不一致のpayloadは破棄し、最新SigmaDocを読み込んで `documentRef` を更新できるまでは再保存しません。提案承認中は承認IPCの返す文書を正本として、`documentRef` と観測revisionを更新してから延期中の自動保存を解放します。

insertだけの提案は選択範囲やアンカー本文のhash差分を競合理由にしません。同じ提案内で作られない外部アンカーが現在のSigmaDocに存在することだけを鮮度契約とし、アンカーが消えていれば競合、存在すれば最新文書へのreplayを試します。既存内容を置換・削除・更新する提案は、引き続き実際の対象IDだけを内容hashで比較します。

AI編集で渡す選択ブロックは位置と文脈の手掛かりであり、編集をそのブロック内だけで完結させる境界ではありません。意味やレイアウトを正しくするために必要なら、同じrun/roomの作業案内で既存ブロックの更新と `insert_body_content` / `delete_blocks` / `move_blocks` を組み合わせ、ブロックを分割・追加・削除・移動します。独立した日本語説明を位置合わせ目的で数式の `\text{...}` や `aligned` に残さず、左揃え等の独立paragraphへ分離します。

## Public MCP Tools

登録済みツールの正確な一覧・説明文は `docs/mcp-local-app.md` を正本とする(外部のCodex importツールが同ドキュメントを読むため、ツール名の変更時は必ずそちらを更新すること)。カテゴリだけ示す。

- 読み取り: 教材一覧・本文・アウトライン・検証・提案一覧・素材一覧、AIリソースファイル一覧/読み取り
- アプリ実行時のみのapp-context読み取り: 選択ブロック・参照コンテキスト・挿入候補・前後ブロック・添付画像・メンション教材(fileId指定不要)
- 書き込み提案: 本文/問題/表/グラフ/図形の挿入・型付き更新、素材挿入、および図形専用のvisual edit session系(begin/insert/replace/remove/render/inspect/review/propose/discard)

図形、表、グラフはoverlayへ挿入します。通常の図形、補助線、矢印、模式図、注記は `insert_shape` を使います。図形内ラベルの寸法はツール側で決めます。テキスト注記 (`kind:"text"`) は幅だけを指定し、高さは内容から導出されます。円・楕円・矩形・三角形など標準kindで表せる図形はそのkindを使い、`polyline` で近似しないでください。`polyline` は折れ曲がった線、開いた経路、区分線、標準kindにない閉じた多角形など、線分列であること自体が意味を持つ場合だけ使います。閉じた多角形は `closed: true` を指定できます。問題内へ置く場合は `area: "lead" | "prompt" | "hints" | "solution"` を指定し、ツール側が対象rich blockへの `block` anchorを張ります。空のエリアへ挿入する場合は、空paragraphを作ってからanchorします。

図形の品質を確認しながら作る場合は、`begin_visual_edit_session` でscratch sessionを作り、`visual_insert_shape`、`render_visual_edit_session`、`inspect_visual_edit_session`、`review_visual_edit_session` を繰り返してから `propose_visual_edit_session` でpending proposalを作ります。`render_visual_edit_session` はアンカーブロック周辺のページコンテキストを含むPNG previewを返します(アプリのrender bridge経由、失敗時はresvgによるsvg-fallback)。元画像や参照図を再構成する場合は、previewを元画像と見比べ、足りない要素・位置ずれ・ラベル違い・余分な図形があれば `visual_replace_shape` / `visual_remove_shape` / `visual_insert_shape` で修正してから再度render/inspect/reviewします。円・楕円・円弧は標準kindで作り、多数点の折れ線で近似しません。`propose_visual_edit_session` は最後の変更後のrender、inspection合格、review合格がない場合に拒否されます。試行錯誤中はproposalを作らないため、不要な承認待ち提案が増えません。

保存済み素材は `description`、`usage`、`visualConcepts`、`ports` を持てます。画像や添付資料に近い素材がある場合は、AIが通常の作図toolで作り直す前に `list_materials` / `get_material` で候補を確認し、`insert_material` でexact cloneとして挿入します。

編集提案には作成したプロバイダ(`claude` / `chatgpt` / `antigravity`、環境変数 `SIGMA_STUDIO_MCP_PROVIDER` から解決)が付記され、承認UIのプレビューにも表示されます。同一 `fileId` + `baseRevision` の複数提案は1つのプレビューへ合体し(`groupMcpProposalsForPreview`)、提案作成後に対象教材が別途更新されてrevisionが進んだ場合は、その提案は合体対象から外れて`AiStaleProposalNotice`側に分離表示されます。

提案には作成元の `runId` / `roomId` / `turnId` / 任意の `sessionLabel` も付記できます(すべて任意。実行コンテキストファイル `ai-run-context/<provider>[-<runId>].run-context.json` 経由でMCPサーバーへ渡り、`resolveProposalAttribution()` でproposalへ写す)。stale化した提案は、作り直させる代わりにその場で `rebaseMcpEditProposal` (IPC: `storage:rebase-mcp-edit-proposal`) を呼ぶと、現在のドキュメントへの再適用を試み、成功すれば `baseRevision`/`nextDocument` をその場で更新して(元のrevisionは `rebasedFrom` に残す)再びプレビュー対象に戻せます。却下は理由つきの一括版 `rejectMcpEditProposals` (IPC: `storage:reject-mcp-edit-proposals`、`{ proposalIds, reason? }`)を使うと `rejectedReason`/`rejectedAt` が記録されます(単体版 `rejectMcpEditProposal` はそのまま後方互換で残る)。

デスクトップ設定 `aiAutoApplyVerifiedProposals` (既定false) をONにすると、MCPサーバーが `verification.validationOk === true` を報告したpending提案は、`baseRevision` が現在のファイルrevisionと一致する限り自動承認されます(承認イベントに `autoApplied: true` が付く)。承認 (手動・自動どちらも) の際、承認直前に読み込んだドキュメントを `revertDocument` として、保存直後のrevisionを `appliedRevision` として提案レコードに保存しておきます。`revertMcpEditProposal` (IPC: `storage:revert-mcp-edit-proposal`) でその承認を取り消す際、現在のファイルrevisionが `appliedRevision` のままなら `revertDocument` をまるごと書き戻します。承認後にさらに教材が変更されていても、その提案 (および同じ1回の保存を共有した承認バッチ) が触ったブロック/overlay図形自体がその後無編集であれば、現在のドキュメントを土台にその範囲だけを選択的に戻します(`local-sigma-doc-proposal-store.ts` の `getRevertPlan`/`buildSelectiveRevertDocument`)。触った範囲へさらに人手の編集が入っている、ブロックの移動やレイアウト変更(`moveBlocks`/`wrapBlocksInColumns`/`updateLayoutSection`)を含む、削除されたブロックが本文直下ではなくネストされた位置にあった、といったケースは安全のため取り消し不可のまま残ります(取り消し後のstatusは共通して `reverted`)。この `verification.validationOk` は、全ての書き込み系MCPツールが変更後のSigmaDocを検証した結果からproposal作成時に埋めます(schemaレベルの検証のみで、page-context previewの見た目は含みません)。ツール呼び出し自体のレスポンスにも同じ検証結果とpreview PNGが `verification` フィールドとして返り、エージェントはcommitを待たずにその場で確認・自己修正できます。既存内容や承認前のproposalのブロック周辺は `render_block_context`、ページ全体と実際のページ割当は `render_page` で確認します。

## External File Changes

デスクトップ版は `data/documents`、`library.json`、`workspace.json` を監視します。外部エディタや同期ツールが現在開いている `documents/<fileId>.sigmadoc.json` を更新した場合、main process がrendererへ通知し、renderer はSigmaDocを読み直します。

アプリ内編集がdirtyな状態で外部更新が来た場合は、新しい `fileId` の退避教材を作ってから外部変更を反映します。外部削除時は削除済みfileを復活させず、別fileへ切り替えます。

## Excluded Directions

標準実装では、次を採用しません。

- 任意のローカル教材フォルダを直接正本にする方式
- AIエージェントが `lesson.sigmadoc.json` を直接編集する方式
- `localStorage` を教材保存の正本にする方式
- 外部canvas形式を共同編集形式にする方式

同じPC上でAIと連携する場合も、現在は Electron local store と、全プロバイダ共通のMCP proposal経由を通します。

## Testing Strategy

この境界を変えるときは、次を優先して検証します。

- `local-sigma-doc-store` のlibrary / workspace / revision処理
- `local-sigma-doc-proposal-store` のproposal作成・承認・拒否・rebase・revert・検証済み自動承認判定(`shouldAutoApplyProposal`)
- `sigma-doc-mcp-server` の `expectedRevision` とproposal生成
- `ai-edit-shared-runner.ts` の `runMcpEditForIpc`、`mcp-edit-prompt.ts` のプロバイダ別プロンプト、プロバイダ付記
- `groupMcpProposalsForPreview` によるfileId+baseRevision単位のプレビュー合体・stale分離
- `parseSigmaDocument` / `getDocumentIssues` による保存前検証

AIやMCPから得た入力は不信頼入力として扱い、SigmaDoc正本へ反映する前に必ずschemaと専用validatorを通します。

## Codexの画像生成・画像編集

ChatGPTチャットではCodex app serverのネイティブ画像生成を利用できます。添付画像は`get_attached_media`、教材の既存画像は`get_image_reference`で参照入力を取得し、生成結果を`insert_generated_image` / `update_generated_image`で承認待ち提案へ変換します。承認・却下・Undoは通常の提案と同じ経路です。

`item/completed`の`imageGeneration`結果をElectronでrun/thread/turn/itemごとに取り込みます。元画像は`data/ai-generated-images`に保持し、チャット履歴には512px以下のサムネイルとID参照だけを保存します。拡大時はIPCから元画像を読みます。生成結果は1runにつき8枚、1枚20MiB・最大辺8192px・32Mピクセルまで。教材への提案は既存の画像上限（1枚2MiB・2500万画素、提案全体8MiB）に従い、超過時はプレビューを残して挿入エラーを返します。PNG/JPEG/WebPの実データを検証し、ネイティブデコーダーの異常が本体へ波及しないよう子プロセスでデコードします。

画像の登録は直列化し、turn完了後に取り込みを待ってから、未完の配置提案を1回だけ継続します。生成失敗を自動再試行しません。キャンセル後の通知は捨て、キャンセルしたrunの生成結果を削除します。正常終了したrunの原画像はチャットの再表示用に保持します。提案・承認済みSigmaDocには元画像のdata URLを埋め込むため、Codexの一時生成ファイルには依存しません。教材の直接書き込みや他エージェントの起動制限は維持します。

ローカルCLI 0.153.4のスキーマで`imageGeneration`の`status` / `result` / `savedPath` / `failure`を確認しています。実際の利用可否はCLI・選択モデル・ChatGPTアカウントにも依存し、利用できない場合はチャットで説明します。
