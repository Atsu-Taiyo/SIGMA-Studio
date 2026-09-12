import { describe, expect, it } from "vitest";

import {
  describeWindowCloseSkipReason,
  resolveWindowCloseOutcome,
  shouldUsePageVisibilityBoundaryEvents,
} from "./window-close-save";

describe("shouldUsePageVisibilityBoundaryEvents", () => {
  it("uses browser lifecycle boundaries only without the Electron app bridge", () => {
    expect(shouldUsePageVisibilityBoundaryEvents(false)).toBe(true);
    expect(shouldUsePageVisibilityBoundaryEvents(true)).toBe(false);
  });
});

describe("describeWindowCloseSkipReason", () => {
  it.each([
    ["external-change-pending", "windowCloseSave.reason.externalChangePending"],
    ["ai-write-in-progress", "windowCloseSave.reason.aiWriteInProgress"],
    ["revision-unknown", "windowCloseSave.reason.revisionUnknown"],
  ] as const)("maps %s to its specific message key", (reason, expected) => {
    expect(describeWindowCloseSkipReason(reason)).toBe(expected);
  });

  it.each([
    undefined,
    "embedded",
    "workspace-not-ready",
    "document-open-failed",
  ] as const)("leaves %s on the generic fallback", (reason) => {
    expect(describeWindowCloseSkipReason(reason)).toBeUndefined();
  });
});

describe("resolveWindowCloseOutcome", () => {
  it.each([
    ["saved and clean", { saveOk: true, timedOut: false, dirty: false, skipped: false }, "ready"],
    ["saved while newer edits remain", { saveOk: true, timedOut: false, dirty: true, skipped: false }, "dialog"],
    ["failed but no edits remain", { saveOk: false, saveError: "failed", timedOut: false, dirty: false, skipped: false }, "ready"],
    ["timed out with unsaved edits", { saveOk: false, timedOut: true, dirty: true, skipped: false }, "dialog"],
    ["failed with unsaved edits", { saveOk: false, saveError: "failed", timedOut: false, dirty: true, skipped: false }, "dialog"],
    ["external change blocks a dirty save", { saveOk: true, timedOut: false, dirty: true, skipped: true, skippedReason: "external-change-pending" as const }, "dialog"],
    ["AI writing blocks a dirty save", { saveOk: true, timedOut: false, dirty: true, skipped: true, skippedReason: "ai-write-in-progress" as const }, "dialog"],
    ["unknown revision blocks a dirty save", { saveOk: true, timedOut: false, dirty: true, skipped: true, skippedReason: "revision-unknown" as const }, "dialog"],
    ["embedded dirty state blocks after a skip", { saveOk: true, timedOut: false, dirty: true, skipped: true, skippedReason: "embedded" as const }, "dialog"],
    ["an unready dirty workspace blocks after a skip", { saveOk: true, timedOut: false, dirty: true, skipped: true, skippedReason: "workspace-not-ready" as const }, "dialog"],
    ["a dirty open failure blocks after a skip", { saveOk: true, timedOut: false, dirty: true, skipped: true, skippedReason: "document-open-failed" as const }, "dialog"],
    ["an unexplained dirty skip blocks", { saveOk: true, timedOut: false, dirty: true, skipped: true }, "dialog"],
    ["a clean skip can continue", { saveOk: true, timedOut: false, dirty: false, skipped: true }, "ready"],
  ])("returns the expected outcome when %s", (_label, input, expected) => {
    expect(resolveWindowCloseOutcome(input)).toBe(expected);
  });
});
