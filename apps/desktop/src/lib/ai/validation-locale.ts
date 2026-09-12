import { getAppLocale, normalizeLocale, DEFAULT_LOCALE, createTranslator, type AppLocale } from "@/lib/i18n";

/**
 * 検証フィードバック (モデルへ返る文言) の表示言語。
 *
 * この層は **3 つの異なるプロセス**から呼ばれる:
 * - renderer — `getAppLocale()` が使える
 * - Electron main — `window` が無いので `setValidationLocale` で run ごとに固定する
 * - **MCP サーバー (別プロセス)** — 上の 2 つとメモリを共有しないので、起動時に
 *   環境変数で受け取る
 *
 * **`node:fs` で設定ファイルを読みに行かない。** この module は renderer からも
 * import されるので、fs を持ち込むとクライアントバンドルに載る。
 */
export const VALIDATION_LOCALE_ENV = "SIGMA_STUDIO_UI_LOCALE";

/** main プロセスなど、run ごとに解決済みのロケールを持っている側が固定する。設定より強い。 */
/**
 * Electron main / MCP には `window` が無いので、実行のたびにここへ入れる。
 *
 * **プロセス全体で 1 つ**なので並列実行では最後の書き手が勝つ。ロケールは実行ごとの
 * 値ではなくアプリ設定なので、並列でも全実行が同じ値になり実害は無い (途中で UI 言語を
 * 変えたら進行中の実行も新しい言語になる = 期待どおり)。**実行ごとに違う値を持つものを
 * ここへ足さないこと** — その瞬間に並列実行が壊れる。
 */
let forcedLocale: AppLocale | null = null;

export function setValidationLocale(locale: AppLocale | null): void {
  forcedLocale = locale;
}

export function resolveValidationLocale(): AppLocale {
  if (forcedLocale) {
    return forcedLocale;
  }
  if (typeof window !== "undefined") {
    return getAppLocale();
  }
  // MCP サーバーはここを通る (env は launch 時に main が渡す)。
  const runtimeProcess = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process;
  return normalizeLocale(runtimeProcess?.env?.[VALIDATION_LOCALE_ENV] ?? null) ?? DEFAULT_LOCALE;
}

/**
 * 検証メッセージの解決器。**呼ばれた瞬間の言語**で引く。
 *
 * zod のスキーマは module 直下で 1 度だけ組まれるので、`message: "…"` に文字列を
 * 直接書くと読み込み時の言語で焼き付く。zod 4 の `error: () => tv(…)` は検証が
 * 失敗した瞬間に評価されるため、**スキーマをロケール別に作り直す必要がない**
 * (ファクトリ化もメモ化も不要 — 実測で確認済み)。
 */
export function tv(key: string, values?: Record<string, unknown>): string {
  const translate = createTranslator(resolveValidationLocale(), "prompt");
  return translate(`validation.${key}` as never, (values ? { replace: values } : undefined) as never) as unknown as string;
}

/**
 * **言語に依存しない**訳文。常に {@link DEFAULT_LOCALE} で引く。
 *
 * 訳文が「モデルに読ませる表示」ではなく**機械可読な値**として使われる箇所専用:
 * 変更検知のシグネチャ、文字オフセットの基準長など。`tv()` を使うと、内容が
 * 何も変わっていないのに**言語を切り替えただけで pin が無効化されたり、
 * renderer (実ロケール) と MCP サーバー (env ロケール) でオフセットが食い違う**。
 *
 * 表示に使ってはいけない (英語 UI に日本語が出る)。表示は `tv()`。
 */
export function tvStable(key: string, values?: Record<string, unknown>): string {
  const translate = createTranslator(DEFAULT_LOCALE, "prompt");
  return translate(`validation.${key}` as never, (values ? { replace: values } : undefined) as never) as unknown as string;
}
