import { afterEach, describe, expect, it } from "vitest";

import {
  createOverlaySelectionAiEditReference,
  formatAiEditReferenceForPrompt,
  getReferenceDisplayLabel,
} from "@/lib/ai/ai-edit-reference";
import { createSigmaDocAgentSession, executeSigmaDocAgentDraftTool } from "@/lib/ai/sigma-doc-agent-tools";
import { applySigmaDocMutationOp } from "@/lib/ai/sigma-doc-edit-schema";
import { setValidationLocale } from "@/lib/ai/validation-locale";
import { createTranslator } from "@/lib/i18n";
import { getDefaultPageLayout } from "@/lib/page-layout";
import type { SigmaDocument } from "@/features/document";

const whiteboardDocument = (): SigmaDocument => ({
  version: "2.0",
  docId: "weekly-i18n-whiteboard",
  metadata: { title: "Whiteboard" },
  content: [],
  pageLayout: getDefaultPageLayout("whiteboard"),
  outputProfiles: {
    student: {},
    teacher: {},
    answerBook: {},
  },
});

afterEach(() => {
  setValidationLocale(null);
});

describe("localization for features merged during the weekly PR batch", () => {
  it("returns whiteboard tool errors in the active locale", () => {
    setValidationLocale("en");
    const session = createSigmaDocAgentSession({ document: whiteboardDocument(), selectedId: null });

    const bodyResult = executeSigmaDocAgentDraftTool(session, "draft_insert_body_content", {
      targetId: "CANVAS",
      blocks: ["Body"],
    });
    const targetResult = executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      id: "shape_without_canvas_target",
      kind: "rectangle",
      start: { x: 10, y: 20 },
      end: { x: 110, y: 80 },
    });
    const areaResult = executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "CANVAS",
      area: "prompt",
      id: "shape_with_area",
      kind: "rectangle",
      start: { x: 10, y: 20 },
      end: { x: 110, y: 80 },
    });

    expect(bodyResult).toMatchObject({
      ok: false,
      message: expect.stringContaining("Body content cannot be inserted"),
    });
    expect(targetResult).toMatchObject({
      ok: false,
      message: expect.stringContaining('targetId: "CANVAS"'),
    });
    expect(areaResult).toMatchObject({
      ok: false,
      message: expect.stringContaining("area parameter cannot be used"),
    });
  });

  it("returns whiteboard layout errors in the active locale", () => {
    setValidationLocale("en");

    expect(() => applySigmaDocMutationOp(whiteboardDocument(), {
      operation: "updatePageLayout",
      summary: "Switch to paper",
      patch: { preset: "A4" },
    })).toThrow("cannot be converted to a paged document");
    expect(() => applySigmaDocMutationOp(whiteboardDocument(), {
      operation: "setDocumentColumns",
      summary: "Change columns",
      columnCount: 2,
      columnGapMm: 8,
    })).toThrow("Columns cannot be changed");
  });

  it("formats selected overlay references in the active locale", () => {
    setValidationLocale("en");
    const selectedShape = {
      id: "shape_1",
      type: "geo" as const,
      x: 120,
      y: 80,
      props: {
        w: 160,
        h: 90,
        geo: "rectangle" as const,
        fill: "none" as const,
        color: "#111111",
        fillColor: "#ffffff",
        labelColor: "#111111",
        dash: "solid" as const,
        size: "m" as const,
      },
    };
    const reference = createOverlaySelectionAiEditReference({
      document: whiteboardDocument(),
      targetId: null,
      selectedShapeIds: [selectedShape.id],
      shapes: [selectedShape],
      assets: {},
    });

    expect(reference).not.toBeNull();
    if (!reference) {
      throw new Error("Expected an overlay selection reference");
    }
    expect(reference.excerpt).toBe("Selected shape count: 1");
    expect(formatAiEditReferenceForPrompt(reference)).toContain("Reference target: overlayShape");
    expect(formatAiEditReferenceForPrompt(reference)).toContain("Target shape ID: shape_1");
    expect(getReferenceDisplayLabel(reference, createTranslator("ja", "ai"), createTranslator("ja", "editor")))
      .toBe("図形1件");
  });
});
