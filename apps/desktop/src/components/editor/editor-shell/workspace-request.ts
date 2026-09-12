import type { DesktopStorageChangeEvent } from "@/types/desktop";
import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";

const DEFAULT_EDITOR_TRANSLATE = createCurrentLocaleTranslator("editor");

export type DegradedWatcherScope = Extract<DesktopStorageChangeEvent, { type: "watcher" }>["scope"];

export function updateDegradedWatcherScopes(
  current: DegradedWatcherScope[],
  event: DesktopStorageChangeEvent,
): DegradedWatcherScope[] {
  if (event.type !== "watcher") {
    return current;
  }
  if (event.change === "failed") {
    return current.includes(event.scope) ? current : [...current, event.scope];
  }
  return current.filter((scope) => scope !== event.scope);
}

export function degradedWatcherMessage(
  scopes: DegradedWatcherScope[],
  t: Translate<"editor"> = DEFAULT_EDITOR_TRANSLATE,
): string {
  const labels: Record<DegradedWatcherScope, string> = {
    documents: t("runtimeStatus.watcherScope.documents"),
    library: t("runtimeStatus.watcherScope.library"),
    mcpProposal: t("runtimeStatus.watcherScope.mcpProposal"),
  };
  return t("runtimeStatus.watcherUnavailable", {
    scopes: scopes.map((scope) => labels[scope]).join(t("runtimeStatus.watcherScopeSeparator")),
  });
}

export function isDesktopStorageChangeEvent(value: unknown): value is DesktopStorageChangeEvent {
  if (!value || typeof value !== "object") {
    return false;
  }

  const event = value as {
    type?: unknown;
    fileId?: unknown;
    scope?: unknown;
    change?: unknown;
    timestamp?: unknown;
    autoAppliedProposalIds?: unknown;
  };
  if (event.type === "workspace" || event.type === "library") {
    return typeof event.timestamp === "number";
  }

  if (event.type === "mcpProposal") {
    return event.change === "changed" && typeof event.timestamp === "number";
  }

  if (event.type === "documentVersion") {
    return typeof event.fileId === "string"
      && event.change === "captured"
      && typeof event.timestamp === "number";
  }

  if (event.type === "watcher") {
    return (event.scope === "documents" || event.scope === "library" || event.scope === "mcpProposal")
      && (event.change === "failed" || event.change === "recovered")
      && typeof event.timestamp === "number";
  }

  return (
    event.type === "document" &&
    typeof event.fileId === "string" &&
    (event.change === "changed" || event.change === "deleted") &&
    typeof event.timestamp === "number" &&
    (event.autoAppliedProposalIds === undefined || (
      Array.isArray(event.autoAppliedProposalIds)
      && event.autoAppliedProposalIds.every((proposalId) => typeof proposalId === "string")
    ))
  );
}

export function uniqueStringIds(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

export interface DocumentBoundarySafetyInput {
  isEmbedded: boolean;
  workspaceReady: boolean;
  activeDocumentOpenFailed: boolean;
  externalChangePending: boolean;
  aiWriteInProgress: boolean;
  observedRevision: number | null;
}

export type DocumentBoundarySkipReason =
  | "embedded"
  | "workspace-not-ready"
  | "document-open-failed"
  | "external-change-pending"
  | "ai-write-in-progress"
  | "revision-unknown";

export function getDocumentBoundarySkipReason(
  input: DocumentBoundarySafetyInput,
): DocumentBoundarySkipReason | undefined {
  if (input.isEmbedded) return "embedded";
  if (!input.workspaceReady) return "workspace-not-ready";
  if (input.activeDocumentOpenFailed) return "document-open-failed";
  if (input.externalChangePending) return "external-change-pending";
  if (input.aiWriteInProgress) return "ai-write-in-progress";
  if (input.observedRevision === null) return "revision-unknown";
  return undefined;
}

export function canCaptureDocumentBoundary(input: DocumentBoundarySafetyInput): boolean {
  return getDocumentBoundarySkipReason(input) === undefined;
}

export function createUnsavedEditBackupTitle(
  title: string,
  t: Translate<"editor"> = DEFAULT_EDITOR_TRANSLATE,
): string {
  return t("runtimeStatus.unsavedBackupTitle", { title: title || t("runtimeStatus.untitledDocument") });
}

export function getRequestedFileId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const fileId = new URLSearchParams(window.location.search).get("fileId")?.trim();
  return fileId || null;
}

export function clearRequestedFileId(): void {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  if (!url.searchParams.has("fileId")) {
    return;
  }

  url.searchParams.delete("fileId");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}
