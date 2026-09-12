import type { SigmaDocument } from "@/features/document";
import type { DesktopStorageChangeEvent } from "@/types/desktop";
export interface EmbeddedEditorHost {
  document: SigmaDocument;
  onChange: (document: SigmaDocument) => void;
  onSave?: (document: SigmaDocument) => void | Promise<void>;
}
export type DocumentStorageChangeEvent = Extract<
  DesktopStorageChangeEvent,
  { type: "document" }
>;
