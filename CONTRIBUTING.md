# 開発と検証

Node.js 24 と npm を使います。依存はリポジトリのルートでインストールしてください。

```sh
npm ci
npm run dev
```

文書の正本は SigmaDoc JSON です。編集DOM、Tiptap JSON、SVGは派生表現として扱います。
責務と依存方向は [Architecture](docs/architecture.md)、過去の不具合から得た制約は
[MISS.md](MISS.md) を参照してください。見た目・操作・保存形式の変更と、内部構造の整理は、
レビューでそれぞれの影響が分かるように説明します。
変更先の案内は [AGENTS.md](AGENTS.md) にあります。PDFを変更するときは
[PDFの描画・出力契約](docs/pdf-parity-architecture.md) を確認してください。

## 変更を検証する

まず変更した責務のテストを実行します。追加引数は対象workspaceへ直接渡します。

```sh
npm --workspace @sigma-studio/desktop run test -- src/features/drawing/graph3d-vector.test.ts
```

全体の基本チェックは次の通りです。初回の型検査ではNext.jsの生成型も用意します。

```sh
npm exec --workspace @sigma-studio/desktop -- next typegen
npm run typecheck
npm run lint
npm run test
npm run test:scripts
npm run version:check
npm run build
npm run electron:build
```

単体テストには純粋関数の入出力、実ストアの一時ディレクトリを使った永続化、DOMでのイベント配線、
依存境界の検査があります。テストのためだけに本番と別の処理や設定を複製せず、実際の境界へ入力します。
既存の振る舞いを整理するときは、変更前の失敗と変更による失敗を分けて確認してください。
依存境界の検査には `apps/desktop/tests/helpers/source-dependencies.ts` の共有AST解析を使います。
相対pathとaliasの解決、再export、動的importも検査対象です。新しい正規表現scannerを増やさず、
境界の変更は対応するarchitectureテストにも反映します。

ブラウザでしか分からない選択・フォーカス・貼り付け・ページ配置は該当するPlaywrightテストを実行します。

```sh
npm exec --workspace @sigma-studio/desktop -- playwright install chromium
npm --workspace @sigma-studio/desktop run test:e2e -- tests/e2e/body-block-paste.spec.ts
```

通常はテスト設定が開発サーバーを起動します。別のサーバーを検査する場合は
`SIGMA_STUDIO_E2E_BASE_URL` にURLを指定します。永続化や印刷を変えた場合は、
表示だけでなく保存されたSigmaDoc、再読込、印刷結果まで確認します。

## 公開パッケージを検証する

EditorはViewerの生成型を使うため、先に両パッケージをビルドします。

```sh
npm run editor:build
npm run viewer:typecheck
npm run editor:typecheck
npm run viewer:test
npm --workspace @sigma-studio/editor run test
npm --workspace @sigma-studio/editor-react18-example run build
npm exec --workspace @sigma-studio/desktop -- playwright install chromium
npm run test:public-browser
npm pack --workspace @sigma-studio/viewer --workspace @sigma-studio/editor --dry-run --ignore-scripts
```

各パッケージの `scripts/build-options.mjs` が本番バンドルの設定を所有します。
`package-boundary.test.ts` は同じ設定でメモリ上にビルドし、内部実装の混入と公開型の独立性を検査します。
`public-types.test.ts` は生成された宣言と実際のpackage exportsを使い、BundlerとNodeNextの利用側を型検査します。
CSS・フォント・画像の扱いも本番設定を通します。`dist` は生成物なので直接編集しません。

`test:public-browser` はビルド済みのReact 18 exampleを起動し、Viewerの表示切替、本文編集、
ホストによる保存、再読込を確認します。外部サービスや公開サイトには書き込みません。
`test:scripts` は実際のversion CLIを一時ディレクトリで実行し、manifest同期とcheckの読取専用性を検査します。

Pull Requestとmainへのpushでは [Checks](.github/workflows/checks.yml) が基本チェックと公開パッケージの
ビルド・契約テストを実行します。保存ロックはmacOS・Windows・Linuxの別jobで実プロセスの競合・終了を検査し、
配布に使うElectronでもネイティブ依存を読み込みます。手元では
`npm --workspace @sigma-studio/desktop run test -- file-lock`で対象テストを実行できます。
ブラウザの確認範囲と結果はPRに記載してください。
CI定義の検査、GitHub上の実行、同梱Electronでのネイティブ機能確認、公開版・インストール済みアプリの確認は
それぞれ分けて報告します。保存ロックを変更した場合の配布物検査と対応OSの確認も下記の配布手順に従います。
リリース手順は [配布手順](docs/distribution.md) にあります。
