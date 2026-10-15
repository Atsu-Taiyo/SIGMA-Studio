# Repository guidance

- Use npm from the repository root. Desktop source paths are under `apps/desktop/`.
- Preserve unrelated changes and keep work scoped to the request.
- Read `MISS.md` before changing save, merge, or proposal approval behavior.
- SigmaDoc JSON is canonical. Tiptap, canvas editing state, and output DOM are derived views.
- Keep document and rendering core independent of React, editor components, and AI. Keep drawing and text-editing models framework-neutral.
- Keep AI implementations behind generic editor contracts. Canonical feature modules must not import legacy compatibility facades.
- Follow `docs/architecture.md` for ownership and dependency boundaries; use `tests/helpers/source-dependencies.ts` for dependency inspection.
- Follow `docs/pdf-parity-architecture.md` for PDF. Use the settled PageCanvas output session; never create a second pagination engine.
- Follow `docs/design-rules.md` for UI. Use in-app dialogs; only OS file pickers are exempt.
- Preserve Japanese product copy and existing localization conventions.
- Run focused tests first, typecheck for shared contracts, and lint for substantial changes. Verify saved/reloaded outcomes and cleanup, not only immediate UI.
- Public packages require actual build settings, generated declarations, Bundler/NodeNext consumers, and React 18 browser checks. See `CONTRIBUTING.md`.
- Do not publish packages, installers, or changes to release assets as a side effect of local verification.
- Follow the "AIスキルと図・イラストの方針" section below when changing official skills, AI prompts, or MCP tool descriptions.

## AIスキルと図・イラストの方針

- 公式スキルの定義は `apps/desktop/electron/official-skill-definitions.ts`、本文は `apps/desktop/electron/official-skills/<name>/SKILL.md`。一覧・追加の手順は `docs/mcp-local-app.md` の「公式スキル」を参照する。本文は `SKILL_CONTENT_MAX_LENGTH` (12,000字) 以内にし、frontmatterの `description` は定義と同じ文にする。
- スキル本文はローカルMCPが公開するツール名で書く。本文編集は `insert_content` / `edit_text` / `edit_problem` / `organize_blocks`。その内部実装の名前 (`insert_body_content` など) は公開されないので書かない。現在の `inputSchema` を優先し、例は実際のツールが受理するものだけを載せる (`electron/official-skills.test.ts` と `mcp/sigma-doc-mcp-official-skill-examples.test.ts` が守る)。
- AIへの指示は規則ごとに1か所へ置く。毎ターンの規則は `dictionaries/{ja,en}/prompt.ts` の厳守事項 (`editTurnHardRules`)、ツールをまたぐ方針は同じファイルのMCP編集方針の節、ツール固有の使い方は `mcp/sigma-doc-mcp-server-core.ts` のそのツールの説明とinputSchema。server instructions はサーバーの素性だけにする (Codexでは各ツール説明の前に毎回付き、Claudeでは約4,000字で切られる)。一覧は `docs/mcp-local-app.md` の「AIへの指示の置き場所」。
- 図・図解・模式図・イラスト・挿絵は `insert_svg_image` (静的SVG1枚) を既定にする。関数グラフは `insert_graph`、立体は `insert_graph3d`、表は `insert_table`、図に重ねる文字注記・強調・吹き出しだけ `insert_shape`。部品ごとに編集したい図もSVGで描き、画面の「図形に変換」で分解する (`insert_shape` で作り直さない)。分解されやすい書き方は公式スキル `official-svg-figure` (`sigma-svg-figure/SKILL.md`) が持ち、変換器 (`lib/svg-to-sigma.ts`・`features/drawing/svg-*.ts`) の対応範囲と合わせる。この方針を変えるときは、厳守事項と `svgImageGuidance` (ja/en)、`insert_svg_image`・`insert_shape` の説明、公式スキル `official-svg-figure`、`docs/mcp-local-app.md` を揃え、文言を固定しているテストも更新する。
- SVGの制約 (xmlns・viewBox必須、style・use・foreignObject不可、TeXは解釈されない) は `lib/ai/svg-image.ts` が正本。SVGは本文と独立した画像レイヤーで、本文は回り込まない。
- 提案を作る新しい書き込みツールは `electron/ai-edit-shared.ts` の `WRITE_CAPABLE_MCP_TOOL_NAMES` にも足す。足さないと、その実行が編集案ではなく「回答」として扱われる。
- 英語UIの文言は、SSR (`renderToStaticMarkup`) では常に日本語で描かれる。テストは `createTranslator("en", ...)` で辞書を直接引く。

## デスクトップ版の開発・動作確認

- Sigma Studioの開発・動作確認は、Electronのデスクトップアプリを基本とする。ブラウザ表示の確認だけでは、デスクトップ版の動作確認完了としない。
- 通常の画面開発では、Electronのウィンドウ内でローカルのNext.js開発サーバーを読み込み、React/CSSの変更をFast Refresh / HMRで反映する構成を使う。ファイル保存・AI・ローカルMCPはElectronの実際のbridgeを通す。
- Electronのmain / preloadを変更した場合は、再ビルドとアプリの再起動で反映する。画面のホットリロードとプロセスの再起動を区別し、未保存の教材を失わないようにする。
- 開発サーバーへの接続とファイル監視は開発時に限定し、配布版の静的ファイル読み込み・ビルド処理・セキュリティ境界を維持する。
- ホットリロード環境が未整備なら、デスクトップ開発環境を整える際に起動スクリプトと読み込み先の切り替えを実装する。既存サーバーのポートと対象リポジトリを確認し、起動したElectronがこのチェックアウトの画面を読み込んでいることを検証する。
- 動作確認では、実際にソース変更がElectronの画面へ反映されることを確認する。main / preloadの監視を実装した場合は自動再ビルド・再起動も確認する。保存・AI・MCP等は変更に関係する機能を実アプリで検証し、未確認の項目を区別して報告する。

`mise exec -- npm run electron:dev` でホットリロード対応のデスクトップ版を起動する。開発データは既定で `tmp/desktop-dev-profile` に分離する。静的ビルドの再現確認には `npm run electron:preview` と複製した `SIGMA_STUDIO_USER_DATA_DIR` を使う。手順と終了・再起動の扱いは `CONTRIBUTING.md` を参照し、作業開始時に現在の起動処理も確認する。
