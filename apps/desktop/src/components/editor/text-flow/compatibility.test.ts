import { describe, expect, it } from "vitest";

import * as textEditing from "@/features/text-editing";

import * as legacyBlockModel from "./block-model";
import * as legacyBlockSync from "./block-sync";
import * as legacyManualPageBreak from "./manual-page-break";
import * as legacyNormalization from "./normalization";

describe("legacy text-flow compatibility facades", () => {
  it("re-exports every canonical model function by identity", () => {
    expectCanonicalIdentities(legacyBlockModel);
    expectCanonicalIdentities(legacyBlockSync);
    expectCanonicalIdentities(legacyNormalization);
  });

  it("re-exports every canonical application function by identity", () => {
    expectCanonicalIdentities(legacyManualPageBreak);
  });

  function expectCanonicalIdentities(
    legacyModule: Record<string, unknown>,
  ): void {
    for (const [name, value] of Object.entries(legacyModule)) {
      expect(value, name).toBe(
        (textEditing as unknown as Record<string, unknown>)[name],
      );
    }
  }
});
