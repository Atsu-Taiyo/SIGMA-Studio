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
