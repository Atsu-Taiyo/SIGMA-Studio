# Software Factoryの運用

GitHub Actionsを起点に、類似OSSの調査、根拠のある小さな改善、独立レビュー、Draft PR作成を毎日回します。
実行環境はGitHub-hosted runnerです。MacやCodexデスクトップの起動には依存しません。

## 実行する仕事

| workflow | 起動 | 成果 |
| --- | --- | --- |
| Software Factory daily | 毎日06:00（Asia/Tokyo）または手動 | 改善Draft PR、調査・新機能・大規模移行の提案Issue、または変更なし |
| Software Factory PR review | Checks完了後または保守者がPR番号を指定 | 最新headに対するAIレビュー。GitHubの承認操作は行わない |
| Software Factory health | 1日3回または手動 | 36時間以内の検証済みAI実行を確認し、停止時だけ運用Issueを作成・更新。復旧で閉じる |

Actionsのscheduleは正確な時刻の実行を保証せず、遅延・実行漏れや、公開repoの長期非活動による停止があります。
healthもGitHub Actions上の監視なので、GitHub全体の停止を独立に検出するものではありません。

日次処理は新しいFactory PRを1回につき最大1件、同時に未完了のFactory PRを最大2件まで作ります。
既存のtopicと同じ課題や同一候補の再実行は重複提出しません。改善の根拠がなければ投稿しません。
依存更新は既存Dependabot PRをレビューし、manifest・lockfileの自動変更は初期運用では提案にします。

最初に扱う品質マップは、保存・終了・再起動、AI承認と打鍵・Undo、共同編集の切断・復帰、数式・図・段組みとPDF一致です。
テスト・CI・性能の数値は対象commitと検証環境を記録し、未実行・skip・未計測は区別します。
API障害や検証失敗はActionsの失敗として残し、無限に修正を繰り返しません。

## 認証と有効化

初期状態では `SIGMA_FACTORY_ENABLED` を設定せず、自動のAI呼び出しを開始しません。
専用の認証と利用予算を用意し、[Actions Secrets](https://github.com/Atsu-Taiyo/SIGMA-Studio/settings/secrets/actions)に次を登録します。
値はチャット、ソース、Issue、PR、ログへ貼らないでください。

- `OPENAI_API_KEY`: Factory用のOpenAI APIキー。API利用は別途課金されます。
- `SIGMA_FACTORY_GITHUB_TOKEN`: このrepoだけを対象にした専用のGitHub App tokenまたはfine-grained PAT。
  Contents、Pull requests、Issuesの読み書き権限が必要です。ActionsやWorkflowsの書き込み、管理権限、ブランチ保護のbypassは与えません。
  このtokenで提出するため、作成したPRに通常のChecksが起動します。`GITHUB_TOKEN`による投稿への置換は行いません。
  tokenが失効した場合はSecretを更新します。GitHub Appを使う場合は有効期間内のtoken発行を別途組み込む必要があります。

AIキーは公式Codex ActionのResponses API proxyに渡し、`drop-sudo`を使います。
GitHubの書き込みtokenは投稿専用jobにだけ渡し、AI job、検証job、PRのコードには渡しません。
この運用のために配布・署名・Store・バックエンドのSecretを追加公開しません。

1. このworkflowをmainへ取り込みます。
2. `Software Factory daily` を `mode=readiness` で手動実行し、設定の不足を確認します。
3. `mode=improve` で初回実行し、調査→候補→別環境の検証→独立レビュー→Draft PRまたは提案Issueを確認します。
4. 作成されたPRの通常Checksまで確認します。認証なしのreadiness成功、ローカルfixture、構文検査はこの実行の代替にはなりません。
5. [Actions Variables](https://github.com/Atsu-Taiyo/SIGMA-Studio/settings/variables/actions)に `SIGMA_FACTORY_ENABLED=true` を登録します。
6. Codexデスクトップに登録したローカルの日次Factoryを停止し、二重実行を防ぎます。

手動の起動例（秘密情報は引数へ入れません）:

```sh
gh workflow run software-factory.yml -f mode=readiness
gh workflow run software-factory.yml -f mode=improve
gh workflow run software-factory-review.yml -f pull_request=123
```

モデルはCLIの既定を使います。変更が必要なときは有効なモデルを確認して `SIGMA_FACTORY_MODEL` を設定します。
独自のGitHub App botを使う場合は、`SIGMA_FACTORY_REVIEW_BOTS` に `dependabot[bot],your-app[bot]` のように許可するbotを列挙します。
Codex CLIはworkflowで版を固定し、更新はFactory自身の変更としてレビューします。
jobとAI stepに時間制限がありますが、これは金額の上限ではありません。API側の利用予算・使用量も別途管理します。
停止は `SIGMA_FACTORY_ENABLED=false` で行います。実行中jobを止める場合はActions上でキャンセルします。

## 変更とレビューの境界

AIは最新mainから作業し、参照した外部OSSのURL・コミットまたは版・ライセンス上の扱い・採用と見送りの理由を残します。
大規模な構造変更、新機能、保存形式、依存、Factory自身の変更は先に提案します。
小さなコード変更は20ファイル・1000行・512KiBまでとし、アプリと公開パッケージのsrc・テスト、一部docsに限定します。
CI、Factory、合格条件、方針文書、manifest・lockfile、symlink・実行属性・binary・renameは自動候補から除外します。
テストを削って通す変更は受け付けません。

候補を作ったAIとは別のjobで、クリーンな同一baseへpatchを検査・適用し、変更があれば型・lint・単体テストを実行します。
独立したAIレビューは元のソースと候補差分を読み、変更内容のdigestを返します。
投稿jobでdigest、変更範囲、最新main、重複、未解決の指摘を再確認してからDraft PRを作ります。
AIが報告した検証と、検証job・PRのCI結果は区別します。実Electronや対応OS、PDF、共有サービスが未確認なら明記します。
PR更新後は古いheadのレビューを投稿しません。同じheadへのレビューは重複投稿しません。

`workflow_run`で起動するレビューはmainのworkflow・指示・補助コードだけを読みます。
PRのコードやartifactをcheckout・実行せず、GitHub APIから取得した差分をデータとして渡します。
同じrepo内のブランチと保守者のPRを自動レビューし、それ以外の外部投稿者のPRは保守者が手動起動したときにレビューします。
公開PRによるAI費用の無制限な発生を避けます。
大きな差分やbinaryの省略はレビューへ渡し、全体確認済みと扱いません。

自動マージ・配布・署名・Store提出はこの初期運用には含みません。
mainはRequired CIと既存の必須check、最新mainとの検証、PR経由、bypassなしを維持します。
Factoryの修正でも条件を弱めません。運用Issue、PR、Actions成果物が継続状態であり、このチャットに依存しません。

実装の入口は `.github/software-factory/`、契約テストは `scripts/software-factory.test.mjs` です。

```sh
node --test scripts/software-factory.test.mjs
actionlint .github/workflows/software-factory*.yml
```

参考: [Codex GitHub Action](https://learn.chatgpt.com/docs/github-action)、[GitHub schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)。
