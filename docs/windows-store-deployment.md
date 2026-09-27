# Microsoft Storeへの提出と審査

`.github/workflows/windows-store.yml` は **既に作成されたStore用AppX** を使い、
Partner Center APIへの接続確認、アップロード、審査提出、審査・公開状態の取得を行います。
Windowsのビルドは行いません。通常のNSISインストーラを配布する `release.yml` とは別です。

## 公開情報と非公開情報

| 情報 | 保存先・扱い |
| --- | --- |
| 提出スクリプト、workflow、手順、Secretの名前 | 公開リポジトリ |
| Tenant ID、Client ID、Client secret | GitHub Environment `windows-store` のSecrets |
| Store ID、Package Identity Name、Publisher | 同EnvironmentのSecrets。コードに実値を書かない |
| 審査員向けの補足・テストアカウント情報 | `WINDOWS_STORE_CERTIFICATION_NOTES` Secret、または既存のPartner Center審査メモ |
| 説明文、スクリーンショット、価格、公開リリースノート | Partner Centerの既存公開情報を引き継ぐ |
| OAuthアクセストークン、SASアップロードURL、API応答全体 | 実行プロセスのメモリのみ。ログ・artifact・キャッシュへ保存しない |
| 提出対象AppX、SHA-256 | GitHub Releaseと一時runnerディレクトリ。配布可能な内容だけを含める |

GitHubの **Secretsに保存することと、配布アプリで秘密にできることは別です**。
Storeのパッケージ識別情報はmanifestから読める公開識別子です。
共同編集の公開URLやSupabase anon/publishable keyも既存仕様どおり配布物から読めます。
Client secret、service-roleキー、審査用ログイン情報をアプリのビルド環境や
`NEXT_PUBLIC_*` に渡してはいけません。本workflowは認証Secretsを提出stepだけに渡します。

公開Actionsログには、状態名とエラー・警告の件数だけを出します。
APIエラー本文、審査レポートURL、Store内部ID、審査メモは出しません。
Microsoftの審査詳細は認証済みPartner Centerで確認します。
例外traceback、HTTPデバッグ、`set -x`、`printenv`、API応答のartifact化は追加しないでください。

## 初回だけ必要な設定

1. Partner CenterのWindows開発者アカウントを有効にし、対象アプリを登録します。
   年齢区分、プライバシーポリシー、価格、公開地域、説明文、スクリーンショット、
   実装に合った権限・課金申告を設定します。この自動化は既存公開版を更新する方式なので、
   **最初の提出と公開はPartner Centerで完了**させてください。
2. Partner CenterにMicrosoft Entraディレクトリを関連付け、提出専用のEntraアプリを関連付けます。
   MicrosoftのAPI手順で指定されたManagerロールを付与します。個人のMicrosoftパスワードを
   Actionsへ登録しないでください。権限の適用範囲・有効期限はアカウント管理者が確認します。
3. GitHub Settings → Environmentsに `windows-store` を作り、deploy可能なrefを
   `main` と運用する `v*` タグに限定します。タグ作成・workflow変更権限も管理します。
   Environmentを指定するだけでは保護ルールは作成されません。
   初回設定中は必要に応じてrequired reviewerを設定し、自動化対象の権限を確認します。
4. 次のSecretsをEnvironmentに登録します。値はチャット・ソース・issueへ貼らず、
   GitHubのSecrets画面か `gh secret set NAME --repo OWNER/REPO --env windows-store`
   の対話入力を使います。実値を `--body` 引数へ書かないでください。

| Secret名 | 値の取得元 |
| --- | --- |
| `WINDOWS_STORE_TENANT_ID` | 関連付けたEntraディレクトリ |
| `WINDOWS_STORE_CLIENT_ID` | 提出専用Entraアプリ |
| `WINDOWS_STORE_CLIENT_SECRET` | そのアプリの有効なクライアントキー |
| `WINDOWS_STORE_APPLICATION_ID` | Partner Centerの12文字のStore ID |
| `WINDOWS_STORE_IDENTITY_NAME` | Partner CenterのPackage/Identity/Name |
| `WINDOWS_STORE_PUBLISHER` | Partner CenterのPackage/Identity/Publisher |
| `WINDOWS_STORE_CERTIFICATION_NOTES`（任意） | 審査員向けメモ。未設定なら前回を維持 |

キー更新時はSecretsを更新し、後述の `preflight` で新しいキーを確認した後に古いキーを失効させます。
生成されたアクセストークンをSecretへ登録する必要はありません。

## 提出対象

対象は単一x64 AppXの既存アプリです。Releaseのタグが `v1.2.3` なら、
アセット名は `Sigma-Studio-Store-1.2.3-x64.appx`、manifestのバージョンは `1.2.3.0` です。
SHA-256、Name、Publisher、アーキテクチャ、バージョンを照合してから提出します。
既存の複数パッケージ、ARM/x86、段階公開、必須更新は自動置換せず停止します。
2 GiBを超えるパッケージやMSIX bundleはこの処理の対象外です。

Storeはバージョンの先頭が0のパッケージを受け付けません。
現在のアプリ版 `0.500.0` をそのままAppXにした `0.500.0.0` は提出不可です。
初回Store公開に使うバージョンを決め、対応するタグとAppXを準備する必要があります。
このworkflowはバージョン変更やWindowsビルドを自動実行しません。

提出対象はWindows実機で起動、保存・再読込、AI/MCP、ファイル関連付けを確認し、
配布内容検査を通したAppXを使います。通常の `.exe` は本API経路へ流用できません。
MSI/EXEのストア提出には別のAPIと要件があるため、既存AppX設定に合わせてここでは扱いません。
既存ReleaseへAppXを追加するとその公開範囲を引き継ぐため、非公開内容を含めないでください。

## 実行

GitHub Actions → **Microsoft Store deployment** → Run workflow、branchは `main` を選びます。

| operation | 動作 |
| --- | --- |
| `preflight`（既定） | 認証、対象アプリ識別情報、公開済み基準版、進行中提出の有無を確認。書き込みなし |
| `submit` | 指定ReleaseのAppX取得・検証 → 前回公開版から下書き作成 → パッケージ置換 → ZIPアップロード → commit → 提出受付確認 |
| `status` | 進行中提出を優先し、なければ前回公開版の状態を取得。書き込みなし |

手動 `submit` は `release_tag` と検証済みAppXの `package_sha256` が必須です。
`publish_mode=Manual` は **審査へ提出し、審査後の公開を保留**します。
`Immediate` は審査通過後にストア公開まで進めます。公開保留の解除はPartner Centerで行います。
descriptionやreleaseNotesは前回のままなので、機能・申告・掲載内容が変わるリリースでは
自動提出を使う前に掲載情報の更新を計画してください。

最初は `preflight`、次に検証済みAppXで `submit` を実行します。
実際のAPI接続・提出・審査通過はローカルテストやビルド成功とは別に確認します。

## 継続運用の自動化

接続と初回提出を確認してから、GitHubの **Repository Variables** を設定します。
これらは公開可能な動作スイッチで、資格情報は入れません。

| Variable名 | 設定値・動作 |
| --- | --- |
| `WINDOWS_STORE_AUTO_SUBMIT` | `true` の場合、GitHub Releaseの公開時に審査提出。未設定なら実行しない |
| `WINDOWS_STORE_PUBLISH_MODE` | 自動提出時は `Manual`（既定）または `Immediate` |
| `WINDOWS_STORE_MONITOR_ENABLED` | `true` の場合、6時間ごとに審査状態を取得。未設定なら実行しない |

自動提出では公開イベント発生時にAppXアセットとGitHubのSHA-256 digestが必要です。
**下書きReleaseへ検証済みAppXを追加してからReleaseを公開**します。
公開後に追加した場合は手動 `submit` を使用してください。ビルド完了だけでは審査提出しません。
失敗状態はActionsの失敗にし、通常のGitHub通知設定で検知できます。
審査結果が出るまでジョブを占有し続けず、次回の `status` で進捗を確認します。

## 結果と復旧

- `CommitStarted`: commit処理中。受付は未確認。
- `PreProcessing`: 提出受付済み。審査通過は未確認。
- `Certification`: 審査中。
- `PendingPublication`: 審査完了・公開保留。
- `Published`: 公開完了。
- `*Failed` / `Canceled` / エラーあり: Actions失敗。詳細はPartner Centerで確認。

commit後は最大約20分、30秒間隔で受付を確認します。時間切れを成功とは扱いません。
タイムアウトや通信失敗の後は、必ず `status` とPartner Centerを確認してください。
POSTを自動再試行せず、残った下書きや審査中提出も自動削除しません。
同じ版・古い版の再提出は拒否します。APIで作成した下書きはPartner Centerの編集画面で
変更せず、障害調査後にAPIで復旧するか、明示的に破棄して新しい提出を作る方針を決めます。
本workflowには無条件削除・commitだけの再実行機能はありません。

ローカル確認（通信・認証情報なし）:

```sh
python3 -m unittest discover -s scripts -p windows_store_test.py
actionlint .github/workflows/windows-store.yml .github/workflows/checks.yml
```

## Microsoftの公式仕様

- [APIの前提条件とEntra認証](https://learn.microsoft.com/en-us/windows/uwp/monetize/create-and-manage-submissions-using-windows-store-services)
- [下書き作成・更新・アップロード・commit](https://learn.microsoft.com/en-us/windows/uwp/monetize/manage-app-submissions)
- [審査状態の取得](https://learn.microsoft.com/en-us/windows/uwp/monetize/get-status-for-an-app-submission)
- [AppX/MSIXパッケージ要件とバージョン](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements)
