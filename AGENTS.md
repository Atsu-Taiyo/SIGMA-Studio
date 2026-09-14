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

## デスクトップ版の開発・動作確認

- Sigma Studioの開発・動作確認は、Electronのデスクトップアプリを基本とする。ブラウザ表示の確認だけでは、デスクトップ版の動作確認完了としない。
- 通常の画面開発では、Electronのウィンドウ内でローカルのNext.js開発サーバーを読み込み、React/CSSの変更をFast Refresh / HMRで反映する構成を使う。ファイル保存・AI・ローカルMCPはElectronの実際のbridgeを通す。
- Electronのmain / preloadを変更した場合は、再ビルドとアプリの再起動で反映する。画面のホットリロードとプロセスの再起動を区別し、未保存の教材を失わないようにする。
- 開発サーバーへの接続とファイル監視は開発時に限定し、配布版の静的ファイル読み込み・ビルド処理・セキュリティ境界を維持する。
- ホットリロード環境が未整備なら、デスクトップ開発環境を整える際に起動スクリプトと読み込み先の切り替えを実装する。既存サーバーのポートと対象リポジトリを確認し、起動したElectronがこのチェックアウトの画面を読み込んでいることを検証する。
- 動作確認では、実際にソース変更がElectronの画面へ反映されることを確認する。main / preloadの監視を実装した場合は自動再ビルド・再起動も確認する。保存・AI・MCP等は変更に関係する機能を実アプリで検証し、未確認の項目を区別して報告する。

`mise exec -- npm run electron:dev` でホットリロード対応のデスクトップ版を起動する。開発データは既定で `tmp/desktop-dev-profile` に分離する。静的ビルドの再現確認には `npm run electron:preview` と複製した `SIGMA_STUDIO_USER_DATA_DIR` を使う。手順と終了・再起動の扱いは `CONTRIBUTING.md` を参照し、作業開始時に現在の起動処理も確認する。
