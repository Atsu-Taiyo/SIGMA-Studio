import { describe, expect, it, vi } from "vitest";

import { SIGMA_MATHLIVE_EDITOR_VECTOR_MACRO } from "@/lib/math-macros";
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
import { SIGMA_MATHLIVE_EDITOR_MACROS } from "@/lib/math-macros";

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

  // 旧教材の設定が残っていても、静的描画と同じ displaystyle を使う。
  it.each([
    ["uniform", "displaystyle"],
    ["texDefault", "displaystyle"],
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

  it("edits the built-in \\vv in its static box and keeps a document's own \\vv", () => {
    const builtIn = { executeCommand: vi.fn() } as unknown as InlineMathLiveFieldElement;
    configureInlineMathLiveField(builtIn, createMathRenderEnvironment());
    expect(builtIn.macros?.vv).toEqual(SIGMA_MATHLIVE_EDITOR_VECTOR_MACRO);

    const own = { executeCommand: vi.fn() } as unknown as InlineMathLiveFieldElement;
    configureInlineMathLiveField(own, createMathRenderEnvironment(String.raw`\newcommand{\vv}[1]{\overrightarrow{#1}}`));
    expect(own.macros?.vv).toEqual({ args: 1, def: String.raw`\overrightarrow{#1}` });
  });

  it("recognizes the built-in \\vv by definition when the macro tables arrive rebuilt or copied", () => {
    // A document preamble (here an unrelated font command) and a structured copy of the
    // environment hand the field equal but not identical macro objects.
    const environment = structuredClone(createMathRenderEnvironment(String.raw`\newcommand{\gothic}[1]{\mathrm{#1}}`));
    const field = { executeCommand: vi.fn() } as unknown as InlineMathLiveFieldElement;
    configureInlineMathLiveField(field, environment);
    expect(field.macros?.vv).toEqual(SIGMA_MATHLIVE_EDITOR_VECTOR_MACRO);
    expect(field.macros).toMatchObject({ gothic: { args: 1, def: String.raw`\mathrm{#1}` } });
    // Configuring the same field again keeps the editable box.
    configureInlineMathLiveField(field, environment);
    expect(field.macros?.vv).toEqual(SIGMA_MATHLIVE_EDITOR_VECTOR_MACRO);
  });

  it("restores the editor's thin circle after a document-defined textcircled is removed", () => {
    const mathField = { executeCommand: vi.fn() } as unknown as InlineMathLiveFieldElement;
    configureInlineMathLiveField(mathField, createMathRenderEnvironment(String.raw`\newcommand{\textcircled}[1]{\boxed{#1}}`));
    expect(mathField.macros?.textcircled).toEqual({ args: 1, def: String.raw`\boxed{#1}` });
    configureInlineMathLiveField(mathField, DEFAULT_MATH_RENDER_ENVIRONMENT);
    expect(mathField.macros?.textcircled).toEqual(SIGMA_MATHLIVE_EDITOR_MACROS.textcircled);
    expect(DEFAULT_MATH_RENDER_ENVIRONMENT.macroSet.mathLiveMacros.textcircled).toBeUndefined();
  });
});
