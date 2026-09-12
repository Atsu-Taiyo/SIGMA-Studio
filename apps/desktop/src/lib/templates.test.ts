import { describe, expect, it } from "vitest";

import {
  createDocumentFromTemplate,
  normalizeTemplateName,
  parseTemplateItem,
  templateInsertContent,
} from "./templates";
import type { SigmaBlock, SigmaDocument, ParagraphNode } from "@/types/sigma-doc";
import type { TemplateItem } from "@/types/template";

describe("templates", () => {
  it("normalizes blank template names", () => {
    expect(normalizeTemplateName("  ")).toBe("無題のテンプレート");
    expect(normalizeTemplateName("  2段組  ")).toBe("2段組");
  });

  it("parses a valid template and rejects invalid documents", () => {
    const template = createTemplate();
    expect(parseTemplateItem(template)).not.toBeNull();

    expect(parseTemplateItem({ ...template, version: 2 })).toBeNull();
    expect(parseTemplateItem({ ...template, workspaceId: 42 })).toBeNull();
    expect(parseTemplateItem({ ...template, document: { version: "9.9" } })).toBeNull();
  });

  it("extracts insertable content (blocks + overlay) from a template", () => {
    const template = createTemplate();
    const content = templateInsertContent(template);
    expect(content.blocks).toHaveLength(1);
    expect(content.blocks[0]?.id).toBe("intro");
    expect(content.overlaySnapshot.version).toBe(1);
    expect(Array.isArray(content.overlaySnapshot.shapes)).toBe(true);
  });

  it("creates a fresh document from a template with its own id and name as title", () => {
    const template = createTemplate({ name: "二段組プリント" });
    const created = createDocumentFromTemplate(template);

    expect(created.docId).not.toBe(template.document.docId);
    expect(created.metadata.title).toBe("二段組プリント");
    expect(created.content).toHaveLength(template.document.content.length);
    // The source template document is untouched.
    expect(template.document.metadata.title).toBe("テンプレ教材");
  });
});

function paragraph(id: string, text: string): ParagraphNode {
  return {
    id,
    type: "paragraph",
    children: [{ type: "text", text }],
  };
}

function createDocument(content: SigmaBlock[]): SigmaDocument {
  return {
    version: "2.0",
    docId: "template_doc",
    metadata: { title: "テンプレ教材" },
    content,
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
  };
}

function createTemplate(overrides: Partial<TemplateItem> = {}): TemplateItem {
  return {
    version: 1,
    id: "template_1",
    workspaceId: "workspace_1",
    name: "テンプレ",
    document: createDocument([paragraph("intro", "本文")]),
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    ...overrides,
  };
}
