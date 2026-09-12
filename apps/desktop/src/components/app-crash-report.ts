import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";

/** アプリのバージョン。プロンプトに載せて、どのビルドで落ちたかを分かるようにする。 */
export const APP_CRASH_PROMPT_SOURCE_HINT = "apps/desktop/src";

const DEFAULT_ERROR_TRANSLATE = createCurrentLocaleTranslator("error");

function translate(
  t: Translate<"error">,
  key: string,
  replace?: Record<string, unknown>,
): string {
  return (t as unknown as (key: string, options?: { replace: Record<string, unknown> }) => string)(
    key,
    replace ? { replace } : undefined,
  );
}

export interface AppCrashReport {
  /** 例外のメッセージ。 */
  message: string;
  /** 例外のスタック (取れた場合)。 */
  stack?: string;
  /** React が付けるコンポーネントスタック (取れた場合)。 */
  componentStack?: string;
  /** 落ちた時に開いていた画面のURL。 */
  href?: string;
}

export function describeAppCrash(
  error: unknown,
  componentStack?: string,
  href?: string,
  t: Translate<"error"> = DEFAULT_ERROR_TRANSLATE,
): AppCrashReport {
  if (error instanceof Error) {
    return { message: error.message || error.name, stack: error.stack, componentStack, href };
  }
  return { message: typeof error === "string" ? error : translate(t, "crash.unknownError"), componentStack, href };
}

function trimStack(stack: string | undefined, maxLines: number): string | undefined {
  if (!stack) {
    return undefined;
  }
  const lines = stack.split("\n").slice(0, maxLines);
  return lines.join("\n");
}

/**
 * 画面が真っ白になった時に、そのままAIへ貼れば原因調査に入れる自己完結プロンプト。
 * スタックとコンポーネントスタックの両方を載せる — どちらか片方だけでは
 * 「どの描画経路から呼ばれたのか」が分からず、再現に時間がかかる。
 */
export function buildAppCrashPrompt(
  report: AppCrashReport,
  t: Translate<"error"> = DEFAULT_ERROR_TRANSLATE,
): string {
  const sections: string[] = [];

  sections.push([
    translate(t, "crash.prompt.intro"),
    "",
    translate(t, "crash.prompt.errorHeading"),
    report.message,
  ].join("\n"));

  const stack = trimStack(report.stack, 30);
  if (stack) {
    sections.push([translate(t, "crash.prompt.stackHeading"), "```", stack, "```"].join("\n"));
  }

  const componentStack = trimStack(report.componentStack, 20);
  if (componentStack) {
    sections.push([translate(t, "crash.prompt.componentStackHeading"), "```", componentStack.trim(), "```"].join("\n"));
  }

  sections.push([
    translate(t, "crash.prompt.contextHeading"),
    report.href
      ? translate(t, "crash.prompt.screen", { href: report.href })
      : translate(t, "crash.prompt.unknownScreen"),
    translate(t, "crash.prompt.source", { source: APP_CRASH_PROMPT_SOURCE_HINT }),
    translate(t, "crash.prompt.repairTarget"),
    translate(t, "crash.prompt.renderCause"),
  ].join("\n"));

  sections.push([
    translate(t, "crash.prompt.tasksHeading"),
    translate(t, "crash.prompt.task1"),
    translate(t, "crash.prompt.task2"),
    translate(t, "crash.prompt.task3"),
    translate(t, "crash.prompt.task4"),
  ].join("\n"));

  return `${sections.join("\n\n")}\n`;
}
