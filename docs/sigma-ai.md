# 内蔵AI (SIGMA AI)

利用者が Claude・ChatGPT・Antigravity のアカウントや CLI を用意しなくても、アプリだけで AI による編集ができるようにする仕組みです。既存の3つのプロバイダはそのまま残り、チャットの入力欄から切り替えられます。

## 使える利用者

内蔵AIは **Pro プラン (試用期間を含む)** の利用者だけが使えます。中継の利用料はこちらの負担だからです。判定は共有の上限やプランの画面と同じ `/catalog/capabilities` の `plan` で、main プロセス (`DshHarnessClient` の `entitled`) が実行のたびに確かめます (結果は 1 分覚えます)。サインインしていない・確かめられないときは使えない側に倒し、チャットには Pro プランの案内を出します。利用者自身の Claude・ChatGPT・Antigravity はプランにかかわらず使えます。

配布版は、Electron main のローカル中継からサインイン情報をクラウド中継に送ります。DSHが受け取るのはループバック限定の実行ごとの鍵です。サインアウトや利用者の切り替えで中継を停止します。クラウド中継は各要求で共有サービスにサインインとPro資格を確認します。

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

- `apps/desktop/dsh-runtime` は pnpm ワークスペース外に置き、専用の npm ロックで再現します。ルートの依存監査はこのロックを対象に含まないため、同梱前には `npm audit --prefix apps/desktop/dsh-runtime --omit=dev` で個別に確認します。
- dsh の Office スキルが引き込む LibreOffice 一式 (約 150MB と `fontkit`) は、内蔵AIが使わないので、空の差し替え (`dsh-runtime/stubs/libreoffice-kit`) に置き換えています (`package.json` の `overrides`)。このリポジトリは `fontkit` への依存を持てません (`scripts/audit-private-conversion.mjs`)。
- その部品は対応する実行環境が固定されていて、**Electron 内蔵の Node では起動できません** (Electron 45.2.3 で確認)。橋渡し (`bridge.mjs`) と dsh は本物の Node (24.9 以上) で動かします。

macOSのApple Silicon・Intel版とWindows x64版には、独立したDSHランタイムとNode 24.22.1を同梱します。ビルドはNodeの配布元とSHA-256を固定し、DSH専用ロックから対象アーキテクチャの依存を入れます。配布版では同梱のNodeを使います。開発時は `SIGMA_STUDIO_NODE_BIN`、同梱Node、`PATH` の順に探し、`pnpm run electron:dev` は自身を動かしたNodeを渡します。

同梱したライセンスと配布元は実行環境の [NOTICES.md](../apps/desktop/dsh-runtime/NOTICES.md) を参照してください。

## 開発での使い方

1. `pnpm run sigma-ai:runtime` で dsh の実行環境を入れます (初回と版を変えたとき)。
2. リポジトリ直下に `.env.sigma-ai.local` を作り、`SIGMA_AI_GATEWAY_URL` (中継の URL) と `SIGMA_AI_GATEWAY_TOKEN` (共有トークン) を書きます。このファイルは git に入りません。
3. `mise exec -- pnpm run electron:dev` で起動します。

2つの値が無いと内蔵AIは使えず、チャットに理由が出ます。

## 中継 (apps/web/ai-gateway)

配布版は既存の共有Workerに接続するCloudflare Workerを使います。中継がサインインを検証し、Proまたは有効な試用期間であることを確認します。確認できない場合はモデルへ転送しません。呼び出し頻度は利用者ごとにCloudflareの拠点単位で制限し、出力上限は32,768トークンです。

モデルはサーバーの許可リストで固定します。画像付きのメッセージとSSEはそのまま通し、上流へは中継のOpenRouter鍵だけを渡します。

```sh
pnpm run ai-gateway:test
pnpm run ai-gateway:check
cd apps/web
pnpm exec wrangler secret put OPENROUTER_API_KEY --config ai-gateway/wrangler.jsonc
pnpm exec wrangler deploy --config ai-gateway/wrangler.jsonc
```

中継には専用のOpenRouter鍵を使い、上流側にも支出上限を設定します。配布ビルドはCloudflare Workerの `/health` が認証・レート制限・上流鍵の設定を報告してから進みます。公開前に、有効なPro利用者・無料利用者の両方で実際の挙動を確かめます。旧Supabaseの共有鍵を使う試験用の経路を使っていた場合は、テストの移行後に停止し、試験用の鍵を失効させます。

### 応答の速さ (上流の事業者を固定する)

内蔵AIは 1 ステップごとに、教材ツール 67 個の定義 (約 19 万字) を含む約 7.8 万トークンを送ります。OpenRouter は何も指定しないと要求ごとに別の事業者へ振るので、入力のキャッシュが効かず、最初の応答までが 1 秒から 9 秒までばらつき、料金も 1 ステップあたり 25 倍の差が出ます。1 つの依頼は 3〜6 ステップなので、これが待ち時間の大半でした。

中継の `PROVIDER_ROUTING` (Supabase では `SIGMA_AI_PROVIDER_ROUTING`) に、速くてキャッシュの効く事業者を先頭に並べます。利用者の要求からは受け取りません。

```json
{"order":["Morph","InferenceNet"],"ignore":["Reka"],"allow_fallbacks":true}
```

2026-11-21 に、実際の 1 ステップ目の入力 (約 7.8 万トークン) で測った値です。事業者の顔ぶれと速さは変わるので、遅くなったら測り直してください。

| 設定 | 最初の応答まで | 備考 |
|---|---|---|
| 指定なし | 1.2〜8.6 秒 | 毎回別の事業者。キャッシュはほぼ効かない |
| `order: ["Morph"]` | 1.1〜1.8 秒 | キャッシュが無い回も 1.7 秒 |
| `sort: "latency"` (InferenceNet) | 0.8〜1.1 秒 | 最初の 1 回だけ 7.7 秒 |
| `sort: "throughput"` (Reka) | 3.8〜10.9 秒 | 同じ入力を約 60 万トークンと数え、料金が 1 回 0.18 ドルになる。使わない |

この設定で、「直角三角形の図を入れて」という依頼は、チャットから送って実行が終わるまで 27〜35 秒になりました (5 回。設定前は同じ依頼で 30 秒〜4 分)。内訳は、起動 4〜5 秒、教材とスキルの読み取り 2〜3 秒、図を書く 15〜18 秒、報告 5〜6 秒です。思考の量を減らす指定 (`reasoning.effort`) はこのモデルでは効きませんでした。

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
- **コメントの `@ai`** — ChatGPT へ送ります。内蔵AIへの言及には `@sigma` を使います。
- **設定画面の項目** — 開発時の中継URLと試験用トークンは環境変数で設定します。配布版は共同編集のサインインを使います。
- **スキルの置き場所** — Codex と同じ場所 (`.agents/skills`) を共用します。内蔵AIだけにスキルを出し分けることはできません。
