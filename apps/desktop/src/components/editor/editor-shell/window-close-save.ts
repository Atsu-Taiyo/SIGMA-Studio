import type { DocumentBoundarySkipReason } from "./workspace-request";
import { classifyBoundarySaveSafety } from "./boundary-save-policy";

export type WindowCloseOutcome = "ready" | "dialog";
export type WindowCloseSkipReasonKey =
  | "windowCloseSave.reason.externalChangePending"
  | "windowCloseSave.reason.aiWriteInProgress"
  | "windowCloseSave.reason.revisionUnknown";

/** Browser lifecycle events are not document boundaries in Electron: minimizing
 * or covering a BrowserWindow also changes its page visibility. */
export function shouldUsePageVisibilityBoundaryEvents(hasDesktopAppBridge: boolean): boolean {
  return !hasDesktopAppBridge;
}

export function describeWindowCloseSkipReason(
  reason: DocumentBoundarySkipReason | undefined,
): WindowCloseSkipReasonKey | undefined {
  switch (reason) {
    case "external-change-pending":
      return "windowCloseSave.reason.externalChangePending";
    case "ai-write-in-progress":
      return "windowCloseSave.reason.aiWriteInProgress";
    case "revision-unknown":
      return "windowCloseSave.reason.revisionUnknown";
    default:
      return undefined;
  }
}

export function resolveWindowCloseOutcome(input: {
  saveOk: boolean;
  saveError?: string;
  timedOut: boolean;
  dirty: boolean;
  skipped: boolean;
  skippedReason?: DocumentBoundarySkipReason;
}): WindowCloseOutcome {
  const safety = classifyBoundarySaveSafety({
    saveOk: input.saveOk,
    skipped: input.skipped,
    dirty: input.dirty,
  });
  return safety === "dirty-skipped" || safety === "dirty-unsaved" ? "dialog" : "ready";
}
