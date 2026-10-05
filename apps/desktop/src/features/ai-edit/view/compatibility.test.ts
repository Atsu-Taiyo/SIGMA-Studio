import { describe, expect, it } from "vitest";

import * as canonicalSourceReferences from "./AiSourceReferenceChips";
import * as canonicalStreamRenderer from "./AiStreamRenderer";
import * as legacySourceReferences from "@/components/editor/AiSourceReferenceChips";
import * as legacyStreamRenderer from "@/components/editor/AiStreamRenderer";

describe("legacy AI View compatibility facades", () => {
  it("re-exports the canonical React View implementations by identity", () => {
    expect(legacySourceReferences.AiSourceReferenceChips).toBe(canonicalSourceReferences.AiSourceReferenceChips);
    expect(legacyStreamRenderer.AiStreamRenderer).toBe(canonicalStreamRenderer.AiStreamRenderer);
  });
});
