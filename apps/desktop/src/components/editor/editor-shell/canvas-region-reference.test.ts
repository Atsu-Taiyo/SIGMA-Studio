import { describe, expect, it } from "vitest";
import { getDefaultPageLayout, type SigmaDocument } from "@/features/document";
import { createCanvasRegionAiEditReference, formatAiEditReferenceForPrompt, getAiEditReferenceKey } from "@/lib/ai/ai-edit-reference";
import { getDocumentIssues, parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { isCommentAnchorOrphan } from "@/lib/comments";
import { buildCommentAiReference } from "@/features/ai-edit/model/comment-reference";
import { createOverlaySelectionCommentAnchor } from "./overlay-helpers";
import { sameOverlaySelectionSummary } from "./document-helpers";
import { EMPTY_OVERLAY_SELECTION } from "./constants";

const bounds = { x: -240.5, y: -60, w: 200, h: 140 };
const anchor = { type: "canvasRegion" as const, bounds, quote: "選択した領域" };
const document: SigmaDocument = {
  version: "2.0", docId: "region_contract", metadata: { title: "領域" }, content: [],
  pageLayout: getDefaultPageLayout("whiteboard"),
  outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  comments: [{ id: "comment", anchor, messages: [{ id: "message", body: [{ type: "text", text: "図を描く" }], createdAt: "2026-09-14T00:00:00Z" }], createdAt: "2026-09-14T00:00:00Z" }],
};

describe("canvas region reference contracts", () => {
  it("round trips finite negative canvas coordinates without an object and keeps existing documents compatible", () => {
    const parsed = parseSigmaDocument(JSON.parse(JSON.stringify(document)));
    expect(parsed.comments?.[0].anchor).toEqual(anchor);
    expect(getDocumentIssues(parsed)).toEqual([]);
    expect(isCommentAnchorOrphan(parsed, anchor)).toBe(false);
    expect(parseSigmaDocument({ ...document, comments: undefined }).comments).toBeUndefined();
  });
  it.each([{ ...bounds, w: 0 }, { ...bounds, h: -1 }, { ...bounds, x: Infinity }, { ...bounds, y: NaN }])("rejects invalid saved region %j", (invalid) => {
    expect(() => parseSigmaDocument({ ...document, comments: [{ ...document.comments![0], anchor: { ...anchor, bounds: invalid } }] })).toThrow();
  });
  it("snapshots a region independently of selection and distinguishes ranges with no shape IDs", () => {
    const selection = { ...EMPTY_OVERLAY_SELECTION, region: { ...bounds } };
    const comment = createOverlaySelectionCommentAnchor(selection);
    expect(comment).toEqual(anchor);
    const reference = createCanvasRegionAiEditReference(selection.region);
    expect(buildCommentAiReference(document, anchor).reference).toEqual(reference);
    expect(formatAiEditReferenceForPrompt(reference)).toContain('"bounds":{"x":-240.5,"y":-60,"w":200,"h":140}');
    expect(reference.targetId).toBe("CANVAS");
    expect(formatAiEditReferenceForPrompt(reference)).not.toContain("*.png");
    selection.region.x = 99;
    expect(comment).toEqual(anchor);
    expect(reference.overlaySelection?.region).toEqual(bounds);
    expect(getAiEditReferenceKey(createCanvasRegionAiEditReference(selection.region))).not.toBe(getAiEditReferenceKey(reference));
    expect(sameOverlaySelectionSummary(selection, { ...selection, region: bounds })).toBe(false);
    expect(sameOverlaySelectionSummary({ ...selection, region: { ...bounds } }, { ...selection, region: bounds })).toBe(true);
  });
});
