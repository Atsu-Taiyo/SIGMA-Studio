import { afterEach, describe, expect, it, vi } from "vitest";
import * as storage from "@/lib/storage";
import type { SigmaDocument } from "@/features/document";
import type { TemplateItem } from "@/types/template";
import { customPageSetupDocument } from "../../../../tests/helpers/template-fixtures";
import { createMaterialFromTemplate } from "./create-material-from-template";

afterEach(() => vi.restoreAllMocks());

function template(document: SigmaDocument): TemplateItem {
  return { version: 1, id: "template", workspaceId: "source", name: "B5横プリント", document, createdAt: "", updatedAt: "" };
}

describe("createMaterialFromTemplate", () => {
  it("creates a new file whose page setup, header and shapes are the template's own", async () => {
    const source = customPageSetupDocument();
    const snapshot = structuredClone(source);
    const create = vi.spyOn(storage, "createDocumentFromSigmaDocument").mockResolvedValue({} as never);

    await createMaterialFromTemplate(template(source), { workspaceId: "destination", folderId: "folder" });

    expect(create).toHaveBeenCalledExactlyOnceWith(expect.any(Object), { workspaceId: "destination", folderId: "folder" });
    const created = create.mock.calls[0][0];
    expect(created.pageLayout).toEqual(snapshot.pageLayout);
    expect(created.content).toEqual(snapshot.content);
    expect(created.docId).not.toBe(source.docId);
    expect(created.metadata.title).toBe("B5横プリント");
    // テンプレート側は書き換えず、作った教材と参照を共有しない。
    expect(source).toEqual(snapshot);
    expect(created.pageLayout).not.toBe(source.pageLayout);
  });

  it("leaves the destination to the storage default when none was decided", async () => {
    const create = vi.spyOn(storage, "createDocumentFromSigmaDocument").mockResolvedValue({} as never);
    await createMaterialFromTemplate(template(customPageSetupDocument()));
    expect(create).toHaveBeenCalledExactlyOnceWith(expect.any(Object), undefined);
  });
});
