// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { publishLayoutSnapshot, readFragmentClientRect, type FragmentGeometrySnapshot } from "./layout-snapshot";
import { visibleBlockClientRect } from "./visible-block-rect";

afterEach(() => document.body.replaceChildren());

describe("published fragment geometry", () => {
  it("uses the same source and continuation rectangles at zoom, including nested hit targets", () => {
    const canvas = document.createElement("div");
    canvas.className = "page-canvas";
    canvas.innerHTML = '<div class="editor-box-fragment-viewport" data-box-source-id="body" data-box-fragment-index="1"><p>visible</p></div>';
    document.body.append(canvas);
    canvas.getBoundingClientRect = () => new DOMRect(20, 30, 599.7, 1500);
    canvas.style.setProperty("--editor-zoom", "1.5");
    Object.defineProperty(canvas, "offsetWidth", { value: 400 });
    const child = canvas.querySelector("p")!;
    child.getBoundingClientRect = () => new DOMRect(35, 290, 300, 140);
    const snapshot: FragmentGeometrySnapshot = {
      revision: 1,
      boxFragmentSourceLayouts: { body: { visibleHeight: 50, totalHeight: 130, origin: { x: 10, y: 20, width: 200 } } },
      boxBlockFragmentLayouts: { body: [{ blockId: "body", fragmentIndex: 1, sourceOffsetY: 50, height: 80, totalHeight: 130, x: 10, y: 200, width: 200 }] },
    };
    const unpublish = publishLayoutSnapshot(canvas, snapshot);
    expect(readFragmentClientRect(child, "body", 0)).toMatchObject({ x: 35, y: 60, width: 300, height: 75 });
    expect(readFragmentClientRect(child, "body", 1)).toMatchObject({ x: 35, y: 330, width: 300, height: 120 });
    expect(visibleBlockClientRect(child)).toMatchObject({ top: 330, bottom: 430 });
    const next = { ...snapshot, revision: 2, boxBlockFragmentLayouts: {} };
    const releaseNext = publishLayoutSnapshot(canvas, next);
    unpublish();
    expect(readFragmentClientRect(child, "body", 0)).not.toBeNull();
    expect(readFragmentClientRect(child, "body", 1)).toBeNull();
    releaseNext();
    expect(readFragmentClientRect(child, "body", 0)).toBeNull();
  });
});
