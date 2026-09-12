import { describe, expect, it } from "vitest";
import { resolveProposalAttribution } from "./contracts";

describe("resolveProposalAttribution", () => {
  it("picks non-empty string fields and trims them", () => {
    expect(
      resolveProposalAttribution({ runId: " run_1 ", roomId: "room_1", turnId: "turn_1", sessionLabel: "label" }),
    ).toEqual({ runId: "run_1", roomId: "room_1", turnId: "turn_1", sessionLabel: "label" });
  });

  it("omits keys for missing, empty, or non-string values", () => {
    expect(resolveProposalAttribution({ runId: "", roomId: null, turnId: 42, sessionLabel: undefined })).toEqual({});
  });

  it("returns an empty object for null/undefined input", () => {
    expect(resolveProposalAttribution(null)).toEqual({});
    expect(resolveProposalAttribution(undefined)).toEqual({});
  });
});
