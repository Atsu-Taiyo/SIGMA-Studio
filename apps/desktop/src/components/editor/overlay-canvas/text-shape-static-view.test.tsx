// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CALLOUT_TEXT_PADDING } from "@/features/drawing";

import { OverlayShapeReadOnlyView, OverlayTextShapeStaticView } from "./shape-renderer";
import type { OverlayShape } from "./types";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const CONTENT_SELECTOR = ".overlay-text-shape-content";

function rect(height: number, width = 100): DOMRect {
  return {
    x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}),
  } as DOMRect;
}

/** Makes the content element report `height` and nothing else report anything. */
function mockContentHeight(height: number): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("overlay-text-shape-content") ? rect(height) : rect(0, 0);
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("overlay-text-shape-content") ? height : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("overlay-text-shape-content") ? height : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("overlay-text-shape-content") ? 100 : 0;
  });
}

function textShape(props: Partial<Extract<OverlayShape, { type: "text" }>["props"]> = {}, rotation = 0): Extract<OverlayShape, { type: "text" }> {
  return {
    id: "shape_text",
    type: "text",
    x: 10,
    y: 20,
    rotation,
    props: {
      w: 200,
      h: 16,
      color: "#111827",
      size: "m",
      blocks: [{ type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文" }] }],
      ...props,
    },
  };
}

function calloutShape(): Extract<OverlayShape, { type: "callout" }> {
  return {
    id: "shape_callout",
    type: "callout",
    x: 0,
    y: 0,
    props: {
      w: 160,
      h: 40,
      radius: 8,
      tail: { baseStart: { x: 0, y: 40 }, baseEnd: { x: 20, y: 40 }, tip: { x: 10, y: 60 } },
      color: "#111827",
      size: "m",
      dash: "solid",
      strokeWidth: "m",
      blocks: [{ type: "paragraph", id: "p_1", children: [{ type: "text", text: "説明" }] }],
    },
  };
}

async function render(element: React.ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("the static view's height write-back", () => {
  it("reports the height the drawn text needs", async () => {
    mockContentHeight(64);
    const onMeasuredHeight = vi.fn();

    await render(<OverlayTextShapeStaticView shape={textShape()} onMeasuredHeight={onMeasuredHeight} />);

    expect(onMeasuredHeight).toHaveBeenCalledWith("shape_text", 64);
  });

  it("reports the same height again after the author changes the width", async () => {
    mockContentHeight(48);
    const onMeasuredHeight = vi.fn();

    await render(<OverlayTextShapeStaticView shape={textShape({ w: 180 })} onMeasuredHeight={onMeasuredHeight} />);
    expect(onMeasuredHeight).toHaveBeenCalledTimes(1);

    // A resize frame can write the old cached height after the first measurement. Even if the
    // final width still wraps to 48px, it needs a fresh report to repair that overwritten cache.
    onMeasuredHeight.mockClear();
    await render(<OverlayTextShapeStaticView shape={textShape({ w: 90 })} onMeasuredHeight={onMeasuredHeight} />);

    expect(onMeasuredHeight).toHaveBeenCalledWith("shape_text", 48);
  });

  /**
   * A callout's text is drawn inside the rect its geometry already inset by the padding, so the
   * content height has to have that padding put back before it can mean `props.h`.
   */
  it("puts a callout's padding back before reporting its box height", async () => {
    mockContentHeight(64);
    const onMeasuredHeight = vi.fn();

    await render(<OverlayTextShapeStaticView shape={calloutShape()} onMeasuredHeight={onMeasuredHeight} />);

    expect(onMeasuredHeight).toHaveBeenCalledWith("shape_callout", 64 + CALLOUT_TEXT_PADDING * 2);
  });

  /**
   * Read-only surfaces — print, PDF, the embedded viewer, AI previews — draw from the stored
   * height and must not write anything back; the callback is what turns measuring on at all.
   */
  it("does not measure at all on a surface that cannot write back", async () => {
    const getRect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");

    await render(<OverlayTextShapeStaticView shape={textShape()} />);

    expect(getRect).not.toHaveBeenCalled();
  });

  /**
   * PR #447: a rotated shape's descendant rects are axis-aligned bounding boxes, so reading them
   * back would report the diagonal as the height and grow the box on every measurement.
   */
  it("reads a rotated shape's own layout height, not its rotated bounding box", async () => {
    const localHeight = 24;
    const rotatedAabb = 200;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => rect(rotatedAabb, rotatedAabb));
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("overlay-text-shape-content") ? localHeight : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("overlay-text-shape-content") ? localHeight : 0;
    });
    const onMeasuredHeight = vi.fn();

    await render(
      <OverlayTextShapeStaticView shape={textShape({}, Math.PI / 4)} onMeasuredHeight={onMeasuredHeight} />,
    );

    expect(onMeasuredHeight).toHaveBeenCalledWith("shape_text", localHeight);
    expect(onMeasuredHeight).not.toHaveBeenCalledWith("shape_text", rotatedAabb);
  });
});

describe("the static view's box", () => {
  it("uses a locally measured height on a read-only surface without changing the source shape", async () => {
    mockContentHeight(64);
    const shape = textShape({ h: 16 });

    await render(<OverlayShapeReadOnlyView shape={shape} assets={{}} />);

    const wrapper = container.querySelector<HTMLElement>(".overlay-shape-text");
    expect(wrapper?.style.height).toBe("64px");
    expect(shape.props.h).toBe(16);
  });

  /**
   * Width is the user's and the font size is independent of it: widening a shape changes how many
   * characters fit on a line, never how big they are. Where the text actually breaks is a layout
   * question and belongs to the e2e; what is pinned here is that the box hands the width to the
   * content and takes the font size from the shape's own type size.
   */
  it("takes its width from the shape and its font size from the shape's type size", async () => {
    await render(<OverlayTextShapeStaticView shape={textShape({ w: 200 })} />);
    const narrow = container.querySelector<HTMLElement>(".overlay-text-shape");
    const narrowStyle = { width: narrow?.style.width, fontSize: narrow?.style.fontSize };

    await render(<OverlayTextShapeStaticView shape={textShape({ w: 400 })} />);
    const wide = container.querySelector<HTMLElement>(".overlay-text-shape");

    expect(narrowStyle.width).toBe("200px");
    expect(wide?.style.width).toBe("400px");
    expect(wide?.style.fontSize).toBe(narrowStyle.fontSize);
  });

  it("wraps inside the box rather than letting a long word run past it", async () => {
    await render(<OverlayTextShapeStaticView shape={textShape()} />);
    const content = container.querySelector<HTMLElement>(CONTENT_SELECTOR);

    // The rules themselves live in `document-surface.css` on this class; what is pinned here is
    // that the static view puts the content on the element those rules select.
    expect(content).not.toBeNull();
    expect(content?.className).toContain("overlay-text-shape-content");
  });
});
