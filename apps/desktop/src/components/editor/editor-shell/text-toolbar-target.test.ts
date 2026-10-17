import { describe, expect, it } from "vitest";
import type { OverlayShape } from "@/features/document";
import { formatOverlayTextBlocks, type OverlayTextBlock } from "@/features/document";
import { resolveTextToolbarMarkState, resolveTextToolbarTarget, type TextToolbarMarkState } from "./text-toolbar-target";

const base: Parameters<typeof resolveTextToolbarTarget>[0] = {
  selectedBlock: { id: "body", type: "paragraph" },
  documentTextTarget: null,
  hasTextRunSpan: false,
  runningRegionEditing: false,
  overlayEditing: false,
  overlaySelection: { selectedShapes: [] },
  bodyLocked: false,
  overlayLocked: false,
};

describe("text toolbar target", () => {
  it.each(["text", "callout", "tableShape"] as const)("routes an active %s editor to overlay even with a stale body selection", type => {
    const result = resolveTextToolbarTarget({ ...base, overlayEditing: true, overlaySelection: {
      selectedShapes: [{ id: "shape", type } as OverlayShape],
      textEditing: { shapeId: "shape", kind: type === "tableShape" ? "table" : "text" },
    } });
    expect(result).toMatchObject({ enabled: true, documentEnabled: false, overlayEnabled: true, target: "overlay" });
    expect(result.canUseOverlayBlockStructure).toBe(type !== "tableShape");
    expect(result.canUseLineHeight).toBe(type !== "tableShape");
  });

  it("does not enable a selected table or unrelated shape using a stale body target", () => {
    for (const type of ["tableShape", "geo"] as const) {
      expect(resolveTextToolbarTarget({ ...base, overlayEditing: true, overlaySelection: {
        selectedShapes: [{ id: "shape", type } as OverlayShape],
      } }).enabled).toBe(false);
    }
  });

  it("accepts a selected callout and disables it when its overlay is locked", () => {
    const context = { ...base, overlayEditing: true, overlaySelection: {
      selectedShapes: [{ id: "shape", type: "callout" } as OverlayShape],
    } };
    expect(resolveTextToolbarTarget(context).enabled).toBe(true);
    expect(resolveTextToolbarTarget({ ...context, overlayLocked: true }).enabled).toBe(false);
  });

  it("retains body, box title and running-region formatting with their structural limits", () => {
    expect(resolveTextToolbarTarget(base)).toMatchObject({ target: "document", enabled: true, canUseLineHeight: true });
    expect(resolveTextToolbarTarget({ ...base, selectedBlock: { id: "box", type: "boxBlock" },
      documentTextTarget: { enabled: true, blockId: "box", nodeType: "boxBlockTitle" },
    })).toMatchObject({ enabled: true, canUseLineHeight: false, canUseTextBlockStyle: false });
    expect(resolveTextToolbarTarget({ ...base, selectedBlock: null, runningRegionEditing: true }).enabled).toBe(true);
    expect(resolveTextToolbarTarget({ ...base, bodyLocked: true }).enabled).toBe(false);
  });

  it("shows a whole shape's own box so the box button can take it off again", () => {
    // Issue #210. The last caret reported "not boxed"; the selected shape's formula is boxed.
    const stale: TextToolbarMarkState = { bold: false, italic: false, underline: false, boxed: false, boxedVariant: "frame", boxedPaddingY: 0, boxedRoundness: 100 };
    const blocks: OverlayTextBlock[] = formatOverlayTextBlocks([{ type: "paragraph", id: "p", children: [
      { type: "mathInline", id: "m", tex: "x^2", display: "inline" },
    ] }], "boxedVariant", "double");
    const shape = { id: "shape", type: "text", props: { blocks } } as unknown as Extract<OverlayShape, { type: "text" }>;
    const target = resolveTextToolbarTarget({ ...base, overlayEditing: true, overlaySelection: { selectedShapes: [shape] } });

    expect(resolveTextToolbarMarkState(target.wholeTextShape, stale)).toMatchObject({ boxed: true, boxedVariant: "double" });
    // Pressing the button with that state sends "boxed", which now takes the box off.
    expect(resolveTextToolbarMarkState({ props: { blocks: formatOverlayTextBlocks(blocks, "boxed") } }, stale).boxed).toBe(false);
    // A text session keeps reporting its own caret.
    const editing = resolveTextToolbarTarget({ ...base, overlayEditing: true, overlaySelection: {
      selectedShapes: [shape], textEditing: { shapeId: "shape", kind: "text" },
    } });
    expect(resolveTextToolbarMarkState(editing.wholeTextShape, stale)).toBe(stale);
  });
});
