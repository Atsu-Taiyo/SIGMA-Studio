import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalTemplateStore } from "./local-template-store";
import type { SigmaDocument } from "@/types/sigma-doc";

describe("LocalTemplateStore", () => {
  let userDataDir: string;
  let store: LocalTemplateStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "template-store-"));
    store = new LocalTemplateStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("creates, lists, renames, and deletes templates", async () => {
    const created = await store.createTemplate({
      workspaceId: "workspace_a",
      name: "  二段組プリント  ",
      document: sampleDocument(),
    });
    expect(created.name).toBe("二段組プリント");
    expect(created.workspaceId).toBe("workspace_a");

    expect(await store.listTemplates("workspace_a")).toEqual([created]);

    const renamed = await store.renameTemplate(created.id, "計算ドリル");
    expect(renamed).toMatchObject({ id: created.id, name: "計算ドリル", createdAt: created.createdAt });
    expect((await store.listTemplates("workspace_a"))[0]?.name).toBe("計算ドリル");

    await expect(store.deleteTemplate(created.id)).resolves.toEqual({ ok: true });
    expect(await store.listTemplates("workspace_a")).toEqual([]);
  });

  it("scopes templates by workspace", async () => {
    const inA = await store.createTemplate({ workspaceId: "workspace_a", name: "A用", document: sampleDocument() });
    const inB = await store.createTemplate({ workspaceId: "workspace_b", name: "B用", document: sampleDocument() });

    expect((await store.listTemplates("workspace_a")).map((t) => t.id)).toEqual([inA.id]);
    expect((await store.listTemplates("workspace_b")).map((t) => t.id)).toEqual([inB.id]);
    expect((await store.listTemplates()).map((t) => t.id).sort()).toEqual([inA.id, inB.id].sort());
  });

  it("rejects templates with an invalid document", async () => {
    await expect(
      store.createTemplate({
        workspaceId: "workspace_a",
        name: "壊れた",
        document: { version: "1.0" } as unknown as SigmaDocument,
      }),
    ).rejects.toThrow("テンプレートの内容が正しくありません。");
  });

  it("ignores invalid JSON and invalid template rows", async () => {
    await fs.mkdir(path.join(userDataDir, "data"), { recursive: true });
    const templatesPath = path.join(userDataDir, "data", "templates.json");

    await fs.writeFile(templatesPath, "{not json", "utf8");
    expect(await store.listTemplates()).toEqual([]);

    await fs.writeFile(templatesPath, JSON.stringify({
      version: 1,
      templates: [
        {
          version: 1,
          id: "template_valid",
          workspaceId: "workspace_a",
          name: "有効",
          document: sampleDocument(),
          createdAt: "2026-06-20T00:00:00.000Z",
          updatedAt: "2026-06-20T00:00:00.000Z",
        },
        {
          version: 1,
          id: "template_invalid",
          workspaceId: "workspace_a",
          name: "無効",
          document: { version: "broken" },
          createdAt: "2026-06-20T00:00:00.000Z",
          updatedAt: "2026-06-20T00:00:00.000Z",
        },
      ],
    }), "utf8");

    expect((await store.listTemplates()).map((template) => template.id)).toEqual(["template_valid"]);
  });

  it("returns an error result when deleting a missing template", async () => {
    await expect(store.deleteTemplate("missing")).resolves.toEqual({
      ok: false,
      error: "テンプレートが見つかりません。",
    });
  });
});

function sampleDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "template_doc",
    metadata: { title: "テンプレ教材" },
    content: [
      {
        id: "intro",
        type: "paragraph",
        children: [{ type: "text", text: "本文" }],
      },
    ],
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
  };
}
