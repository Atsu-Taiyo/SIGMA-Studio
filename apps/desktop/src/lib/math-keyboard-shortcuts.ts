import { installMathLiveOpenFenceLatex } from "@/lib/mathlive-open-fence";

export interface MathKeyboardKeyboardEventLike {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
}

export interface MathKeyboardMathfieldLike {
  getValue?: () => string;
  insert: (tex: string, options?: {
    focus?: boolean;
    format?: "latex";
    mode?: "math";
    selectionMode?: "after" | "placeholder";
  }) => boolean | void;
  value?: string;
}

export interface MathKeyboardShortcutEventLike extends MathKeyboardKeyboardEventLike {
  preventDefault: () => void;
  stopPropagation: () => void;
}

export interface MathKeyboardMathShortcut {
  altKey: boolean;
  codes?: string[];
  id: string;
  keys: string[];
  tex: string;
  wrapsSelection?: boolean;
}

export const MATH_KEYBOARD_SHORTCUTS: MathKeyboardMathShortcut[] = [
  { id: "superscript", altKey: false, keys: ["^"], tex: "{}^{#?}" },
  { id: "subscript", altKey: false, keys: ["]"], codes: ["BracketRight"], tex: "{}_{#?}" },
  { id: "subscript-superscript", altKey: true, keys: ["^"], tex: "{}_{#?}^{#?}" },
  { id: "superscript-subscript", altKey: true, keys: ["]"], codes: ["BracketRight"], tex: "{}^{#?}_{#?}" },
  { id: "square", altKey: true, keys: ["2"], codes: ["Digit2", "Numpad2"], tex: "{#?}^{2}", wrapsSelection: true },
  { id: "fraction", altKey: false, keys: ["/"], codes: ["Slash"], tex: "\\frac{#?}{#?}" },
  { id: "sqrt", altKey: false, keys: ["r"], codes: ["KeyR"], tex: "\\sqrt{#?}" },
  { id: "nth-root", altKey: true, keys: ["r"], codes: ["KeyR"], tex: "\\sqrt[#?]{#?}" },
  { id: "sin", altKey: false, keys: ["h"], codes: ["KeyH"], tex: "\\sin #?" },
  { id: "cos", altKey: false, keys: ["j"], codes: ["KeyJ"], tex: "\\cos #?" },
  { id: "tan", altKey: false, keys: ["k"], codes: ["KeyK"], tex: "\\tan #?" },
  { id: "sin-power", altKey: true, keys: ["h"], codes: ["KeyH"], tex: "\\sin^{#?} #?" },
  { id: "cos-power", altKey: true, keys: ["j"], codes: ["KeyJ"], tex: "\\cos^{#?} #?" },
  { id: "tan-power", altKey: true, keys: ["k"], codes: ["KeyK"], tex: "\\tan^{#?} #?" },
  { id: "integral", altKey: false, keys: ["i"], codes: ["KeyI"], tex: "\\int #?" },
  { id: "definite-integral", altKey: true, keys: ["i"], codes: ["KeyI"], tex: "\\int_{#?}^{#?} #?" },
  { id: "sum", altKey: false, keys: ["g"], codes: ["KeyG"], tex: "\\sum_{#?}^{#?} #?" },
  { id: "limit", altKey: false, keys: ["u"], codes: ["KeyU"], tex: "\\lim_{#?\\to#?}" },
  { id: "boxed", altKey: false, keys: ["b"], codes: ["KeyB"], tex: "\\boxed{#?}" },
  { id: "boxed-superscript", altKey: true, keys: ["b"], codes: ["KeyB"], tex: "{}^{#?}\\boxed{#?}" },
  { id: "matrix-2x2", altKey: false, keys: ["d"], codes: ["KeyD"], tex: "\\begin{pmatrix}#?&#?\\\\#?&#?\\end{pmatrix}" },
  { id: "vector-2", altKey: true, keys: ["d"], codes: ["KeyD"], tex: "\\begin{pmatrix}#?\\\\#?\\end{pmatrix}" },
  { id: "cases-2", altKey: false, keys: ["y"], codes: ["KeyY"], tex: "\\begin{cases}#?\\\\#?\\end{cases}" },
  { id: "cases-3", altKey: true, keys: ["y"], codes: ["KeyY"], tex: "\\begin{cases}#?\\\\#?\\\\#?\\end{cases}" },
  { id: "vector-accent", altKey: false, keys: ["w"], codes: ["KeyW"], tex: "\\vec{#?}" },
  { id: "overline", altKey: true, keys: ["w"], codes: ["KeyW"], tex: "\\overline{#?}" },
  { id: "absolute-value", altKey: false, keys: ["¥", "\\"], codes: ["Backslash", "IntlYen"], tex: "\\left|#?\\right|" },
  { id: "brackets", altKey: true, keys: ["["], tex: "\\left[#?\\right]" },
  { id: "brackets-scripts", altKey: false, keys: ["["], tex: "\\left[#?\\right]_{#?}^{#?}" },
  { id: "log", altKey: false, keys: ["l"], codes: ["KeyL"], tex: "\\log #?" },
  { id: "log-base", altKey: true, keys: ["l"], codes: ["KeyL"], tex: "\\log_{#?} #?" },
  { id: "less-than-or-equal", altKey: false, keys: [","], codes: ["Comma"], tex: "\\leqq" },
  { id: "greater-than-or-equal", altKey: false, keys: ["."], codes: ["Period"], tex: "\\geqq" },
  { id: "not-equal", altKey: false, keys: ["-"], codes: ["Minus"], tex: "\\ne" },
  { id: "pi", altKey: false, keys: ["@"], tex: "\\pi" },
  { id: "theta", altKey: true, keys: ["@"], tex: "\\theta" },
  { id: "degree", altKey: true, keys: ["."], codes: ["Period"], tex: "^{\\circ}" },
  { id: "times", altKey: false, keys: [":"], tex: "\\times" },
  { id: "division", altKey: true, keys: ["/"], codes: ["Slash"], tex: "\\div" },
  { id: "plus-minus", altKey: false, keys: [";"], tex: "\\pm" },
];

/**
 * MathLive のキー割り当て (`"ctrl+h"`・`"ctrl+[Minus]"` の形) が、上のショートカットと同じ
 * キーか。macOS の MathLive は ⌃H を 1 文字削除・⌃D を後ろの削除・⌃B を左へ移動に割り当てて
 * おり、残すとショートカットの挿入の前に文字が消えたりキャレットが動いたりする。
 */
export function collidesWithMathKeyboardShortcut(mathLiveKey: string): boolean {
  const parts = mathLiveKey.split("+");
  const key = parts.pop() ?? "";
  const modifiers = new Set(parts.map((part) => part.toLowerCase()));
  if (!modifiers.has("ctrl") || modifiers.has("cmd") || modifiers.has("meta")) {
    return false;
  }
  const code = /^\[(\w+)\]$/.exec(key)?.[1];
  const altKey = modifiers.has("alt");
  return MATH_KEYBOARD_SHORTCUTS.some((shortcut) => (
    shortcut.altKey === altKey &&
    (code
      ? shortcut.codes?.includes(code) || shortcut.keys.some((candidate) => codeForKey(candidate) === code)
      : shortcut.keys.some((candidate) => normalizeShortcutKey(candidate) === normalizeShortcutKey(key)))
  ));
}

/** US 配列でその文字を打つ物理キー (Shift 込み)。MathLive のキー割り当ては物理キーで書かれている。 */
const US_LAYOUT_SYMBOL_CODES: Readonly<Record<string, string>> = {
  "-": "Minus", ",": "Comma", ".": "Period", "/": "Slash", ";": "Semicolon", ":": "Semicolon",
  "[": "BracketLeft", "]": "BracketRight", "\\": "Backslash", "@": "Digit2", "^": "Digit6",
};

function codeForKey(key: string): string | undefined {
  if (/^[a-z]$/i.test(key)) {
    return `Key${key.toUpperCase()}`;
  }
  if (/^[0-9]$/.test(key)) {
    return `Digit${key}`;
  }
  return US_LAYOUT_SYMBOL_CODES[key];
}

export function isMathKeyboardMathModeShortcut(event: MathKeyboardKeyboardEventLike): boolean {
  return isCtrlOnlyShortcut(event) && normalizeShortcutKey(event.key) === "m";
}

export function isMathKeyboardReturnToTextShortcut(event: MathKeyboardKeyboardEventLike): boolean {
  return isCtrlOnlyShortcut(event) && normalizeShortcutKey(event.key) === "t";
}

export function getMathKeyboardMathShortcut(event: MathKeyboardKeyboardEventLike): MathKeyboardMathShortcut | null {
  if (!event.ctrlKey || event.metaKey) {
    return null;
  }

  const key = normalizeShortcutKey(event.key);
  // 打った文字で探してから、物理キーで探す。物理キーは配列で文字が違うときの予備で、先に見ると
  // JIS の「[」(物理キーは US の「]」) が下付きになるなど、配列によって別のショートカットに化ける。
  const candidates = MATH_KEYBOARD_SHORTCUTS.filter((shortcut) => shortcut.altKey === event.altKey);
  return candidates.find((shortcut) => shortcut.keys.some((candidate) => normalizeShortcutKey(candidate) === key)) ??
    candidates.find((shortcut) => shortcut.codes?.includes(event.code)) ??
    null;
}

export function insertMathKeyboardMathTemplate(mathField: MathKeyboardMathfieldLike, tex: string): boolean {
  mathField.insert(tex, {
    focus: true,
    format: "latex",
    mode: "math",
    selectionMode: "placeholder",
  });
  return true;
}

export function handleMathKeyboardMathShortcut(event: MathKeyboardShortcutEventLike, mathField: MathKeyboardMathfieldLike): boolean {
  const shortcut = getMathKeyboardMathShortcut(event);
  if (!shortcut) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();
  insertMathKeyboardMathTemplate(mathField, shortcut.tex);
  return true;
}

export function getMathfieldLatex(mathField: MathKeyboardMathfieldLike): string {
  // 閉じ括弧を消した括弧を `(x.` と書き出さないようにしてから読む (`mathlive-open-fence.ts`)。
  installMathLiveOpenFenceLatex(mathField);
  if (typeof mathField.getValue === "function") {
    return mathField.getValue();
  }

  return typeof mathField.value === "string" ? mathField.value : "";
}

function isCtrlOnlyShortcut(event: MathKeyboardKeyboardEventLike): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && normalizeShortcutKey(event.key).length === 1;
}

function normalizeShortcutKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
}
