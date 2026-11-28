# 内蔵AI (SIGMA AI)

利用者が Claude・ChatGPT・Antigravity のアカウントや CLI を用意しなくても、アプリだけで AI による編集ができるようにする仕組みです。既存の3つのプロバイダはそのまま残り、チャットの入力欄から切り替えられます。

## 使える利用者

内蔵AIは **利用枠のあるプラン** の利用者だけが使えます。いまは Pro プラン (試用期間を含む) です。中継の利用料はこちらの負担なので、プランごとに 1 週間の利用枠を決め、使い切ったらその週は止めます (下の「利用枠」)。どのプランに枠があるかは中継の表が決めます。配布版の main プロセス (`DshHarnessClient` の `isEntitled`) は実行のたびに中継の `GET /v1/usage` に聞き (結果は 1 分覚えます)、中継が答えないときだけ、共有の上限やプランの画面と同じ `/catalog/capabilities` の `plan` で確かめます。サインインしていない・確かめられないときは使えない側に倒し、チャットにはプランの案内を出します。利用者自身の Claude・ChatGPT・Antigravity はプランにかかわらず使えます。

Electron main のローカル中継 (`electron/dsh-gateway-session.ts`) がサインイン情報をクラウド中継に送ります。DSHが受け取るのはループバック限定の実行ごとの鍵です。サインアウトや利用者の切り替えで中継を停止します。クラウド中継は各要求で共有サービスにサインインとプランを確認します。開発時も同じローカル中継を通し、中継のトークンを DSH へ渡しません。

## 構成

```text
チャット (renderer)
  └ ai-edit:run ─ Electron main
       └ electron/sigma-edit.ts        共有ランナーに乗せる (プロンプト・提案の数え方・目視確認ループは他と同じ)
            └ electron/dsh-harness-client.ts
                 └ 本物の Node ─ apps/desktop/dsh-runtime/bridge.mjs
                      └ DeepSeek Harness (dsh) ── sdk-minimal プロファイル + run ごとの構成
                           ├ モデル: ローカル中継 (main) → 中継 (apps/web/ai-gateway) → OpenRouter → DeepSeek
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

macOSのApple Silicon・Intel版とWindows x64版には、独立したDSHランタイムとNode 24.22.3を同梱します。ビルドはNodeの配布元とSHA-256を固定し、DSH専用ロックから対象アーキテクチャの依存を入れます。配布版では同梱のNodeを使います。開発時は `SIGMA_STUDIO_NODE_BIN`、同梱Node、`PATH` の順に探し、`pnpm run electron:dev` は自身を動かしたNodeを渡します。

同梱したライセンスと配布元は実行環境の [NOTICES.md](../apps/desktop/dsh-runtime/NOTICES.md) を参照してください。

## 開発での使い方

1. `pnpm run sigma-ai:runtime` で dsh の実行環境を入れます (初回と版を変えたとき)。
2. リポジトリ直下に `.env.sigma-ai.local` を作り、`SIGMA_AI_GATEWAY_URL` (中継の URL) と `SIGMA_AI_GATEWAY_TOKEN` (共有トークン) を書きます。このファイルは git に入りません。
3. `mise exec -- pnpm run electron:dev` で起動します。

2つの値が無いと内蔵AIは使えず、チャットに理由が出ます。

## 中継 (apps/web/ai-gateway)

配布版は既存の共有Workerに接続するCloudflare Workerを使います。中継がサインインを検証し、プランに利用枠があること・その週の枠が残っていることを確認します。確認できない場合はモデルへ転送しません。呼び出し頻度は利用者ごとにCloudflareの拠点単位で制限し、出力上限は32,768トークンです。

モデルはサーバーの許可リストで固定します。画像付きのメッセージとSSEはそのまま通し、上流へは中継のOpenRouter鍵だけを渡します。

```sh
pnpm run ai-gateway:test
pnpm run ai-gateway:check
cd apps/web
pnpm exec wrangler secret put OPENROUTER_API_KEY --config ai-gateway/wrangler.jsonc
pnpm exec wrangler deploy --config ai-gateway/wrangler.jsonc
```

中継には専用のOpenRouter鍵を使い、上流側にも支出上限を設定します (利用者ごとの枠とは別の、全体の歯止めです)。配布ビルドはCloudflare Workerの `/health` が認証・レート制限・利用枠の台帳・上流鍵の設定を報告してから進みます。使用量を読むアプリは中継の `GET /v1/usage` を使うので、**中継を先に置いてからアプリを配布**します (古い中継に対しては、アプリはプラン名での確認に戻り、使用量は「まだ取得できていません」と出ます)。公開前に、有効なPro利用者・無料利用者の両方で実際の挙動を確かめます。旧Supabaseの共有鍵を使う試験用の経路を使っていた場合は、テストの移行後に停止し、試験用の鍵を失効させます。

### 利用枠 (プランごとの週の枠)

利用者ごとに使った料金を数え、プランの枠を使い切ったら次の要求から止めます。実装は `apps/web/ai-gateway/usage-ledger.mjs` (枠と台帳) と `gateway.mjs` (数える・止める) です。

- **枠の決め方**: プランごとの「月あたりの予算 (USD)」を置き先の設定 `AI_PLAN_MONTHLY_BUDGET_USD` に書きます。既定は `{"trial":5,"pro":5}`。**1 週間の枠 = 月の予算 × 12 ÷ 52** (月 5 ドルなら約 1.15 ドル) で、5 時間などの短い窓はありません。表に無いプラン (無料) は 403 `PRO_REQUIRED`。試用期間は 7 日なので、1 週ぶんの枠になります。
- **窓**: 最初に使った時刻から 7 日間。過ぎたら使用量を 0 に戻し、次に使った時刻から新しい窓を始めます (全員が同じ曜日に戻るのではなく、利用者ごとの時刻)。
- **数え方**: 上流 (OpenRouter) は全応答に `usage.cost` (その要求の料金) を付けます。中継は本文を 1 バイトも変えずに流しながらこれを読み、応答の後で台帳に足します。途中で切れた応答 (利用者の中断・切断) には `usage` が付かないので、`X-Generation-Id` で上流の `GET /generation` に料金を問い合わせます。それでも分からなければ、要求ごとの押さえ (`AI_REQUEST_HOLD_MICRO_USD`、既定 0.01 ドル) を数え、件数を台帳に残します (`unmetered`)。上流が断った・届かなかった要求は数えません。
- **終わりの報告が来なかった要求**: 応答の途中で中継の実行ごと畳まれると (切断の後など)、終わりの記録が走りません。台帳は応答が始まった時点で generation の ID を押さえに覚えておき、15 分たっても終わりが届かない要求は、その利用者の次の要求・使用量の問い合わせのときに上流へ料金を聞き直して数えます。それまでの間も押さえとして枠に効くので、投げっぱなしで枠を越えては使えません。ローカルの `wrangler dev` は利用者の切断を Worker に伝えないので、切断のその場での記録は配備した中継で確かめます (下の「確認」)。
- **止め方**: 要求のたびに、上流へ送る前に台帳で確かめます。進行中の要求の押さえも足して枠以上なら **402 `USAGE_LIMIT_REACHED`** (`error.resetsAt` に戻る時刻) を返します。枠の手前なら通すので、最後の 1 回は枠を少し越えます。429 にしないのは、利用者側の SDK が 429 を待って送り直すからです (回数制限の 429 `RATE_LIMITED` は従来どおり)。台帳が答えないときは 503 で、数えられない利用を通しません。
- **アプリへの見せ方**: `GET /v1/usage` が `{ plan, included, weekly: { usedRatio, resetsAt, reached } }` を返します。金額は返さず、割合とリセットの時刻だけです。枠の無いプランにも 200 (`included: false`) で答えます。
- **台帳の置き場所**: Durable Object `AiUsageLedger` (利用者 1 人につき 1 つ、名前は利用者の ID)。いまの窓の料金・要求数・トークン数と、過去 26 週ぶんの窓を持ちます。読んでから書くまでに他の要求が混ざらないので、同時に何本送っても枠を大きくは越えません。

アプリ側は、ローカル中継が 402 の `error.code` を読んで実行をその場で止め (DSH の再試行を待たない)、チャットに「今週の SIGMA AI の利用枠を使い切りました。◯月◯日 にリセットされます」と出します。入力欄にも、送る前に同じことが一行で出ます。

#### 上位プランを足すとき

枠の大きいプランは、次の順で足します。中継とアプリの判定は、プラン名を決め打ちにしていません。

1. 共有サービス (非公開リポ) で、新しいプランを契約に対応づけ、`/catalog/capabilities` の `plan` に新しい名前 (例 `max`) を返す。
2. 中継の `AI_PLAN_MONTHLY_BUDGET_USD` に行を足して置き直す (例 `{"trial":5,"pro":5,"max":25}`)。同じ週の使用量のまま、枠だけが広がります。
3. アプリは中継の `included` で使えるかを決めるので、プラン名を知らない版でも内蔵AIは使えます。プランの画面 (`CollaborationPlanDialog`) と [共同編集のプラン](sharing-plans.md) の表に、新しいプランの行を足します。

個別の増枠 (追加購入・問い合わせへの対応) は、共有サービスが `/catalog/capabilities` に `aiMonthlyBudgetUsd` (数値) を返せば、表より優先されます。

#### 運用

- **1 人の使用量を見る・枠を戻す**: `wrangler secret put ADMIN_TOKEN` (32 文字以上) を置くと、`GET /admin/usage?user=<利用者ID>` が台帳を金額のまま返し、`DELETE` がいまの窓を閉じて枠を戻します (使った記録は履歴に残ります)。置いていなければ、この経路は 404 です。
- **利用者をまたいだ集計**: 置き先に Analytics Engine のデータセットを `AI_USAGE_EVENTS` としてつなぐと、要求ごとに「利用者 ID・プラン・モデル・料金・トークン数」を書きます。つないでいなくても、枠の判定は台帳だけで決まります。
- **上流への利用者の識別**: `OPENROUTER_USER_ATTRIBUTION=hashed` を置くと、上流へ `user` (利用者 ID のハッシュ。ID そのものは送らない) を渡します。上流の画面で利用者ごとの料金が見え、1 人の規約違反で全体が止められにくくなります。既定では送りません。
- **台帳の初回**: `wrangler.jsonc` の `migrations` (v1) が Durable Object のクラスを作ります。配備のほかに作るものはありません。

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
- `apps/web/ai-gateway/gateway.test.mjs` — 中継の認証・許可リスト・転送と、利用枠 (週の枠の計算・料金の記録・使い切った後の 402・7 日後のリセット・途中で切れた応答の料金・同時送信・運用の経路)。
- `apps/desktop/electron/dsh-gateway-session.test.ts` — ローカル中継が、断られた理由と応答の使用量を main に伝えること (本文は変えない)。
- `tests/electron/sigma-ai.spec.ts` の「shows context and allowance」— 実アプリで、権限「読み取りのみ」が編集を止めること、コンテキストと利用枠が入力欄と AI設定に出ること、利用枠を使い切ると上限の文で止まること。
- `tests/electron/sigma-ai.spec.ts` の `live:` — 本物の中継と本物の DeepSeek で、枠の描画 (道具なしの問い合わせ)・図の挿入・本文の書き換え・図形への変換を、提案 → 適用 → 保存まで通します。料金がかかるので `SIGMA_AI_LIVE=1` と中継の URL・トークンを渡したときだけ動きます。
- 配備した中継でだけ確かめられること: 応答の途中で利用者が切断したとき、その場で料金が記録されること (`GET /admin/usage` の `holds` が 0 に戻り、`costMicroUsd` が増える)。ローカルの `wrangler dev` は切断を Worker へ伝えないので、ここでは「15 分後の数え直し」の経路だけが確かめられます。台帳そのもの (Durable Object) の動きは、`wrangler dev --local` に中継を載せて確かめられます。
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
- **利用枠** — ほかのAIの利用枠は各社のアカウントのもので、アプリは使用率を表示するだけです。内蔵AIの利用枠はこちらが決めて、中継が止めます。
- **スキルの置き場所** — Codex と同じ場所 (`.agents/skills`) を共用します。内蔵AIだけにスキルを出し分けることはできません。
