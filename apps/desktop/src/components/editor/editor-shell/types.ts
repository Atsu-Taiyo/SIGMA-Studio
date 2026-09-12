import type { SigmaDocument } from "@/features/document";

export type SaveState = "idle" | "saving" | "saved" | "warning" | "error";
export type EditorMenu = "file" | "insert" | "ai" | "settings" | null;
export type ColorStylePanel = "text" | "textBackground" | "stroke" | "fill" | null;
export type DocumentChange = SigmaDocument | ((current: SigmaDocument) => SigmaDocument);
export type DocumentChangeOptions = {
  coalesce?: boolean;
  deferRender?: boolean;
  historyGroup?: string;
};
