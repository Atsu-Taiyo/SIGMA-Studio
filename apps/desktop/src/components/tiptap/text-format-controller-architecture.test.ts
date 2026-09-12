import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getModuleSpecifiers as importSpecifiers } from "../../../tests/helpers/source-dependencies";

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

describe("shared Tiptap text-format controller boundary", () => {
  it("stays independent from React, editor composition, and AI features", () => {
    const source = readSource("./text-format-controller.ts");
    const invalidImports = importSpecifiers(source).filter((specifier) => (
      specifier === "react"
      || specifier === "react-dom"
      || specifier.startsWith("@/components/editor/")
      || specifier.startsWith("@/features/ai-edit")
      || specifier.startsWith("@/lib/ai/")
      || specifier.startsWith("@/electron/")
    ));

    expect(invalidImports).toEqual([]);
  });

  it("is the single command and toolbar-state adapter for both body editors", () => {
    const textFlowEditor = readSource("../editor/TextFlowEditor.tsx");
    const richTextEditor = readSource("../editor/RichTextEditor.tsx");

    for (const source of [textFlowEditor, richTextEditor]) {
      expect(source).toContain('from "@/components/tiptap/text-format-controller"');
      expect(source).toContain("applyTextFormatCommand(");
      expect(source).toContain("dispatchTextFormatState(");
      expect(source).not.toMatch(/\bfunction emitTextFormatState\s*\(/);
      expect(source).not.toMatch(/\bfunction normalizeBoxedVariant\s*\(/);
    }
  });
});
