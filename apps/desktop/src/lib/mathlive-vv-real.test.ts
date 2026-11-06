// @vitest-environment happy-dom

import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createMathRenderEnvironment } from "@/lib/math-environment";
import { getMathfieldLatex } from "@/lib/math-keyboard-shortcuts";
import { configureInlineMathLiveField, type InlineMathLiveFieldElement } from "@/lib/mathlive-config";
import { drawVvEditorArrows } from "@/lib/mathlive-vv";
import { VV_ARROW_CLASS, VV_SLOT_STYLE } from "@/lib/vv-vector";

type MathfieldElementClass = typeof import("mathlive").MathfieldElement;
type MathfieldElementInstance = InstanceType<MathfieldElementClass>;

let MathfieldElement: MathfieldElementClass;

/**
 * The real MathLive (loaded as in `mathlive-script-navigation-real.test.ts`).
 * `mathlive-vv.ts` reads MathLive's internal atom tree (`_mathfield.model`,
 * the macro atom's `_serialize`, branch names, rendered classes), so a
 * MathLive upgrade that changes it fails here first.
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

/** MathLive renders, and answers typed text for its virtual keyboard, on the next frame. */
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

afterEach(async () => {
  await nextFrame();
  document.body.innerHTML = "";
});

const L = String.raw;

/** A field set up as the app sets up inline math, with the document's preamble. */
function createField(latex: string, preamble = ""): MathfieldElementInstance {
  const field = new MathfieldElement();
  document.body.append(field);
  configureInlineMathLiveField(field as unknown as InlineMathLiveFieldElement, createMathRenderEnvironment(preamble));
  field.value = latex;
  return field;
}

interface RealAtom { type?: string; command?: string; parent?: RealAtom; parentBranch?: unknown }
interface RealModel { atoms: RealAtom[]; at: (offset: number) => RealAtom; offsetOf: (atom: RealAtom) => number }
const modelOf = (field: MathfieldElementInstance) => (field as unknown as { _mathfield: { model: RealModel } })._mathfield.model;
const arrows = (field: MathfieldElementInstance) => field.shadowRoot?.querySelectorAll(`.${VV_ARROW_CLASS}`).length ?? 0;

/** Type `text` with the caret after the operand's `label`. */
function typeAfter(field: MathfieldElementInstance, label: string, text: string) {
  const offset = modelOf(field).atoms.findIndex((atom) => atom.command === label);
  expect(offset, label).toBeGreaterThan(0);
  field.position = offset;
  field.executeCommand(["typedText", text]);
}

/** A built-in `\vv` edited on this page first, as when the reviewer saw a document's own `\vv` change. */
function editBuiltInVector() {
  const builtIn = createField(L`\vv{AB}`);
  typeAfter(builtIn, "A", "C");
  expect(getMathfieldLatex(builtIn)).toBe(L`\vv{ACB}`);
  return builtIn;
}

describe("the built-in \\vv in a real MathLive field", () => {
  it("writes the edited operand back as \\vv{…}, upright operands included", () => {
    editBuiltInVector();
    const roman = createField(L`\vv{\mathrm{OA}}+\vv{\mathrm{OB}}`);
    typeAfter(roman, "+", "2");
    expect(getMathfieldLatex(roman)).toBe(L`\vv{\mathrm{OA}}+2\vv{\mathrm{OB}}`);
  });

  it("draws one arrow per vector in its box and sets the slot's text-size style", async () => {
    const field = createField(L`\vv{AB}+\vv{\mathrm{OA}}`);
    await nextFrame();
    const root = field.shadowRoot!;
    expect(arrows(field)).toBe(2);
    for (const arrow of root.querySelectorAll(`.${VV_ARROW_CLASS}`)) {
      expect(arrow.parentElement?.classList.contains("ML__vlist")).toBe(true);
      const slot = [...arrow.parentElement!.children].find((row) => row.querySelector(".ML__rule"))?.lastElementChild;
      expect(slot?.getAttribute("style")).toBe(VV_SLOT_STYLE);
    }
    // Drawn once per render: a second pass finds every vector done, and a re-render is drawn again.
    expect(drawVvEditorArrows(field, root)).toBe(0);
    for (const arrow of root.querySelectorAll(`.${VV_ARROW_CLASS}`)) arrow.remove();
    expect(drawVvEditorArrows(field, root)).toBe(2);
  });

  it("keeps the caret on the operand: the macro's edges and the invisible slot are skipped", () => {
    // `x\vv{AB}+1`: 0 root start, 1 x, 2 macro start, 3 operand start, 4 A, 5 B, 6 slot start,
    // 7 phantom start, 8 rule, 9 phantom, 10 the box, 11 the macro, 12 +, 13 1.
    const field = createField(L`x\vv{AB}+1`);
    const model = modelOf(field);
    expect([1, 4, 5, 12].map((offset) => model.at(offset).command)).toEqual(["x", "A", "B", "+"]);
    expect(model.at(2)).toMatchObject({ type: "first", parent: { type: "macro", command: L`\vv` } });
    expect(model.at(3)).toMatchObject({ type: "first", parentBranch: "body", parent: { command: L`\overset` } });
    expect(model.at(6)).toMatchObject({ type: "first", parentBranch: "above", parent: { command: L`\overset` } });
    expect(model.at(8)).toMatchObject({ command: L`\rule`, parent: { command: L`\phantom`, parentBranch: "above" } });
    expect(model.at(11)).toMatchObject({ type: "macro", command: L`\vv` });
    // Each move (a click or an arrow key) from `from` to `to` lands where the caret guard puts it.
    const land = (from: number, to: number) => {
      field.position = from;
      field.position = to;
      return field.position;
    };
    expect(land(1, 2)).toBe(3);
    expect(land(3, 2)).toBe(1);
    for (const slot of [6, 7, 8, 9]) {
      expect(land(5, slot), `forward to ${slot}`).toBe(11);
      expect(land(11, slot), `back to ${slot}`).toBe(5);
    }
    expect(land(11, 10)).toBe(5);
    // A click on the arrow puts the caret at the operand's end, and typing goes there.
    land(12, 8);
    field.executeCommand(["typedText", "C"]);
    expect(getMathfieldLatex(field)).toBe(L`x\vv{ABC}+1`);
  });
});

describe("a document's own \\vv on the same page", () => {
  const OWN = L`\newcommand{\vv}[1]{\overset{x}{#1}+#1}`;

  it("is serialized by MathLive as written, even after a built-in vector was edited", async () => {
    editBuiltInVector();
    const own = createField(L`\vv{AB}`, OWN);
    expect(getMathfieldLatex(own)).toBe(L`\vv{AB}`);
    own.executeCommand("moveToMathfieldEnd");
    own.executeCommand(["typedText", "y"]);
    expect(getMathfieldLatex(own)).toBe(L`\vv{AB}y`);
    await nextFrame();
    expect(arrows(own)).toBe(0);
    // No caret guard: MathLive keeps the caret where it is put inside the macro.
    own.position = 1;
    expect(own.position).toBe(1);
  });

  it("takes over a field that had the built-in \\vv", async () => {
    const builtIn = editBuiltInVector();
    configureInlineMathLiveField(builtIn as unknown as InlineMathLiveFieldElement, createMathRenderEnvironment(OWN));
    builtIn.value = L`\vv{AB}`;
    expect(getMathfieldLatex(builtIn)).toBe(L`\vv{AB}`);
    await nextFrame();
    expect(arrows(builtIn)).toBe(0);
  });
});
