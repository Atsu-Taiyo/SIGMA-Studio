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
  return MATH_KEYBOARD_SHORTCUTS.find((shortcut) => (
    shortcut.altKey === event.altKey &&
    (shortcut.codes?.includes(event.code) ||
      shortcut.keys.some((candidate) => normalizeShortcutKey(candidate) === key))
  )) ?? null;
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
