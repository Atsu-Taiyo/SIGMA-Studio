import { describe, expect, it } from "vitest";

import * as canonicalAppliedDiff from "./AiAppliedDocumentDiff";
import * as canonicalInlinePreview from "./AiEditInlinePreviewCard";
import * as canonicalSourceReferences from "./AiSourceReferenceChips";
import * as canonicalStreamRenderer from "./AiStreamRenderer";
import * as legacyAppliedDiff from "@/components/editor/AiAppliedDocumentDiff";
import * as legacyInlinePreview from "@/components/editor/AiEditInlinePreviewCard";
import * as legacySourceReferences from "@/components/editor/AiSourceReferenceChips";
import * as legacyStreamRenderer from "@/components/editor/AiStreamRenderer";

describe("legacy AI View compatibility facades", () => {
  it("re-exports the canonical React View implementations by identity", () => {
    expect(legacyAppliedDiff.AiAppliedDocumentDiffView).toBe(canonicalAppliedDiff.AiAppliedDocumentDiffView);
    expect(legacyInlinePreview.AiEditInlinePreviewCard).toBe(canonicalInlinePreview.AiEditInlinePreviewCard);
    expect(legacyInlinePreview.AiEditOverlayApprovalWidget).toBe(canonicalInlinePreview.AiEditOverlayApprovalWidget);
    expect(legacySourceReferences.AiSourceReferenceChips).toBe(canonicalSourceReferences.AiSourceReferenceChips);
    expect(legacyStreamRenderer.AiStreamRenderer).toBe(canonicalStreamRenderer.AiStreamRenderer);
  });
});
