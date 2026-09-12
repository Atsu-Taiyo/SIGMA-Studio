import { createId } from "@/lib/id";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import { SigmaDocumentSchema } from "@/lib/sigma-doc-schema";
import {
  createEmptyOverlaySnapshot,
  normalizeOverlaySnapshot,
  type SigmaDocument,
} from "@/features/document";

import type { MaterialContent } from "@/types/material";
import type { TemplateItem } from "@/types/template";

export function parseTemplateItem(value: unknown): TemplateItem | null {
  if (!isRecord(value) || value.version !== 1) {
    return null;
  }
  if (
    typeof value.id !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.name !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return null;
  }

  const document = parseTemplateDocument(value.document);
  if (!document) {
    return null;
  }

  return {
    version: 1,
    id: value.id,
    workspaceId: value.workspaceId,
    name: value.name,
    document,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function parseTemplateDocument(value: unknown): SigmaDocument | null {
  const result = SigmaDocumentSchema.safeParse(value);
  return result.success ? result.data : null;
}

const tWorkspace = createCurrentLocaleTranslator("workspace");

/**
 * 名前が空のときの防御的な既定名。
 *
 * **UI 言語には連動しない。** 唯一の呼び出し元が Electron main
 * (`electron/local-template-store.ts`) で、そこには `window` が無いため
 * `createCurrentLocaleTranslator` は常に既定ロケールを返す。画面側は空名での
 * 保存を塞いでいる (`TemplateGallery`) ので、ここへ落ちるのは異常系だけ。
 * 作成時の言語で焼きたくなったら、名前を main へ渡す前に画面側で解決すること。
 */
export function normalizeTemplateName(name: string): string {
  return name.trim() || tWorkspace("untitledTemplate");
}

/**
 * The content a template contributes when inserted into the currently open
 * document: its top-level blocks plus the document overlay snapshot. This maps
 * a template onto the same shape materials use, so the existing material
 * insertion plumbing can place it.
 */
export function templateInsertContent(template: TemplateItem): MaterialContent {
  const overlaySnapshot = template.document.pageLayout?.overlay?.overlaySnapshot;
  return {
    blocks: template.document.content,
    overlaySnapshot: overlaySnapshot
      ? normalizeOverlaySnapshot(overlaySnapshot)
      : createEmptyOverlaySnapshot(),
  };
}

/**
 * A fresh standalone document seeded from a template. The new document keeps the
 * template's layout and content but gets its own identity and takes the
 * template name as its starting title.
 */
export function createDocumentFromTemplate(template: TemplateItem): SigmaDocument {
  const clone = cloneDocument(template.document);
  return {
    ...clone,
    docId: createId("doc"),
    metadata: {
      ...clone.metadata,
      title: template.name,
    },
    updatedAt: new Date().toISOString(),
  };
}

function cloneDocument(document: SigmaDocument): SigmaDocument {
  if (typeof structuredClone === "function") {
    return structuredClone(document);
  }
  return JSON.parse(JSON.stringify(document)) as SigmaDocument;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
