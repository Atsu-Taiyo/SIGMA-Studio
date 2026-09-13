# 配布とパッケージ

ソースとデスクトップ配布物の公開先は `Atsu-Taiyo/SIGMA-Studio` です。

## ローカル検証

`CONTRIBUTING.md` のWeb・Electron・公開パッケージ検証を先に実行します。
インストーラの作成には対象OSのツールと署名環境が必要です。署名素材や資格情報をソースに含めないでください。

- Electronの準備: `npm run electron:build`
- 公開パッケージ: `npm run editor:build`
- 配布内容の確認: `npm pack --workspace @sigma-studio/viewer --workspace @sigma-studio/editor --dry-run --ignore-scripts`

これらのコマンドは配布物を公開しません。

## ファイルロック

保存処理はOSのネイティブロックを使います。永続的なmutexファイルを削除しないでください。
実プロセスの競合・異常終了・復旧をテストし、配布に用いるElectronでネイティブ依存が読み込めることを確認します。

```sh
npm --workspace @sigma-studio/desktop run test -- file-lock
npm exec --workspace @sigma-studio/desktop -- cross-env ELECTRON_RUN_AS_NODE=1 electron scripts/check-native-lock.cjs
```

OSごとの検証、ビルド成功、署名・インストール後の動作確認は別々に記録してください。

## リリース運用

`v*` タグでReleaseワークフローが起動し、macOS/Windowsの配布物を下書きReleaseへアップロードします。手動実行も対象タグを選択してください。
リリース運用を有効にする際は、署名、npmの公開元設定、バージョン、タグ、既存配布処理との重複を確認します。

インストーラと自動更新メタデータは同じバージョンのビルドから作成します。
公開前に対象コミット・検証結果・配布ファイルを確認し、公開後はインストールと更新を検証してください。
既存のタグや配布物を、ソースの移行に伴って自動的に変更・削除しないでください。

## GitHub Actionsの設定

署名用の `MAC_CSC_LINK`・`MAC_CSC_KEY_PASSWORD`、公証用の `APPLE_ID`・`APPLE_APP_SPECIFIC_PASSWORD`・`APPLE_TEAM_ID` をリポジトリSecretsに設定します。
配布物の混入検査には `RELEASE_CONTENT_RULES` を設定します。値は正規表現文字列のJSON配列で、ソースへ含めません。Releaseビルドでは設定がない場合も検査に失敗します。
同じリポジトリの下書きReleaseへのアップロードには、workflowの `contents: write` と `GITHUB_TOKEN` を使います。
署名と混入検査はインストーラのアップロード前に実行されます。全OSのビルドと配布物を確認した後、下書きを公開します。

## npmパッケージの公開準備

`publish-npm.yml` はEditorとViewerのビルド、型契約、packageテスト、React 18のブラウザ検証後、
実際のtgzを作成して検査します。`RELEASE_CONTENT_RULES` は既存の配布物検査と同じSecretで、
設定なし・不正な設定では停止します。ファイル名と内容の検査に加え、代表的な資格情報形式、
配布対象外ファイル、source map、symlink、バージョン不整合、ライセンス通知の欠落を検出します。
検査に一致した内容や検査語はログに表示しません。資格情報の検査は全Secret実値との照合ではありません。

ローカルでは上記の公開パッケージ検証後、次のコマンドで実物を検査できます。
`RELEASE_CONTENT_RULES` は手元の環境に設定し、値をソースやコマンド履歴に記録しないでください。

```sh
mkdir -p tmp/npm-packages
npm pack --workspace @sigma-studio/viewer --workspace @sigma-studio/editor --ignore-scripts --pack-destination tmp/npm-packages --json > tmp/npm-pack-result.json
node scripts/audit-npm-tarballs.mjs tmp/npm-packages
```

初回公開予定は0.469.0です。手動実行はmainを選択し、既定の `publish: false` では検証だけを行います。
後続の公開準備が整ってから `publish: true` を指定します。`v*` タグでは検証後に公開まで進むため、
運用開始前に両packageのnpm Trusted Publisherを `Atsu-Taiyo` / `SIGMA-Studio` / `publish-npm.yml` に
設定し、旧公開元のworkflowを停止してください。npm側の設定変更はGitHub Secretsの登録とは別です。
詳しくは [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) を参照してください。

公開時はOIDC対応のnpm CLIを確認し、Viewer、Editorの順に検証済みtgzを直接公開します。
workspaceのprepackによる再ビルドは行いません。既存版はスキップしますが、registryの通信障害を
「未公開」と扱わず停止します。初回手動公開のためにアプリ配布用タグを打ち直す必要はありません。
