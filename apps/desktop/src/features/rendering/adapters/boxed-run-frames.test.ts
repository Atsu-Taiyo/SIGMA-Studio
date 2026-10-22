// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { getEffectiveZoom } from "./boxed-inline-dom";
import { createBoxedRunFrameLayer, readBoxedRunFrames } from "./boxed-run-frames";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON: () => ({}) } as DOMRect;
}
function paragraph() {
  const p = document.createElement("p"); document.body.append(p);
  vi.spyOn(p, "getBoundingClientRect").mockReturnValue(rect(100, 50, 200, 60));
  return p;
}
function segment(p: HTMLElement, boxes: DOMRect[], id = "run", tone?: string) {
  const span = document.createElement("span");
  span.className = "boxed-text"; span.dataset.boxedRunHeightTarget = "true"; span.dataset.boxedRunId = id;
  if (tone) span.dataset.sigmaDocBoxedTone = tone;
  p.append(span); vi.spyOn(span, "getClientRects").mockReturnValue(boxes as unknown as DOMRectList);
  return span;
}

describe("connected text and math frames", () => {
  it("draws one frame across a canonical text / tall math / text run despite padding and math margins", () => {
    const p = paragraph();
    segment(p, [rect(100, 70, 30, 30)]).textContent = "潰れ区間";
    const math = segment(p, [rect(133, 50, 40, 60)]);
    math.dataset.sigmaDocBoxedMath = "true";
    segment(p, [rect(176, 85, 50, 30)]).textContent = "になるように代入する";
    expect(readBoxedRunFrames(p)).toEqual([
      { left: 0, top: 0, width: 126, height: 65, variant: null, tone: null },
    ]);
    expect(createBoxedRunFrameLayer(readBoxedRunFrames(p)).querySelectorAll(".boxed-run-frame")).toHaveLength(1);
  });

  it("joins a six-segment run when whitespace boxes share only 59% of its visible height", () => {
    const p = paragraph();
    // Measured Chromium inline-flex baseline geometry: whitespace sits higher
    // after equalisation, while text and the integral share their visible top.
    const rows: Array<[number, number, number, number, string]> = [
      [110.65625, 914.125, 21.993042, 34.671875, "[B]"],
      [132.649292, 914.125, 74.134583, 34.671875, "　潰れ区間"],
      [206.783875, 900, 2.003647, 34.671875, " "],
      [208.787522, 914.109375, 25.358536, 34.703125, "∫●●"],
      [234.146058, 900, 2.003632, 34.671875, " "],
      [236.14969, 914.125, 147.267334, 34.671875, "になるように代入する"],
    ];
    rows.forEach(([x, y, width, height, text]) => { segment(p, [rect(x, y, width, height)]).textContent = text; });
    expect(readBoxedRunFrames(p)).toEqual([
      { left: 10.66, top: 864.11, width: 272.76, height: 34.7, variant: null, tone: null },
    ]);
  });

  it("draws one frame across a bold label, a boxed space, a tall formula and a long tail (measured in the editor)", () => {
    const p = paragraph();
    // 「（参考）」(太字) + 全角空白 + 積分つきの数式 + 「　型だけは…」。editing view has no run id, so the
    // frame comes from the geometry alone: the space box (no baseline) sits high and short.
    const rows: Array<[number, number, number, number, string]> = [
      [100, 50, 70.8, 43.1, "（参考）"],
      [170.8, 62.7, 21.8, 18, "　"],
      [192.5, 50, 116.9, 43.1, "In=∫tanⁿx"],
      [308.4, 50, 390.8, 43.1, "　型だけは「部分積分」ではなく「式変形」で作る！"],
    ];
    rows.forEach(([x, y, width, height, text], index) => {
      const span = segment(p, [rect(x, y, width, height)]); span.textContent = text;
      span.removeAttribute("data-boxed-run-id");
      if (index === 2) span.dataset.sigmaDocBoxedMath = "true";
    });
    expect(readBoxedRunFrames(p)).toEqual([{ left: 0, top: 0, width: 599.2, height: 43.1, variant: null, tone: null }]);
  });

  it("keeps two frames when an unboxed full-width space separates two boxed runs", () => {
    const p = paragraph();
    // 囲んでいない空白は枠の外。隙間 (約 16px) は繋がない。
    for (const [x, width, text] of [[100, 86.8, "（参考）　"], [186.8, 116.9, "In="], [319.6, 375.8, "型だけは"]] as const) {
      const span = segment(p, [rect(x, 50, width, 43.1)]); span.textContent = text; span.removeAttribute("data-boxed-run-id");
    }
    expect(readBoxedRunFrames(p).map(f => [f.left, f.width])).toEqual([[0, 203.7], [219.6, 375.8]]);
  });

  it("keeps wrapped fragments apart even when a tall previous line overlaps the next line", () => {
    const p = paragraph();
    const first = segment(p, [rect(100, 50, 60, 60)]);
    first.dataset.sigmaDocBoxedMath = "true";
    segment(p, [rect(160, 75, 40, 25)]).textContent = "説明";
    segment(p, [rect(100, 105, 50, 25)]).textContent = "次の行";
    expect(readBoxedRunFrames(p).map(f => [f.left, f.top, f.width, f.height]))
      .toEqual([[0, 0, 100, 60], [0, 55, 50, 25]]);
  });

  it("does not bridge a horizontal gap when no canonical run identity is available", () => {
    const p = paragraph();
    const left = segment(p, [rect(100, 50, 40, 20)]);
    const right = segment(p, [rect(144, 50, 40, 20)]);
    left.removeAttribute("data-boxed-run-id"); right.removeAttribute("data-boxed-run-id");
    expect(readBoxedRunFrames(p)).toHaveLength(2);
  });

  it("uses separate horizontal and vertical scales for compressed overlay text", () => {
    const p = paragraph(); p.style.transform = "matrix(0.5, 0, 0, 1, 0, 0)";
    segment(p, [rect(105, 55, 20, 24)]); segment(p, [rect(125, 55, 30, 24)]);
    expect(getEffectiveZoom(p, "x")).toBe(0.5); expect(getEffectiveZoom(p, "y")).toBe(1);
    expect(readBoxedRunFrames(p)).toEqual([{ left: 10, top: 5, width: 100, height: 24, variant: null, tone: null }]);
  });
  it("keeps explicit wrapped lines and separate boxed runs distinct", () => {
    const p = paragraph();
    segment(p, [rect(100, 50, 40, 20), rect(100, 74, 20, 20)]);
    segment(p, [rect(120, 74, 30, 20)]);
    segment(p, [rect(150, 74, 20, 20)], "next", "blue");
    const frames = readBoxedRunFrames(p);
    expect(frames.map(f => [f.left, f.top, f.width, f.height])).toEqual([[0, 0, 40, 20], [0, 24, 50, 20], [50, 24, 20, 20]]);
    const layer = createBoxedRunFrameLayer(frames);
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(layer.querySelectorAll(".boxed-run-frame")).toHaveLength(3);
    expect(layer.lastElementChild?.getAttribute("data-sigma-doc-boxed-tone")).toBe("blue");
  });
  it("does not measure plain paragraphs", () => {
    const p = paragraph(); expect(readBoxedRunFrames(p)).toEqual([]);
    expect(p.getBoundingClientRect).not.toHaveBeenCalled();
  });
  it("keeps boundary spaces wide without letting their synthetic baseline raise the frame", () => {
    const p = paragraph();
    segment(p, [rect(100, 50, 5, 20)]).textContent = " ";
    segment(p, [rect(105, 56, 30, 20)]).textContent = "f(x)";
    segment(p, [rect(135, 56, 40, 20)]).textContent = "の最大値";
    segment(p, [rect(175, 50, 5, 20)]).textContent = "\u3000\u200B";
    expect(readBoxedRunFrames(p)).toEqual([
      { left: 0, top: 6, width: 80, height: 20, variant: null, tone: null },
    ]);
  });
  it("retains blank answer boxes on their own wrapped line", () => {
    const p = paragraph();
    segment(p, [rect(100, 50, 40, 20)]).textContent = "解答";
    segment(p, [rect(100, 74, 20, 24)]).textContent = " \u00a0 ";
    segment(p, [rect(120, 74, 30, 24)]).textContent = "\u3000";
    expect(readBoxedRunFrames(p).map(f => [f.left, f.top, f.width, f.height]))
      .toEqual([[0, 0, 40, 20], [0, 24, 50, 24]]);
  });
  it("includes a textless math atom's height alongside whitespace", () => {
    const p = paragraph();
    segment(p, [rect(100, 50, 5, 24)]).textContent = " ";
    const math = segment(p, [rect(105, 56, 40, 30)]);
    math.innerHTML = '<span class="math-preview"><svg></svg></span>';
    expect(readBoxedRunFrames(p)[0]).toMatchObject({ left: 0, top: 6, width: 45, height: 30 });
  });
  it("joins text and tall math with small baseline differences and preserves the ink", () => {
    const p = paragraph();
    const a = segment(p, [rect(100, 52, 20, 40)]);
    a.style.color = "rgb(255, 0, 0)";
    segment(p, [rect(120, 50, 40, 40)]);
    segment(p, [rect(160, 52, 20, 40)]);
    const frames = readBoxedRunFrames(p);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ left: 0, top: 0, width: 80, height: 42, color: "rgb(255, 0, 0)" });
    expect((createBoxedRunFrameLayer(frames).firstElementChild as HTMLElement).style.color).toBe("rgb(255, 0, 0)");
  });
});
