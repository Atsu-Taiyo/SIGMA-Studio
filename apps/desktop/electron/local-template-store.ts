import fs from "node:fs/promises";
import path from "node:path";

import { createId } from "@/lib/id";
import { normalizeTemplateName, parseTemplateDocument, parseTemplateItem } from "@/lib/templates";
import type { SigmaDocument } from "@/features/document";
import type { TemplateItem } from "@/types/template";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const te = createCurrentLocaleTranslator("error");

const DATA_DIR_NAME = "data";
const TEMPLATES_FILE_NAME = "templates.json";

interface LocalTemplateLibrary {
  version: 1;
  templates: TemplateItem[];
}

export class LocalTemplateStore {
  private readonly dataDir: string;
  private readonly templatesPath: string;

  constructor(userDataPath: string) {
    this.dataDir = path.join(userDataPath, DATA_DIR_NAME);
    this.templatesPath = path.join(this.dataDir, TEMPLATES_FILE_NAME);
  }

  async listTemplates(workspaceId?: string | null): Promise<TemplateItem[]> {
    const library = await this.readLibrary();
    const templates = workspaceId
      ? library.templates.filter((template) => template.workspaceId === workspaceId)
      : [...library.templates];
    return templates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createTemplate(input: {
    workspaceId: string;
    name: string;
    document: SigmaDocument;
  }): Promise<TemplateItem> {
    if (typeof input.workspaceId !== "string" || !input.workspaceId) {
      throw new Error(te("electron.template.invalidWorkspace"));
    }

    const document = parseTemplateDocument(input.document);
    if (!document) {
      throw new Error(te("electron.template.invalidContent"));
    }

    const library = await this.readLibrary();
    const now = new Date().toISOString();
    const template: TemplateItem = {
      version: 1,
      id: createId("template"),
      workspaceId: input.workspaceId,
      name: normalizeTemplateName(input.name),
      document,
      createdAt: now,
      updatedAt: now,
    };
    await this.writeLibrary({
      version: 1,
      templates: [template, ...library.templates],
    });
    return template;
  }

  async renameTemplate(id: string, name: string): Promise<TemplateItem> {
    const library = await this.readLibrary();
    const index = library.templates.findIndex((template) => template.id === id);
    if (index < 0) {
      throw new Error(te("electron.template.notFound"));
    }

    const template: TemplateItem = {
      ...library.templates[index],
      name: normalizeTemplateName(name),
      updatedAt: new Date().toISOString(),
    };
    const templates = [...library.templates];
    templates[index] = template;
    await this.writeLibrary({ version: 1, templates });
    return template;
  }

  async deleteTemplate(id: string): Promise<{ ok: boolean; error?: string }> {
    const library = await this.readLibrary();
    const templates = library.templates.filter((template) => template.id !== id);
    if (templates.length === library.templates.length) {
      return { ok: false, error: te("electron.template.notFound") };
    }

    await this.writeLibrary({ version: 1, templates });
    return { ok: true };
  }

  private async readLibrary(): Promise<LocalTemplateLibrary> {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.templatesPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.templates)) {
        return { version: 1, templates: [] };
      }

      return {
        version: 1,
        templates: parsed.templates
          .map(parseTemplateItem)
          .filter((template): template is TemplateItem => Boolean(template)),
      };
    } catch {
      return { version: 1, templates: [] };
    }
  }

  private async writeLibrary(library: LocalTemplateLibrary): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.writeFile(this.templatesPath, JSON.stringify(library, null, 2), "utf8");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
