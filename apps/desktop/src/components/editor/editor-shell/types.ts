import type { DocumentChangeOrigin, SigmaDocument } from "@/features/document";

export type SaveState = "idle" | "saving" | "saved" | "warning" | "error";
export type EditorMenu = "file" | "insert" | "ai" | "settings" | null;
export type ColorStylePanel = "text" | "textBackground" | "stroke" | "fill" | null;
export type DocumentChange = SigmaDocument | ((current: SigmaDocument) => SigmaDocument);
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
