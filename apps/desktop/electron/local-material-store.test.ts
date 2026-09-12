import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalMaterialStore } from "./local-material-store";
import type { MaterialContent } from "@/types/material";

describe("LocalMaterialStore", () => {
  let userDataDir: string;
  let store: LocalMaterialStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "material-store-"));
    store = new LocalMaterialStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("creates, lists, renames, and deletes materials", async () => {
    const created = await store.createMaterial({
      name: "  公式セット  ",
      content: emptyMaterialContent(),
    });
    expect(created.name).toBe("公式セット");

    expect(await store.listMaterials()).toEqual([created]);

    const renamed = await store.renameMaterial(created.id, "頻出図形");
    expect(renamed).toMatchObject({
      id: created.id,
      name: "頻出図形",
      createdAt: created.createdAt,
    });
    expect((await store.listMaterials())[0]?.name).toBe("頻出図形");

    await expect(store.deleteMaterial(created.id)).resolves.toEqual({ ok: true });
    expect(await store.listMaterials()).toEqual([]);
  });

  it("ignores invalid JSON and invalid material rows", async () => {
    await fs.mkdir(path.join(userDataDir, "data"), { recursive: true });
    await fs.writeFile(path.join(userDataDir, "data", "materials.json"), "{not json", "utf8");
    expect(await store.listMaterials()).toEqual([]);

    await fs.writeFile(path.join(userDataDir, "data", "materials.json"), JSON.stringify({
      version: 1,
      materials: [
        {
          version: 1,
          id: "material_valid",
          name: "有効",
          content: emptyMaterialContent(),
          createdAt: "2026-06-20T00:00:00.000Z",
          updatedAt: "2026-06-20T00:00:00.000Z",
        },
        {
          version: 1,
          id: "material_invalid",
          name: "無効",
          content: { blocks: [{ type: "unknown" }], overlaySnapshot: { version: 1, shapes: [], assets: {} } },
          createdAt: "2026-06-20T00:00:00.000Z",
          updatedAt: "2026-06-20T00:00:00.000Z",
        },
      ],
    }), "utf8");

    expect((await store.listMaterials()).map((material) => material.id)).toEqual(["material_valid"]);
  });

  it("returns an error result when deleting a missing material", async () => {
    await expect(store.deleteMaterial("missing")).resolves.toEqual({
      ok: false,
      error: "素材が見つかりません。",
    });
  });

  it("always persists created materials as user source", async () => {
    const created = await store.createMaterial({ name: "ユーザー", content: emptyMaterialContent() });
    expect(created.source).toBe("user");
    expect((await store.listMaterials())[0]?.source).toBe("user");
  });

  it("persists and updates semantic material metadata", async () => {
    const created = await store.createMaterial({
      name: "バネ",
      content: emptyMaterialContent(),
      description: "力学で使うバネ",
      tags: ["力学"],
      usage: {
        useCases: ["小球や台車につながるバネを描くとき"],
        aliases: ["spring"],
      },
      visualConcepts: ["バネ", "coil"],
      transformPolicy: { scale: true, rotate: false },
      ports: [{ id: "leftEnd", label: "左端", x: 0, y: 12, kind: "leftEnd" }],
    });

    expect(created).toMatchObject({
      description: "力学で使うバネ",
      usage: { aliases: ["spring"] },
      visualConcepts: ["バネ", "coil"],
      ports: [{ id: "leftEnd", x: 0, y: 12 }],
    });

    const updatedContent: MaterialContent = {
      ...emptyMaterialContent(),
      blocks: [{
        type: "paragraph",
        id: "p_material_updated",
        children: [{ type: "text", text: "更新後の本文" }],
      }],
    };

    const updated = await store.updateMaterialMetadata(created.id, {
      name: "コイルばね",
      description: "",
      tags: ["ばね振動"],
      visualConcepts: ["spring"],
      ports: null,
      content: updatedContent,
    });

    expect(updated.name).toBe("コイルばね");
    expect(updated.description).toBeUndefined();
    expect(updated.tags).toEqual(["ばね振動"]);
    expect(updated.visualConcepts).toEqual(["spring"]);
    expect(updated.ports).toBeUndefined();
    expect(updated.content.blocks).toHaveLength(1);
    expect((await store.listMaterials())[0]).toMatchObject({
      id: created.id,
      name: "コイルばね",
      tags: ["ばね振動"],
      content: {
        blocks: [{
          id: "p_material_updated",
          type: "paragraph",
        }],
      },
    });
  });

  it("never keeps official materials in the user store (forces source back to user on read)", async () => {
    await fs.mkdir(path.join(userDataDir, "data"), { recursive: true });
    await fs.writeFile(path.join(userDataDir, "data", "materials.json"), JSON.stringify({
      version: 1,
      materials: [
        {
          version: 1,
          id: "official_tex_box_framed",
          name: "公式なりすまし",
          source: "official",
          content: emptyMaterialContent(),
          createdAt: "2026-06-20T00:00:00.000Z",
          updatedAt: "2026-06-20T00:00:00.000Z",
        },
      ],
    }), "utf8");

    const listed = await store.listMaterials();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.source).toBe("user");
  });
});

function emptyMaterialContent(): MaterialContent {
  return {
    blocks: [],
    overlaySnapshot: {
      version: 1,
      shapes: [],
      assets: {},
    },
  };
}
