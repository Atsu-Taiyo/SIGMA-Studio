// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { measureFlowBlocks, type LineMeasureCache } from "./layout-measure";
import { measureElementLineBoxes } from "../overlay-canvas/anchor";

vi.mock("../overlay-canvas/anchor", async (importOriginal) => ({
  ...await importOriginal<typeof import("../overlay-canvas/anchor")>(),
  measureElementLineBoxes: vi.fn(() => [{ index: 0, top: 0, left: 0, width: 100, height: 20 }]),
}));

beforeEach(() => vi.clearAllMocks());

describe("intrinsic line measurement cache", () => {
  it("invalidates line positions after equal-size text edits and editor remounts", () => {
    const flow = document.createElement("div");
    flow.innerHTML = '<div class="ProseMirror" data-flow-measure-revision="1"><p data-sigma-doc-id="body">before</p></div>';
    const root = flow.firstElementChild as HTMLElement;
    const paragraph = root.firstElementChild as HTMLElement;
    const bounds = () => new DOMRect(0, 0, 100, 40);
    flow.getBoundingClientRect = bounds;
    paragraph.getBoundingClientRect = bounds;
    const cache: LineMeasureCache = new Map();
    measureFlowBlocks(flow, 1, 0, cache);
    measureFlowBlocks(flow, 1, 0, cache);
    expect(measureElementLineBoxes).toHaveBeenCalledTimes(1);
    root.dataset.flowMeasureRevision = "2";
    paragraph.textContent = "same outer size, different wrapping";
    vi.mocked(measureElementLineBoxes).mockReturnValueOnce([{ index: 0, top: 8, left: 0, width: 100, height: 25 }]);
    const changed = measureFlowBlocks(flow, 1, 0, cache);
    expect(changed.rects.get("body")?.lines?.[0]?.top).toBe(8);
    expect(measureElementLineBoxes).toHaveBeenCalledTimes(2);
    const replacement = paragraph.cloneNode(true) as HTMLElement;
    replacement.getBoundingClientRect = bounds;
    paragraph.replaceWith(replacement);
    measureFlowBlocks(flow, 1, 0, cache);
    expect(measureElementLineBoxes).toHaveBeenCalledTimes(3);
  });
});
