import { describe, expect, it, vi } from "vitest";

import {
  configureInlineMathLiveField,
  configureMathLiveSpace,
  MATHLIVE_MATH_MODE_SPACE,
  type InlineMathLiveFieldElement,
} from "@/lib/mathlive-config";
import {
  DEFAULT_MATH_TYPESET_STYLE,
  mathFieldDefaultMode,
  type MathTypesetStyle,
} from "@/features/rendering/core";
import {
  createMathRenderEnvironment,
  DEFAULT_MATH_RENDER_ENVIRONMENT,
} from "@/lib/math-environment";

describe("MathLive config", () => {
  it("uses a visible TeX space for math-mode spacebar input", () => {
    const mathField: { mathModeSpace?: string } = {};

    configureMathLiveSpace(mathField);

    expect(mathField.mathModeSpace).toBe("\\ ");
    expect(MATHLIVE_MATH_MODE_SPACE).not.toBe(" ");
  });

  it("applies the shared inline MathLive display settings", () => {
    const mathField = {
      executeCommand: vi.fn(),
    } as unknown as InlineMathLiveFieldElement & {
      executeCommand: ReturnType<typeof vi.fn>;
    };

    configureInlineMathLiveField(mathField, DEFAULT_MATH_RENDER_ENVIRONMENT);

    expect(mathField.defaultMode).toBe(mathFieldDefaultMode(DEFAULT_MATH_TYPESET_STYLE));
    expect(mathField.environmentPopoverPolicy).toBe("off");
    expect(mathField.mathModeSpace).toBe(MATHLIVE_MATH_MODE_SPACE);
    expect(mathField.mathVirtualKeyboardPolicy).toBe("manual");
    expect(mathField.macros).toMatchObject({
      kyoutsuuchoice: {
        def: String.raw`\class{sigma-kyoutsuu-choice}{\textbf{#1}}`,
        args: 1,
      },
      doubleboxed: {
        def: String.raw`\class{sigma-doubleboxed}{\boxed{#1}}`,
        args: 1,
      },
      thickboxed: {
        def: String.raw`\class{sigma-thickboxed}{\boxed{#1}}`,
        args: 1,
      },
      outerthickdoubleboxed: {
        def: String.raw`\class{sigma-outerthick-doubleboxed}{\boxed{#1}}`,
        args: 1,
      },
    });
    expect(mathField.menuItems).toEqual([]);
    expect(mathField.popoverPolicy).toBe("auto");
    // 開き括弧だけ打っても閉じ括弧が入る MathLive の smartFence。既定値任せにすると
    // 「片方しか入らない」に戻りうるので明示で固定する。
    expect(mathField.smartFence).toBe(true);
    expect(mathField.executeCommand).toHaveBeenCalledWith("hideVirtualKeyboard");
  });

  // 編集中の組版スタイルは静的側と同じ 1 つの出典から来る。ここを直値に戻すと
  // 「用紙設定を変えても math-field だけ変わらない」が再発する (経路 A)。
  it.each([
    ["uniform", "displaystyle"],
    ["texDefault", "textstyle"],
  ] as Array<["uniform" | "texDefault", MathTypesetStyle]>)(
    "derives the field mode from the document typeset style (%s)",
    (mathFractionSizing, typesetStyle) => {
      const mathField = { executeCommand: vi.fn() } as unknown as InlineMathLiveFieldElement & {
        executeCommand: ReturnType<typeof vi.fn>;
      };

      configureInlineMathLiveField(mathField, createMathRenderEnvironment("", mathFractionSizing));

      expect(mathField.defaultMode).toBe(mathFieldDefaultMode(typesetStyle));
    },
  );

  it("passes the document preamble macros to the field", () => {
    const mathField = { executeCommand: vi.fn() } as unknown as InlineMathLiveFieldElement & {
      executeCommand: ReturnType<typeof vi.fn>;
    };

    configureInlineMathLiveField(
      mathField,
      createMathRenderEnvironment(String.raw`\newcommand{\RR}{\mathbb{R}}`),
    );

    expect(mathField.macros).toMatchObject({ RR: { args: 0, def: String.raw`\mathbb{R}` } });
  });
});
