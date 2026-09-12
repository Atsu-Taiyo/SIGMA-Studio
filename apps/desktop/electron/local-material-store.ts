import fs from "node:fs/promises";
import path from "node:path";

import { createId } from "@/lib/id";
import { normalizeMaterialMetadata, normalizeMaterialName, parseMaterialContent, parseMaterialItem } from "@/lib/materials";
import type { MaterialContent, MaterialItem } from "@/types/material";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const te = createCurrentLocaleTranslator("error");

const DATA_DIR_NAME = "data";
const MATERIALS_FILE_NAME = "materials.json";

interface LocalMaterialLibrary {
  version: 1;
  materials: MaterialItem[];
}

export class LocalMaterialStore {
  private readonly dataDir: string;
  private readonly materialsPath: string;

  constructor(userDataPath: string) {
    this.dataDir = path.join(userDataPath, DATA_DIR_NAME);
    this.materialsPath = path.join(this.dataDir, MATERIALS_FILE_NAME);
  }

  async listMaterials(): Promise<MaterialItem[]> {
    const library = await this.readLibrary();
    return [...library.materials].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createMaterial(input: { name: string; content: MaterialContent } & Parameters<typeof normalizeMaterialMetadata>[0]): Promise<MaterialItem> {
    const content = parseMaterialContent(input.content);
    if (!content) {
      throw new Error(te("electron.material.invalidContent"));
    }

    const library = await this.readLibrary();
    const now = new Date().toISOString();
    const material: MaterialItem = {
      version: 1,
      id: createId("material"),
      name: normalizeMaterialName(input.name),
      source: "user",
      ...normalizeMaterialMetadata(input),
      content,
      createdAt: now,
      updatedAt: now,
    };
    await this.writeLibrary({
      version: 1,
      materials: [material, ...library.materials],
    });
    return material;
  }

  async renameMaterial(id: string, name: string): Promise<MaterialItem> {
    return this.updateMaterialMetadata(id, { name });
  }

  async updateMaterialMetadata(
    id: string,
    input: { name?: string; content?: MaterialContent } & Parameters<typeof normalizeMaterialMetadata>[0],
  ): Promise<MaterialItem> {
    const library = await this.readLibrary();
    const index = library.materials.findIndex((material) => material.id === id);
    if (index < 0) {
      throw new Error(te("electron.material.notFound"));
    }

    let content: MaterialContent | undefined;
    if (input.content !== undefined) {
      const parsedContent = parseMaterialContent(input.content);
      if (!parsedContent) {
        throw new Error(te("electron.material.invalidContent"));
      }
      content = parsedContent;
    }

    const material: MaterialItem = {
      ...library.materials[index],
      ...(input.name === undefined ? {} : { name: normalizeMaterialName(input.name) }),
      ...(content === undefined ? {} : { content }),
      updatedAt: new Date().toISOString(),
    };
    for (const key of ["description", "tags", "usage", "visualConcepts", "transformPolicy", "ports"] as const) {
      if (key in input) {
        delete material[key];
      }
    }
    Object.assign(material, normalizeMaterialMetadata(input));
    const materials = [...library.materials];
    materials[index] = material;
    await this.writeLibrary({ version: 1, materials });
    return material;
  }

  async deleteMaterial(id: string): Promise<{ ok: boolean; error?: string }> {
    const library = await this.readLibrary();
    const materials = library.materials.filter((material) => material.id !== id);
    if (materials.length === library.materials.length) {
      return { ok: false, error: te("electron.material.notFound") };
    }

    await this.writeLibrary({ version: 1, materials });
    return { ok: true };
  }

  private async readLibrary(): Promise<LocalMaterialLibrary> {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.materialsPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.materials)) {
        return { version: 1, materials: [] };
      }

      return {
        version: 1,
        materials: parsed.materials
          .map(parseMaterialItem)
          .filter((material): material is MaterialItem => Boolean(material))
          .map((material) => ({ ...material, source: "user" })),
      };
    } catch {
      return { version: 1, materials: [] };
    }
  }

  private async writeLibrary(library: LocalMaterialLibrary): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.writeFile(this.materialsPath, JSON.stringify(library, null, 2), "utf8");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
