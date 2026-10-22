// @vitest-environment happy-dom

import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { getMathfieldLatex } from "@/lib/math-keyboard-shortcuts";
import { installMathLiveHalfWidthInput } from "@/lib/mathlive-half-width-input";

type MathfieldElementClass = typeof import("mathlive").MathfieldElement;
type MathfieldElementInstance = InstanceType<MathfieldElementClass>;

let MathfieldElement: MathfieldElementClass;

/** 実物の MathLive の受け口 (`.ML__keyboard-sink`) に、IME が確定した文字を流して確かめる。 */
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

function createField(): { field: MathfieldElementInstance; sink: HTMLElement } {
  const field = new MathfieldElement();
  document.body.append(field);
  const sink = field.shadowRoot?.querySelector<HTMLElement>(".ML__keyboard-sink");
  if (!sink) throw new Error("MathLive keyboard sink was not found");
  installMathLiveHalfWidthInput(field.shadowRoot!);
  return { field, sink };
}

function withData<T extends Event>(event: T, props: Record<string, unknown>): T {
  for (const [name, value] of Object.entries(props)) {
    if ((event as unknown as Record<string, unknown>)[name] !== value) Object.defineProperty(event, name, { configurable: true, value });
  }
  return event;
}

const directInput = (sink: HTMLElement, data: string) => sink.dispatchEvent(withData(
  new InputEvent("input", { bubbles: true, composed: true, data }),
  { data, inputType: "insertText", isComposing: false },
));

const composeAndCommit = async (sink: HTMLElement, data: string) => {
  sink.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, composed: true }));
  sink.dispatchEvent(withData(new CompositionEvent("compositionupdate", { bubbles: true, composed: true, data }), { data }));
  sink.dispatchEvent(withData(new CompositionEvent("compositionend", { bubbles: true, composed: true, data }), { data }));
  // MathLive は変換の開始を次のフレームで入力欄の位置へ反映する。入力欄を片付ける前に済ませる。
  await new Promise((resolve) => setTimeout(resolve, 20));
};

describe("full-width input reaching a real MathLive field", () => {
  it("enters x+1 as math when a full-width direct input is committed", () => {
    const { field, sink } = createField();
    directInput(sink, "ｘ＋１");
    expect(getMathfieldLatex(field)).toBe("x+1");
  });

  it("enters x+1 as math when a full-width composition is committed", async () => {
    const { field, sink } = createField();
    await composeAndCommit(sink, "ｘ＋１");
    expect(getMathfieldLatex(field)).toBe("x+1");
  });

  it("types a full-width parenthesis the way the half-width key would", () => {
    const { field, sink } = createField();
    directInput(sink, "（");
    directInput(sink, "ａ");
    directInput(sink, "）");
    expect(getMathfieldLatex(field)).toBe("(a)");
  });

  it("without the installer a full-width character is not turned into math", () => {
    const field = new MathfieldElement();
    document.body.append(field);
    const sink = field.shadowRoot!.querySelector<HTMLElement>(".ML__keyboard-sink")!;
    directInput(sink, "ｘ＋１");
    expect(getMathfieldLatex(field)).not.toBe("x+1");
  });
});
