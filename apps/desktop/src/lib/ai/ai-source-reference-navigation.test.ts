import { describe, expect, it } from "vitest";

import {
  resolveSourceReferenceBlockId,
  resolveSourceReferenceNavigationTarget,
} from "@/lib/ai/ai-source-reference-navigation";
import type { OverlayGeoShape } from "@/features/document";
import type { SigmaDocument } from "@/types/sigma-doc";

function createDocument(content: SigmaDocument["content"]): SigmaDocument {
  return { content } as SigmaDocument;
}

function rectShape(id: string, blockId: string): OverlayGeoShape {
  return {
    id,
    type: "geo",
    x: 0,
    y: 0,
    rotation: 0,
    anchor: { type: "block", blockId, dy: 0 },
    props: {
      w: 180,
      h: 96,
      geo: "rectangle",
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
    },
  } as OverlayGeoShape;
}

describe("resolveSourceReferenceNavigationTarget", () => {
  it("returns null targets for missing or title-only references", () => {
    const document = createDocument([]);

    expect(resolveSourceReferenceNavigationTarget(document)).toEqual({
      selectionId: null,
      highlightId: null,
      highlightKind: "block",
    });
    expect(resolveSourceReferenceNavigationTarget(document, "__title__")).toEqual({
      selectionId: null,
      highlightId: null,
      highlightKind: "block",
    });
  });

  it("targets a top-level paragraph block", () => {
    const document = createDocument([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文" }] },
    ]);

    expect(resolveSourceReferenceNavigationTarget(document, "p_1")).toEqual({
      selectionId: "p_1",
      highlightId: "p_1",
      highlightKind: "block",
    });
  });

  it("targets a nested problem prompt block", () => {
    const document = createDocument([
      {
        type: "problem",
        id: "problem_1",
        tags: [],
        lead: [],
        prompt: [{ type: "paragraph", id: "prompt_1", children: [{ type: "text", text: "設問" }] }],
        hints: [],
        solution: [],
      },
    ]);

    expect(resolveSourceReferenceNavigationTarget(document, "prompt_1")).toEqual({
      selectionId: "prompt_1",
      highlightId: "prompt_1",
      highlightKind: "block",
    });
  });

  it("highlights a whole problem when cited by problem id", () => {
    const document = createDocument([
      {
        type: "problem",
        id: "problem_1",
        tags: [],
        lead: [],
        prompt: [{ type: "paragraph", id: "prompt_1", children: [{ type: "text", text: "設問" }] }],
        hints: [],
        solution: [],
      },
    ]);

    expect(resolveSourceReferenceNavigationTarget(document, "problem_1")).toEqual({
      selectionId: "problem_1",
      highlightId: "problem_1",
      highlightKind: "problem",
    });
  });

  it("highlights an overlay shape while selecting its anchor block", () => {
    const document = {
      content: [{ type: "paragraph", id: "anchor_1", children: [{ type: "text", text: "本文" }] }],
      pageLayout: {
        overlay: {
          overlaySnapshot: {
            version: 1,
            assets: {},
            shapes: [rectShape("shape_1", "anchor_1")],
          },
        },
      },
    } as unknown as SigmaDocument;

    expect(resolveSourceReferenceNavigationTarget(document, "shape_1")).toEqual({
      selectionId: "anchor_1",
      highlightId: "shape_1",
      highlightKind: "overlayShape",
    });
  });
});

describe("resolveSourceReferenceBlockId", () => {
  it("returns the selection id from the navigation target", () => {
    const document = createDocument([
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文" }] },
    ]);

    expect(resolveSourceReferenceBlockId(document, "p_1")).toBe("p_1");
  });
});
