import { createDocumentFromTemplate } from "@/lib/templates";
import { createDocumentFromTemplateInWorkspace } from "@/lib/workspace-repository";
import type { TemplateItem } from "@/types/template";

/** The visible destination owns permission and placement; the template only supplies content. */
export async function createTemplateAtDestination(template: TemplateItem, destination: {
  workspaceId: string; folderId: string | null; canCreate: boolean;
}) {
  if (!destination.canCreate) throw new Error("FORBIDDEN");
  return createDocumentFromTemplateInWorkspace(
    destination.workspaceId, destination.folderId, createDocumentFromTemplate(template),
  );
}
