# 内蔵AI (SIGMA AI)

利用者が Claude・ChatGPT・Antigravity のアカウントや CLI を用意しなくても、アプリだけで AI による編集ができるようにする仕組みです。既存の3つのプロバイダはそのまま残り、チャットの入力欄から切り替えられます。

## 使える利用者

内蔵AIは **Pro プラン (試用期間を含む)** の利用者だけが使えます。中継の利用料はこちらの負担だからです。判定は共有の上限やプランの画面と同じ `/catalog/capabilities` の `plan` で、main プロセス (`DshHarnessClient` の `entitled`) が実行のたびに確かめます (結果は 1 分覚えます)。サインインしていない・確かめられないときは使えない側に倒し、チャットには Pro プランの案内を出します。利用者自身の Claude・ChatGPT・Antigravity はプランにかかわらず使えます。

開発中のビルド (`app.isPackaged` が false) では確かめません。

これはアプリ側の入口です。**中継はまだプランを見ていません** (共有トークンだけ)。配布物からトークンを取り出せば中継を直接呼べるので、公開の前に、中継でサインインのトークンとプランを検証するようにしてください (下の「認証の限界」)。

## 構成

```text
チャット (renderer)
  └ ai-edit:run ─ Electron main
       └ electron/sigma-edit.ts        共有ランナーに乗せる (プロンプト・提案の数え方・目視確認ループは他と同じ)
            └ electron/dsh-harness-client.ts
                 └ 本物の Node ─ apps/desktop/dsh-runtime/bridge.mjs
                      └ DeepSeek Harness (dsh) ── sdk-minimal プロファイル + run ごとの構成
                           ├ モデル: 中継 (apps/web/ai-gateway) → OpenRouter → DeepSeek
                           └ 道具: MCP サーバー sigma-studio-local と skill ツールだけ
```

- **エージェント**: [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) を公式の TypeScript SDK (`@deepseek-ai/dsh-sdk-client`) から動かします。版は `0.2.1-rc.5` に固定しています。dsh はまだ開発者プレビューで正式版が無く、0.2.1 系の最後の RC を選びました (0.2.2 系は RC を出し続けている途中)。版を上げるときは `apps/desktop/dsh-runtime/package.json` と `SIGMA_AI_DSH_VERSION` を一緒に変え、`tests/electron/sigma-ai.spec.ts` を通します。
- **モデル**: `deepseek/deepseek-v4.1-flash-1017` (OpenRouter の ID)。アプリ側 (`SIGMA_AI_MODEL`) と中継の許可リスト (`ALLOWED_MODELS`) を揃えます。
- **道具**: dsh 既定のシェル・ファイル・作業ディレクトリのツールは構成で外し、教材の MCP ツール (`mcp__sigma-studio-local__*`) と `skill` ツール (公式スキル・利用者のスキルを読む) だけを持たせます。編集は他のプロバイダと同じく承認待ちの提案になります。
- **会話の継続**: dsh のセッション ID を会話に持たせ、続きの依頼で履歴を引き継ぎます。履歴は userData の `data/sigma-ai/dsh-home` にあります。
- **中断**: dsh に turn 単位の中断は無いので、橋渡しプロセスごと終了させます。準備中 (子プロセスを起こす前) に届いた中断も覚えておき、モデルへ送る前に止めます。橋渡しが dsh を畳み終えるまで 15 秒待ってから強制終了し、アプリの終了時もそれを待ちます。
- **応答が止まったとき**: 橋渡しから 10 分何も届かなければ、その実行を打ち切って構成ファイルを片付けます。
- **応答の表示**: dsh の SDK は文字単位のストリームを出さず、1ステップぶんの本文をまとめて通知します。チャットにはステップごとに本文とツールの実行が出ます。

## 実行環境を分けている理由

dsh は 600 近いパッケージ (展開して 357MB) を持ち、Node の内部モジュールへ触るネイティブ部品を含みます。

- アプリ本体の `package-lock.json` と依存監査に混ぜないよう、`apps/desktop/dsh-runtime` に独自のマニフェストとロックを置きます (workspace には入れていません)。
- dsh の Office スキルが引き込む LibreOffice 一式 (約 150MB と `fontkit`) は、内蔵AIが使わないので、空の差し替え (`dsh-runtime/stubs/libreoffice-kit`) に置き換えています (`package.json` の `overrides`)。このリポジトリは `fontkit` への依存を持てません (`scripts/audit-private-conversion.mjs`)。
- その部品は対応する実行環境が固定されていて、**Electron 内蔵の Node では起動できません** (Electron 45.2.3 で確認)。橋渡し (`bridge.mjs`) と dsh は本物の Node (24.9 以上) で動かします。

Node は次の順で探します: `SIGMA_STUDIO_NODE_BIN` → `dsh-runtime/node/bin/node` (同梱する場合の置き場所) → `PATH` の `node`。`npm run electron:dev` は開発スクリプトを動かしている Node を自動で渡します。

**配布物への同梱はまだ行っていません。** `electron-builder` の設定は変えていないので、インストーラーに dsh と Node は入らず、配布版では「SIGMA AIを利用できません」と表示されます (他のAIは使えます)。同梱する場合は `dsh-runtime` (と Node) を `extraResources` へ足します。実測 (macOS arm64) は dsh が 357MB、Node 本体が 117MB です。別に判断してください。

## 開発での使い方

1. `npm run sigma-ai:runtime` で dsh の実行環境を入れます (初回と版を変えたとき)。
2. リポジトリ直下に `.env.sigma-ai.local` を作り、`SIGMA_AI_GATEWAY_URL` (中継の URL) と `SIGMA_AI_GATEWAY_TOKEN` (共有トークン) を書きます。このファイルは git に入りません。
3. `mise exec -- npm run electron:dev` で起動します。

2つの値が無いと内蔵AIは使えず、チャットに理由が出ます。

## 中継 (apps/web/ai-gateway)

アプリは OpenRouter の鍵を持たず、OpenAI Chat Completions 互換のこの中継へ投げます。本体 (`gateway.mjs`) は Web 標準の Request/Response だけで書いてあり、Supabase Edge Function と Cloudflare Worker のどちらにも置けます。

- `Authorization: Bearer <GATEWAY_TOKEN>` が一致しない要求は 401。トークンが未設定・32バイト未満なら全拒否します。
- 許可リストに無いモデルは 400。本文は既知のフィールドだけを上流へ渡し、出力上限を切り詰めます。
- 応答 (SSE) は加工せずに流し、上流のヘッダーは持ち帰りません。
- `OPENROUTER_BASE_URL` に Cloudflare AI Gateway の OpenRouter 用 URL を入れると、記録・レート制限をそちらに任せられます (既定は OpenRouter 直)。

### 置き先 1: SIGMA の Supabase (Edge Function) — 現在の置き先

共同編集のサインインと同じ SIGMA の Supabase プロジェクト (`rhosppiepmvrpgonbzml`) に、Edge Function `sigma-ai-gateway` として置いてあります。入口 (`Deno.serve` で `handleGatewayRequest` を呼ぶ十数行) は、このリポジトリには置いていません。公開リポジトリは `supabase/` 以下のファイルを持てないためで、正本は非公開のバックエンド側に置きます。手元で試すときは、git に入らないリポジトリ直下の `supabase/functions/sigma-ai-gateway/index.ts` に置き、`MOUNT_PATH: "/sigma-ai-gateway"` を渡します (関数名つきの経路を中継の経路へ戻す)。利用者ごとのサインインはまだ見ていないので Supabase の JWT 検証は切り、共有トークンで認証します。

置き先に要るシークレット (値はリポジトリに書かない・コミットしない):

- `OPENROUTER_API_KEY` — OpenRouter の鍵
- `SIGMA_AI_GATEWAY_TOKEN` — アプリが提示する共有トークン (32バイト以上)
- `SIGMA_AI_ALLOWED_MODELS` — 任意。許可するモデル (カンマ区切り)

```sh
npm run ai-gateway:test
pnpm dlx supabase secrets set OPENROUTER_API_KEY=<鍵> SIGMA_AI_GATEWAY_TOKEN=<32バイト以上の乱数> --project-ref <ref>
pnpm dlx supabase functions deploy sigma-ai-gateway --project-ref <ref> --no-verify-jwt --use-api
```

アプリ側の `SIGMA_AI_GATEWAY_URL` は `https://<ref>.supabase.co/functions/v1/sigma-ai-gateway` です。

### 置き先 2: Cloudflare Worker

```sh
npm run ai-gateway:check          # デプロイせずに設定を検証
cd apps/web
npx wrangler secret put OPENROUTER_API_KEY --config ai-gateway/wrangler.jsonc
npx wrangler secret put GATEWAY_TOKEN --config ai-gateway/wrangler.jsonc
npx wrangler deploy --config ai-gateway/wrangler.jsonc
```

### 認証の限界

共有トークンは「アプリを持っている人なら使える」鍵です。開発と身内での利用には足りますが、公開する配布物へ埋め込むと取り出せます。一般公開の前に、利用者ごとの認証 (共同編集のサインインで得たトークンを中継で検証する、など) と利用量の上限へ置き換えてください。OpenRouter 側でも、この用途専用の鍵に利用上限を付けておくと被害を抑えられます。

## 確認

- `apps/desktop/electron/dsh-harness-client.test.ts` — 構成の中身、状態の判定、橋渡しとのやり取り。
- `apps/desktop/tests/electron/sigma-ai.spec.ts` — 実アプリで、依頼 → dsh → MCP で教材を読む → SVG 図の提案 → 承認 → 保存。モデルの応答だけを偽の中継の台本で決め、dsh・MCP・提案の記録は本物を使います。
- `apps/web/ai-gateway/gateway.test.mjs` — 中継の認証・許可リスト・転送。
- `tests/electron/sigma-ai.spec.ts` の `live:` — 本物の中継と本物の DeepSeek で、枠の描画 (道具なしの問い合わせ)・図の挿入・本文の書き換え・図形への変換を、提案 → 適用 → 保存まで通します。料金がかかるので `SIGMA_AI_LIVE=1` と中継の URL・トークンを渡したときだけ動きます。
- 同じファイルの「concurrent edit」— AI が読んだ後・提案した後に人が同じ段落を直しても、承認後に両方が残ること。

## ほかのAIとの違い

チャットでの編集 (提案・承認・目視確認ループ・スキル・添付画像・会話の継続・中断・人の編集との合成) は、ほかのAIと同じ経路です。コメントの `@sigma`、枠の描画、スキルの下書き、作風の要約も内蔵AIで動きます (道具を持たせない 1 回の問い合わせ)。

内蔵AIに無いもの:

- **Web 検索** — dsh に検索の道具を足していません。設定がオンでも検索しません。
- **モデルと思考の深さの選択** — モデルは 1 つに固定で、思考の深さは送っていません。
- **PDF の本文への直接添付** — Claude は PDF をそのまま読みますが、内蔵AIは Codex と同じく `get_attached_media` でページを画像として読みます。
- **画像の生成** — Codex だけの機能です。
- **コメントの `@ai`** — 従来どおり ChatGPT へ行きます (配布版にはまだ内蔵AIが入っていないため)。
- **設定画面の項目** — 中継の URL とトークンは環境変数だけで渡します。状態は自動では更新されず、「再確認」で読み直します。
- **スキルの置き場所** — Codex と同じ場所 (`.agents/skills`) を共用します。内蔵AIだけにスキルを出し分けることはできません。
