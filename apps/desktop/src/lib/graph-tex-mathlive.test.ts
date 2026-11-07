// @vitest-environment happy-dom

import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { getMathfieldLatex, insertMathKeyboardMathTemplate } from "@/lib/math-keyboard-shortcuts";
import { texToGraphExpressionWithError } from "@/lib/graph-tex";
import { evaluateScalar } from "@/lib/graph2d";

type MathfieldElementClass = typeof import("mathlive").MathfieldElement;
type MathfieldElementInstance = InstanceType<MathfieldElementClass>;

let MathfieldElement: MathfieldElementClass;

/** ショートカットが実際に書き出す TeX をグラフ変換器へ渡して検査する。 */
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

describe("graph expressions entered with math templates", () => {
  it.each([
    ["x", "2", "x^2"],
    ["2", "3", "2^3"],
    ["(x+1)", "2", "(x+1)^2"],
  ])("recognizes a shortcut power after %s", (base, exponent, expression) => {
    const field = createField(base);
    field.position = field.lastOffset;
    insertMathKeyboardMathTemplate(field, "{}^{#?}");
    field.executeCommand(["typedText", exponent]);
    const tex = getMathfieldLatex(field);
    expect(texToGraphExpressionWithError(tex), tex).toEqual({ expression });
  });

  it("evaluates a shortcut power inside a parameter bound", () => {
    const field = createField("10");
    field.position = field.lastOffset;
    insertMathKeyboardMathTemplate(field, "{}^{#?}");
    field.executeCommand(["typedText", "2"]);
    const parsed = texToGraphExpressionWithError(getMathfieldLatex(field));
    expect(parsed).toEqual({ expression: "10^2" });
    if ("expression" in parsed) expect(evaluateScalar(parsed.expression)).toBe(100);
  });
});
