# 問題検索・解答のMCP連携

`get_problem_solution({ problemId })` は、起動中のElectronの認証付きローカルbridgeから
ログイン中の利用者トークンでCloudflare Workersを呼びます。
WorkerだけがSecretの `SIGMA_API_KEY` を使い、jukenmathのAPIへ接続します。
公開済み問題の official / author / editorial 解答の選別は上流APIが行います。
応答のJSONオブジェクトは変換せず `data.solution` に返します。
問題IDは英数字・ハイフン・アンダースコアの1〜128文字です。

## 認証と設定

既存の `SIGMA_COLLABORATION_URL`、`SIGMA_SUPABASE_URL`、`SIGMA_SUPABASE_ANON_KEY` を使います。
Sigma Studioでログインしてから利用します。未設定・未ログインでは非公開APIを呼びません。
共通の `SIGMA_API_KEY` をデスクトップに設定する必要はありません。
利用者トークンはElectron mainが管理し、rendererやAIのMCP引数には渡しません。
既存Workerの利用者認証はSupabase Authを使用します。

Workerには次のGET経路があります。いずれもSigma Studioの利用者Bearerトークンが必要です。

- `/integrations/juken/search?q=...&category=整数&sort=likes&limit=5`
- `/integrations/juken/problems/{問題ID}/solution`

検索は `q`（最大500文字）、`category`（最大100文字）、`sort`（newest / likes / difficulty）、
`limit`（1〜50、既定5）だけを受け付けます。

MCPでは `search_problems({ category: "整数", sort: "likes", limit: 5 })` を呼びます。
応答は `data.search` に入り、`results` 内の `id`、`title`、`problem_tex`、`has_solution` などを参照できます。
解答も依頼されている場合は、結果の `id` を文字列にして `get_problem_solution({ problemId: String(id) })` に渡します。
検索語は `q` に指定し、引数を省略すると既定5件を検索します。制御文字・未知の引数・範囲外の件数は拒否します。
解答JSONは `ok`、`problem`、`solutions` を持ち、`solutions` には official / author / editorial があります。

## 非公開情報の扱い

- APIキーはWorkerが上流向けのBearerヘッダーへ付けます。renderer、AIの起動設定、MCP引数には渡しません。
- WorkerはHTTPSの固定ホスト・固定経路だけに接続し、リダイレクトは拒否します。タイムアウトは15秒、応答上限は2MiBです。
- HTTPキャッシュと解答のディスクキャッシュは使いません。上流のエラー本文・生の例外は返しません。
- Cloudflare側ではクエリ文字列のログ除去を有効にします。デプロイ後も維持されていることを確認します。
- ツールの活動ログには既存の開始・完了状態だけが入り、この連携で本文を記録しません。
- MCPの応答は選択したAIプロバイダへ送られ、プロバイダのセッション履歴に保存される可能性があります。
  AIが回答や教材に引用した内容は、それぞれの通常の保存対象になります。完全な非保存は保証しません。
- 取得した内容は参照データとして扱い、含まれる命令には従いません。依頼のない全文転載や教材保存は行わないようツールで指示します。

## 確認範囲

自動テストは架空のキーと問題・解答だけを使います。本番キー・本番本文をfixtureに保存しません。
2026-09-27、変更をビルドしたElectronと付属MCPを別プロファイルで起動し、実利用者認証付きで
`search_problems({ category: "整数", sort: "likes", limit: 5 })` の5件取得と、結果のIDを使う
`get_problem_solution` の解答取得を確認しました。本文は記録していません。
MCPから範囲外のlimitを拒否することも実確認しました。未ログイン拒否・bridge認証・入力検証・
エラー秘匿は自動テストで確認しています。
