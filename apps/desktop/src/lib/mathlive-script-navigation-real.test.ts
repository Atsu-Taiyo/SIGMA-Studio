// @vitest-environment happy-dom

import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { getMathfieldLatex, insertMathKeyboardMathTemplate } from "@/lib/math-keyboard-shortcuts";
import { moveBetweenScriptBranches } from "@/lib/mathlive-script-navigation";

type MathfieldElementClass = typeof import("mathlive").MathfieldElement;
type MathfieldElementInstance = InstanceType<MathfieldElementClass>;

let MathfieldElement: MathfieldElementClass;

/**
 * 実物の MathLive で確かめる (`mathlive-open-fence.test.ts` と同じ読み込み方)。原子の木の形
 * (`parentBranch` の名前・`branch()`・`_mathfield.model`) に依存する機能なので、MathLive を上げて
 * 形が変わったらここが先に落ちる。
 */
async function importBrowserMathLive(): Promise<typeof import("mathlive")> {
  const ssrEntry = import.meta.resolve("mathlive");
  const browserEntry = pathToFileURL(join(dirname(new URL(ssrEntry).pathname), "mathlive.mjs")).href;
  return import(/* @vite-ignore */ browserEntry) as Promise<typeof import("mathlive")>;
}

beforeAll(async () => {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve(), status: "loaded", add() {}, check: () => true, load: async () => [], addEventListener() {}, removeEventListener() {} },
  });
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: class { state = "running"; async resume() {} },
  });
  ({ MathfieldElement } = await importBrowserMathLive());
  MathfieldElement.soundsDirectory = null;
  MathfieldElement.fontsDirectory = null;
});

afterEach(() => {
  document.body.innerHTML = "";
});

function createField(latex: string): MathfieldElementInstance {
  const field = new MathfieldElement();
  document.body.append(field);
  field.value = latex;
  return field;
}

/** 文字 `label` を打った直後の位置 (キャレットが `label` の右) へキャレットを置く。 */
function placeCaretAfter(field: MathfieldElementInstance, label: string) {
  const model = (field as unknown as { _mathfield: { model: { atoms: Array<{ command: string }>; position: number } } })._mathfield.model;
  const offset = model.atoms.findIndex((atom) => atom.command === label);
  expect(offset, label).toBeGreaterThan(0);
  field.position = offset;
}

const type = (field: MathfieldElementInstance, text: string) => field.executeCommand(["typedText", text]);

describe("moveBetweenScriptBranches with MathLive", () => {
  it("goes between the limits of an integral and keeps typing at the end of the target", () => {
    const field = createField(String.raw`\int_a^b`);
    placeCaretAfter(field, "b");

    expect(moveBetweenScriptBranches(field, "down")).toBe(true);
    type(field, "x");
    expect(getMathfieldLatex(field)).toBe(String.raw`\int_{ax}^{b}`);

    expect(moveBetweenScriptBranches(field, "up")).toBe(true);
    type(field, "y");
    expect(getMathfieldLatex(field)).toBe(String.raw`\int_{ax}^{by}`);
  });

  it("works for sums, subscript-superscript pairs and from anywhere inside the branch", () => {
    const sum = createField(String.raw`\sum_{k=1}^{n}k`);
    placeCaretAfter(sum, "=");
    expect(moveBetweenScriptBranches(sum, "up")).toBe(true);
    type(sum, "+");
    expect(getMathfieldLatex(sum)).toBe(String.raw`\sum_{k=1}^{n+}k`);

    const pair = createField("x_1^2");
    placeCaretAfter(pair, "2");
    expect(moveBetweenScriptBranches(pair, "down")).toBe(true);
    type(pair, "3");
    expect(getMathfieldLatex(pair)).toBe("x_{13}^2");
  });

  it("selects the blank of an empty limit, so typing fills it", () => {
    const field = createField("");
    insertMathKeyboardMathTemplate(field, String.raw`\int_{#?}^{#?} #?`);
    // テンプレートの直後は下端の空欄が選ばれている。
    type(field, "0");
    expect(moveBetweenScriptBranches(field, "up")).toBe(true);
    type(field, "1");
    expect(getMathfieldLatex(field)).toBe(String.raw`\int_0^1\placeholder{}`);
    expect(moveBetweenScriptBranches(field, "down")).toBe(true);
    type(field, "2");
    expect(getMathfieldLatex(field)).toBe(String.raw`\int_{02}^1\placeholder{}`);
  });

  it("moves between two empty blanks, selecting each one", () => {
    const field = createField("");
    insertMathKeyboardMathTemplate(field, String.raw`\sum_{#?}^{#?} #?`);
    expect(moveBetweenScriptBranches(field, "up")).toBe(true);
    type(field, "n");
    expect(moveBetweenScriptBranches(field, "down")).toBe(true);
    type(field, "k");
    expect(getMathfieldLatex(field)).toBe(String.raw`\sum_{k}^{n}\placeholder{}`);
  });

  it("leaves a single script and a caret outside the scripts to MathLive", () => {
    const power = createField("x^2");
    placeCaretAfter(power, "2");
    expect(moveBetweenScriptBranches(power, "down")).toBe(false);
    expect(moveBetweenScriptBranches(power, "up")).toBe(false);

    const integral = createField(String.raw`\int_a^b f`);
    placeCaretAfter(integral, "f");
    expect(moveBetweenScriptBranches(integral, "down")).toBe(false);
    expect(moveBetweenScriptBranches(integral, "up")).toBe(false);
  });

  it("uses the innermost script, not the enclosing one", () => {
    const field = createField(String.raw`x_p^{y_q^r}`);
    placeCaretAfter(field, "r");
    expect(moveBetweenScriptBranches(field, "down")).toBe(true);
    type(field, "!");
    expect(getMathfieldLatex(field)).toBe(String.raw`x_{p}^{y_{q!}^{r}}`);

    const lone = createField(String.raw`x_p^{z^s}`);
    placeCaretAfter(lone, "s");
    expect(moveBetweenScriptBranches(lone, "down")).toBe(false);
  });

  it("leaves a fraction inside a limit to MathLive's own up/down", () => {
    const field = createField(String.raw`\int_a^{\frac{b}{c}}`);
    placeCaretAfter(field, "b");
    expect(moveBetweenScriptBranches(field, "down")).toBe(false);
    expect(moveBetweenScriptBranches(field, "up")).toBe(false);
  });

  it("leaves an array cell inside a limit to MathLive", () => {
    const field = createField(String.raw`\int_a^{\begin{matrix}b\\c\end{matrix}}`);
    placeCaretAfter(field, "b");
    expect(moveBetweenScriptBranches(field, "down")).toBe(false);
  });
});

describe("fraction templates start in the denominator", () => {
  it("lands the caret in the denominator and ArrowUp reaches the numerator", () => {
    const field = createField("");
    insertMathKeyboardMathTemplate(field, String.raw`\frac{#?}{#?}`);
    type(field, "2");
    expect(getMathfieldLatex(field)).toBe(String.raw`\frac{\placeholder{}}{2}`);

    field.executeCommand("moveToPreviousPlaceholder");
    type(field, "1");
    expect(getMathfieldLatex(field)).toBe(String.raw`\frac12`);
  });

  it("works after existing content and for \\dfrac and \\tfrac", () => {
    for (const command of ["frac", "dfrac", "tfrac"]) {
      const field = createField("a+");
      field.executeCommand("moveToMathfieldEnd");
      insertMathKeyboardMathTemplate(field, `\\${command}{#?}{#?}`);
      type(field, "9");
      expect(getMathfieldLatex(field), command).toBe(`a+\\${command}{\\placeholder{}}{9}`);
    }
  });

  it("keeps the numerator for templates that are not plain fractions", () => {
    const binom = createField("");
    insertMathKeyboardMathTemplate(binom, String.raw`\binom{#?}{#?}`);
    type(binom, "n");
    expect(getMathfieldLatex(binom)).toBe(String.raw`\binom{n}{\placeholder{}}`);

    const root = createField("");
    insertMathKeyboardMathTemplate(root, String.raw`\sqrt[#?]{#?}`);
    type(root, "3");
    expect(getMathfieldLatex(root)).toBe(String.raw`\sqrt[3]{\placeholder{}}`);
  });

  it("starts in the denominator when a selection is replaced by a fraction", () => {
    const field = createField("xy");
    field.executeCommand("selectAll");
    insertMathKeyboardMathTemplate(field, String.raw`\frac{#?}{#?}`);
    type(field, "5");
    expect(getMathfieldLatex(field)).toBe(String.raw`\frac{\placeholder{}}{5}`);
  });
});
