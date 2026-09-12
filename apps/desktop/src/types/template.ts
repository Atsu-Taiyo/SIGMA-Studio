import type { SigmaDocument } from "@/features/document";

export interface TemplateItem {
  version: 1;
  id: string;
  /** Workspace this template belongs to. Templates are grouped by workspace in the gallery tabs. */
  workspaceId: string;
  name: string;
  /** A template is a full document; using it inserts its content or spins up a new document. */
  document: SigmaDocument;
  createdAt: string;
  updatedAt: string;
}
