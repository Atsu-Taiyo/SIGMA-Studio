import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { PageCanvasSelectionAction, PageCanvasSelectionExtension, PageCanvasSelectionSource } from "./editor-extension";
import { mergeSelectionExtensions } from "./selection-extension-merge";

const source: PageCanvasSelectionSource = { kind: "block", targetId: "p1" };

function extension(key: string | null, label: string): PageCanvasSelectionExtension & { clearCandidate: () => void } {
  return {
    createAction: () => key === null ? null : {
      key,
      render: () => <b>{label}</b>,
      notifyCandidate: vi.fn(),
    },
    clearCandidate: vi.fn(),
    retainCandidateOnTextSelectionClear: label === "ai",
  };
}

describe("mergeSelectionExtensions", () => {
  it("returns the other extension untouched when one side is missing", () => {
    const feature = extension("ai", "ai");
    expect(mergeSelectionExtensions(undefined, feature)).toBe(feature);
    expect(mergeSelectionExtensions(feature, undefined)).toBe(feature);
    expect(mergeSelectionExtensions(undefined, undefined)).toBeUndefined();
  });

  it("renders the editing tools before the feature action and combines the keys", () => {
    const merged = mergeSelectionExtensions(extension("tools", "tools"), extension("ai", "ai"))!;
    const action = merged.createAction(source) as PageCanvasSelectionAction;
    expect(JSON.parse(action.key)).toEqual(["tools", "ai"]);
    expect(renderToStaticMarkup(<>{action.render({ left: 0, top: 0 })}</>)).toBe("<b>tools</b><b>ai</b>");
  });

  it("still offers whichever side has something for this selection", () => {
    const onlyTools = mergeSelectionExtensions(extension("tools", "tools"), extension(null, "ai"))!;
    expect(onlyTools.createAction(source)?.key).toBe("tools");
    const onlyFeature = mergeSelectionExtensions(extension(null, "tools"), extension("ai", "ai"))!;
    expect(onlyFeature.createAction(source)?.key).toBe("ai");
    const neither = mergeSelectionExtensions(extension(null, "tools"), extension(null, "ai"))!;
    expect(neither.createAction(source)).toBeNull();
  });

  it("keeps candidate handling with the feature (the tools know nothing about AI references)", () => {
    const tools = extension("tools", "tools");
    const feature = extension("ai", "ai");
    const merged = mergeSelectionExtensions(tools, feature)!;
    merged.clearCandidate?.();
    expect(feature.clearCandidate).toHaveBeenCalledTimes(1);
    expect(tools.clearCandidate).not.toHaveBeenCalled();
    expect(merged.retainCandidateOnTextSelectionClear).toBe(true);
    const action = merged.createAction(source)!;
    action.notifyCandidate?.();
  });
});
