import { afterEach, expect, it, vi } from "vitest";
import { createBlankDocument } from "@/lib/blank-document";
import * as repository from "@/lib/workspace-repository";
import { createTemplateAtDestination } from "./workspace-template-commands";

const template = { version: 1 as const, id: "template", workspaceId: "source", name: "Template", document: createBlankDocument(), createdAt: "", updatedAt: "" };
afterEach(() => vi.restoreAllMocks());
it("uses the selected destination and never the template source workspace", async () => {
  const create = vi.spyOn(repository, "createDocumentFromTemplateInWorkspace").mockResolvedValue({} as never);
  await createTemplateAtDestination(template, { workspaceId: "destination", folderId: "shared-folder", canCreate: true });
  expect(create).toHaveBeenCalledExactlyOnceWith("destination", "shared-folder", expect.any(Object));
});
it("does not create any document for a viewer destination", async () => {
  const create = vi.spyOn(repository, "createDocumentFromTemplateInWorkspace");
  await expect(createTemplateAtDestination(template, { workspaceId: "destination", folderId: "shared-folder", canCreate: false })).rejects.toThrow("FORBIDDEN");
  expect(create).not.toHaveBeenCalled();
});
