import { isMathTexCommandSupported } from "@/lib/math-tex";
import { isTexBoxCommandName } from "@/lib/tex-box-command";

export type InlineMathKeyboardEventLike = {
  altKey: boolean;
  code?: string;
  ctrlKey: boolean;
  isComposing?: boolean;
  key: string;
  keyCode?: number;
  metaKey: boolean;
  shiftKey: boolean;
};

export type InlineMathLatexCommandTrigger = "\\" | "/";

type ResolveInlineMathLatexCommandOptions = {
  allowImmediate?: boolean;
  force?: boolean;
};

type InlineMathLatexCommandDefinition = {
  immediate?: boolean;
  input: string;
  tex: string;
};

const INLINE_MATH_LATEX_COMMANDS: InlineMathLatexCommandDefinition[] = [
  { input: "ga", tex: "\\gamma", immediate: true },
  { input: "gamma", tex: "\\gamma" },
  { input: "al", tex: "\\alpha", immediate: true },
  { input: "alpha", tex: "\\alpha" },
  { input: "be", tex: "\\beta", immediate: true },
  { input: "beta", tex: "\\beta" },
  { input: "de", tex: "\\delta", immediate: true },
  { input: "delta", tex: "\\delta" },
  { input: "ep", tex: "\\epsilon", immediate: true },
  { input: "epsilon", tex: "\\epsilon" },
  { input: "th", tex: "\\theta", immediate: true },
  { input: "theta", tex: "\\theta" },
  { input: "la", tex: "\\lambda", immediate: true },
  { input: "lambda", tex: "\\lambda" },
  { input: "ph", tex: "\\phi", immediate: true },
  { input: "phi", tex: "\\phi" },
  { input: "si", tex: "\\sigma", immediate: true },
  { input: "sigma", tex: "\\sigma" },
  { input: "om", tex: "\\omega", immediate: true },
  { input: "omega", tex: "\\omega" },
  { input: "pi", tex: "\\pi", immediate: true },
  { input: "sum", tex: "\\sum" },
  { input: "prod", tex: "\\prod" },
  { input: "int", tex: "\\int" },
  { input: "le", tex: "\\leqq" },
  { input: "leq", tex: "\\leqq" },
  { input: "leqq", tex: "\\leqq" },
  { input: "ge", tex: "\\geqq" },
  { input: "geq", tex: "\\geqq" },
  { input: "geqq", tex: "\\geqq" },
  { input: "ne", tex: "\\ne" },
  { input: "neq", tex: "\\neq" },
  { input: "pm", tex: "\\pm", immediate: true },
  { input: "times", tex: "\\times" },
  { input: "div", tex: "\\div" },
  { input: "sqrt", tex: "\\sqrt{#?}" },
  { input: "frac", tex: "\\frac{#?}{#?}" },
  { input: "infty", tex: "\\infty" },
  { input: "infinity", tex: "\\infty" },
  { input: "dots", tex: "\\ldots" },
  { input: "to", tex: "\\to", immediate: true },
  { input: "lim", tex: "\\lim" },
  { input: "sin", tex: "\\sin" },
  { input: "cos", tex: "\\cos" },
  { input: "tan", tex: "\\tan" },
  { input: "log", tex: "\\log" },
  // 順列・組合せ。ツールバーの「順列・組合せ」パレットと同じTeXを出す。
  // 添字の文字は教材によって r とも k とも書くので、どちらの綴りでも引けるようにする。
  { input: "ncr", tex: "_{#?}\\mathrm{C}_{#?}" },
  { input: "nck", tex: "_{#?}\\mathrm{C}_{#?}" },
  { input: "npr", tex: "_{#?}\\mathrm{P}_{#?}" },
  { input: "npk", tex: "_{#?}\\mathrm{P}_{#?}" },
  { input: "nhr", tex: "_{#?}\\mathrm{H}_{#?}" },
  { input: "nhk", tex: "_{#?}\\mathrm{H}_{#?}" },
  { input: "binom", tex: "\\binom{#?}{#?}" },
];

const INLINE_MATH_LATEX_COMMAND_BY_INPUT = new Map(
  INLINE_MATH_LATEX_COMMANDS.map((command) => [command.input, command]),
);

export function getInlineMathLatexCommandTrigger(event: InlineMathKeyboardEventLike): InlineMathLatexCommandTrigger | null {
  if (isInlineMathBackslashKey(event)) {
    return "\\";
  }

  if (isInlineMathSlashKey(event)) {
    return "/";
  }

  return null;
}

export function getInlineMathShiftDigit7Text(event: InlineMathKeyboardEventLike): string | null {
  if (
    event.code !== "Digit7" ||
    !event.shiftKey ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.isComposing ||
    event.keyCode === 229
  ) {
    return null;
  }

  return event.key === "'" || event.key === "’" || event.key === "&" ? event.key : null;
}

export function isInlineMathBackslashKey(event: InlineMathKeyboardEventLike): boolean {
  if (!isPlainInlineMathKeyEvent(event) || event.key === "￥") {
    return false;
  }

  return (
    event.key === "\\" ||
    event.key === "¥" ||
    event.code === "Backslash" ||
    event.code === "IntlBackslash" ||
    event.code === "IntlYen"
  );
}

export function isInlineMathLatexCommandCharacterKey(event: InlineMathKeyboardEventLike): boolean {
  return isPlainInlineMathKeyEvent(event) && /^[a-zA-Z]$/.test(event.key);
}

export function shouldClearPendingInlineMathLatexCommand(event: InlineMathKeyboardEventLike): boolean {
  return !event.altKey && !event.ctrlKey && !event.metaKey && event.key !== "Shift" && event.key !== "Control" && event.key !== "Meta" && event.key !== "Alt";
}

export function shouldFlushPendingInlineMathLatexCommand(event: InlineMathKeyboardEventLike): boolean {
  return isPlainInlineMathKeyEvent(event) && event.key.length === 1 && !/^[a-zA-Z]$/.test(event.key);
}

export function shouldStartInlineMathOnBackslash(event: InlineMathKeyboardEventLike): boolean {
  return isInlineMathBackslashKey(event);
}

export function hasInlineMathLatexCommandCandidate(input: string): boolean {
  const normalized = normalizeInlineMathLatexCommandInput(input);
  // `/` は日本語配列でも入力しやすいTeXコマンド開始キーとして扱う。
  // 未知コマンドかどうかは確定時に判定し、通常の `/x` はそのまま残す。
  return normalized.length > 0 && /^[a-z]+$/.test(normalized);
}

export function resolveInlineMathLatexCommand(input: string, options: ResolveInlineMathLatexCommandOptions = {}): string | null {
  const normalized = normalizeInlineMathLatexCommandInput(input);
  const command = INLINE_MATH_LATEX_COMMAND_BY_INPUT.get(normalized);
  if (!command) {
    const passthroughCommand = `\\${normalized}`;
    return options.force && normalized && (
      isTexBoxCommandName(normalized) || isMathTexCommandSupported(passthroughCommand)
    )
      ? passthroughCommand
      : null;
  }

  const hasLongerCommand = INLINE_MATH_LATEX_COMMANDS.some((candidate) => (
    candidate.input !== normalized && candidate.input.startsWith(normalized)
  ));
  const allowImmediate = options.allowImmediate ?? true;
  return options.force || (allowImmediate && command.immediate) || !hasLongerCommand ? command.tex : null;
}

function isInlineMathSlashKey(event: InlineMathKeyboardEventLike): boolean {
  return isPlainInlineMathKeyEvent(event) && event.key === "/";
}

function isPlainInlineMathKeyEvent(event: InlineMathKeyboardEventLike): boolean {
  return !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.isComposing && event.keyCode !== 229;
}

function normalizeInlineMathLatexCommandInput(input: string): string {
  return input.trim().toLowerCase();
}
