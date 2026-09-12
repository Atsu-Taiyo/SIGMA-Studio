import { mathFieldDefaultMode } from "@/features/rendering/core";
import type { MathRenderEnvironment } from "@/lib/math-environment";
import { SIGMA_MATHLIVE_MACRO_STYLES } from "@/lib/math-macros";

export const MATHLIVE_MATH_MODE_SPACE = "\\ ";

export function configureMathLiveSpace(mathField: { mathModeSpace?: string }) {
  mathField.mathModeSpace = MATHLIVE_MATH_MODE_SPACE;
}

export type InlineMathLiveFieldElement = HTMLElement & {
  defaultMode?: "inline-math" | "math" | "text";
  environmentPopoverPolicy?: "auto" | "off" | "on";
  executeCommand?: (command: string | [string, unknown]) => void;
  insert?: (text: string, options?: {
    focus?: boolean;
    format?: "latex";
    mode?: "math" | "text";
    selectionMode?: "after" | "placeholder";
  }) => void;
  mathModeSpace?: string;
  macros?: Readonly<Record<string, unknown>>;
  mathVirtualKeyboardPolicy?: "auto" | "manual" | "sandboxed";
  menuItems?: readonly unknown[];
  popoverPolicy?: "auto" | "off";
  smartFence?: boolean;
};

const SIGMA_MATHLIVE_MACRO_STYLE_ATTRIBUTE = "data-sigma-math-macro-styles";

function installSigmaMathLiveMacroStyles(mathField: InlineMathLiveFieldElement) {
  const shadowRoot = mathField.shadowRoot;
  if (!shadowRoot || shadowRoot.querySelector(`style[${SIGMA_MATHLIVE_MACRO_STYLE_ATTRIBUTE}]`)) {
    return;
  }
  const style = document.createElement("style");
  style.setAttribute(SIGMA_MATHLIVE_MACRO_STYLE_ATTRIBUTE, "");
  style.textContent = SIGMA_MATHLIVE_MACRO_STYLES;
  shadowRoot.append(style);
}

/**
 * 編集中の `math-field` を文書の描画環境に合わせる。組版スタイルは `defaultMode` 経由でしか
 * 効かせられない (静的側は TeX 前置) が、値の出典は静的側と同じ `mathFieldDefaultMode` 1 つ。
 * これを直値に戻すと「編集中だけ組版が違う」が再発する。
 */
export function configureInlineMathLiveField(
  mathField: InlineMathLiveFieldElement,
  environment: MathRenderEnvironment,
) {
  installSigmaMathLiveMacroStyles(mathField);
  mathField.defaultMode = mathFieldDefaultMode(environment.typesetStyle);
  mathField.environmentPopoverPolicy = "off";
  configureMathLiveSpace(mathField);
  mathField.mathVirtualKeyboardPolicy = "manual";
  mathField.macros = {
    ...(mathField.macros ?? {}),
    ...environment.macroSet.mathLiveMacros,
  };
  mathField.popoverPolicy = "auto";
  // 開き括弧を打った時点で閉じ括弧も入る MathLive 標準の挙動 (`\left(\right)` を作る)。
  // 既定値に頼らず明示しておく。閉じ括弧が薄く出ないようにする CSS は
  // `.inline-math-field { --smart-fence-opacity: 1 }` 側にある。
  mathField.smartFence = true;
  try {
    mathField.menuItems = [];
    mathField.executeCommand?.("hideVirtualKeyboard");
  } catch {
    // MathLive may throw before the custom element finishes mounting.
  }
}
