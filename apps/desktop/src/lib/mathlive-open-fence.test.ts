// @vitest-environment happy-dom

import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { getMathfieldLatex } from "@/lib/math-keyboard-shortcuts";
import { installMathLiveOpenFenceLatex, stripOpenFenceRightDelimiter } from "@/lib/mathlive-open-fence";

type MathfieldElementClass = typeof import("mathlive").MathfieldElement;
type MathfieldElementInstance = InstanceType<MathfieldElementClass>;

let MathfieldElement: MathfieldElementClass;

/**
 * 実物の MathLive で確かめる。Node では `mathlive` が SSR 版 (入力欄なし) に解決されるので、
 * 同じパッケージのブラウザ版を直接読む。
 */
async function importBrowserMathLive(): Promise<typeof import("mathlive")> {
  const ssrEntry = import.meta.resolve("mathlive");
  const browserEntry = pathToFileURL(join(dirname(new URL(ssrEntry).pathname), "mathlive.mjs")).href;
  return import(/* @vite-ignore */ browserEntry) as Promise<typeof import("mathlive")>;
}

beforeAll(async () => {
  // happy-dom に無い FontFaceSet と AudioContext を足す。音とフォントの読み込みは MathLive 側で切る
  // (削除のたびに鳴らそうとして AudioContext を作る)。
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

function createField(latex: string): MathfieldElementInstance {
  const field = new MathfieldElement();
  document.body.append(field);
  field.smartFence = true;
  field.value = latex;
  return field;
}

/** 末尾から Backspace した値の列 (アプリと同じく `getMathfieldLatex` で読む)。 */
function backspaceFromEnd(field: MathfieldElementInstance, times: number): string[] {
  field.executeCommand("moveToMathfieldEnd");
  const values: string[] = [];
  for (let index = 0; index < times; index += 1) {
    field.executeCommand("deleteBackward");
    values.push(getMathfieldLatex(field));
  }
  return values;
}

describe("stripOpenFenceRightDelimiter", () => {
  it("drops only the delimiter-less right side of a plain fence", () => {
    expect(stripOpenFenceRightDelimiter("(x.", { variant: "", rightDelim: "." })).toBe("(x");
    expect(stripOpenFenceRightDelimiter("(x)", { variant: "", rightDelim: ")" })).toBe("(x)");
    expect(stripOpenFenceRightDelimiter("(x.)", { variant: "", rightDelim: ")" })).toBe("(x.)");
    expect(stripOpenFenceRightDelimiter("\\left(x\\right.", { variant: "left...right", rightDelim: "." })).toBe("\\left(x\\right.");
    expect(stripOpenFenceRightDelimiter("\\mleft(x\\mright.", { variant: "mleft...mright", rightDelim: "." })).toBe("\\mleft(x\\mright.");
  });

  it("does nothing for a field without MathLive's model", () => {
    expect(installMathLiveOpenFenceLatex(null)).toBe(false);
    expect(installMathLiveOpenFenceLatex({ value: "(x)" })).toBe(false);
  });
});

describe("MathLive の閉じ括弧を消した括弧の書き出し", () => {
  // 1 つ目は直す前の MathLive そのもの。MathLive が自分で直したら、この前提ごと見直す。
  it("MathLive alone writes the deleted closing parenthesis as a trailing dot", () => {
    const field = createField("\\sin(x)");
    field.executeCommand("moveToMathfieldEnd");
    field.executeCommand("deleteBackward");
    expect(field.getValue()).toBe("\\sin(x.");
    field.remove();
  });

  it("reads sin(x) deleted from the end without any dot, and the value survives a reload", () => {
    const field = createField("\\sin(x)");
    expect(backspaceFromEnd(field, 4)).toEqual(["\\sin(x", "\\sin(", "\\sin", ""]);
    field.remove();

    const reopened = createField("\\sin(x)");
    backspaceFromEnd(reopened, 1);
    expect(reopened.value).toBe("\\sin(x");
    // 保存した値で開き直しても同じ式で、`.` は現れない。
    const reloaded = createField(reopened.value);
    expect(getMathfieldLatex(reloaded)).toBe("\\sin(x");
    reopened.remove();
    reloaded.remove();
  });

  it("covers nested parentheses, the Delete key and retyping the parenthesis", () => {
    const nested = createField("\\sin(\\cos(x))");
    expect(backspaceFromEnd(nested, 2)).toEqual(["\\sin(\\cos(x)", "\\sin(\\cos(x"]);
    nested.remove();

    const forward = createField("\\sin(x)");
    forward.executeCommand("moveToMathfieldEnd");
    forward.executeCommand("moveToPreviousChar");
    forward.executeCommand("deleteForward");
    expect(getMathfieldLatex(forward)).toBe("\\sin(x");
    forward.remove();

    const retyped = createField("\\sin(x)");
    backspaceFromEnd(retyped, 1);
    retyped.executeCommand(["typedText", ")"]);
    expect(getMathfieldLatex(retyped)).toBe("\\sin(x)");
    retyped.remove();
  });

  it("keeps what was already right: the opening side, \\left…\\right, and a typed dot", () => {
    const opening = createField("\\sin(x)");
    opening.executeCommand("moveToMathfieldStart");
    opening.executeCommand("moveToNextChar");
    opening.executeCommand("moveToNextChar");
    opening.executeCommand("deleteBackward");
    expect(getMathfieldLatex(opening)).toBe("\\sin x)");
    opening.remove();

    const command = createField("\\left(x\\right)");
    expect(backspaceFromEnd(command, 1)).toEqual(["\\left(x\\right."]);
    command.remove();

    const dot = createField("\\sin(x.)");
    expect(getMathfieldLatex(dot)).toBe("\\sin(x.)");
    dot.remove();
  });
});
