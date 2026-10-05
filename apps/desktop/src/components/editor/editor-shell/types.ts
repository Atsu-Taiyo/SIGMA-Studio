import type { SigmaDocument } from "@/features/document";

export type SaveState = "idle" | "saving" | "saved" | "warning" | "error";
export type EditorMenu = "file" | "insert" | "ai" | "settings" | null;
export type ColorStylePanel = "text" | "textBackground" | "stroke" | "fill" | null;
export type DocumentChange = SigmaDocument | ((current: SigmaDocument) => SigmaDocument);
/**
 * Where a document change comes from. Holds that only stop a human from changing what they cannot
 * see (a proposal shown as its result only) do not apply to an AI approval being applied, a version
 * restore or an external replacement. Absent means a human edit.
 */
export type DocumentChangeOrigin = "human-edit" | "ai-approval" | "history-restore" | "external";
/** Blocks and shapes a feature hides from the page (not editable by a human while hidden). */
export interface HiddenDocumentTargets {
  blockIds: ReadonlySet<string>;
  shapeIds: ReadonlySet<string>;
}
export type DocumentChangeOptions = {
  coalesce?: boolean;
  deferRender?: boolean;
  historyGroup?: string;
  origin?: DocumentChangeOrigin;
};
