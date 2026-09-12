import { describe, expect, it } from "vitest";

import type { SigmaDocument } from "@/features/document";

import {
  classifyPastedDocumentText,
  pastedDocumentFile,
  serializeDocumentText,
} from "./document-text-transfer";

const document = {
  docId: "doc_1",
  metadata: { title: "二次関数" },
  content: [],
  updatedAt: "2026-08-31T00:00:00.000Z",
} as unknown as SigmaDocument;

describe("serializeDocumentText", () => {
  it("writes the document as readable JSON that classifies back as SigmaDoc", () => {
    const text = serializeDocumentText(document);

    expect(text.split("\n").length).toBeGreaterThan(1);
    expect(classifyPastedDocumentText(text)).toEqual({
      kind: "sigmadoc",
      text,
      value: JSON.parse(text),
    });
  });
});

describe("classifyPastedDocumentText", () => {
  it("reads a JSON object as SigmaDoc even with surrounding whitespace and a BOM", () => {
    const pasted = classifyPastedDocumentText('\uFEFF\n  {"docId":"doc_1"}\n\n');

    expect(pasted).toEqual({ kind: "sigmadoc", text: '{"docId":"doc_1"}', value: { docId: "doc_1" } });
  });

  it("reads TeX source as TeX", () => {
    const pasted = classifyPastedDocumentText("\\documentclass{article}\n\\begin{document}x\\end{document}");

    expect(pasted.kind).toBe("tex");
  });

  it("reports broken JSON instead of falling back to TeX", () => {
    // 壊れた JSON を TeX として解釈すると「取り込めた」まま中身が別物になるため、
    // ここで止めて貼り直しを促す。
    expect(classifyPastedDocumentText('{"docId": ').kind).toBe("invalidJson");
    expect(classifyPastedDocumentText("[1, 2,").kind).toBe("invalidJson");
  });

  it("reports whitespace-only text as empty", () => {
    expect(classifyPastedDocumentText("   \n\t ").kind).toBe("empty");
    expect(classifyPastedDocumentText("").kind).toBe("empty");
  });
});

describe("pastedDocumentFile", () => {
  it("gives the pasted text the extension the import path detects", () => {
    const json = pastedDocumentFile({ kind: "sigmadoc", text: "{}", value: {} }, "貼り付けた教材");
    const tex = pastedDocumentFile({ kind: "tex", text: "\\section{a}" }, "貼り付けた教材");

    expect(json.name).toBe("貼り付けた教材.sigmadoc.json");
    expect(tex.name).toBe("貼り付けた教材.tex");
  });

  it("keeps the pasted text as the file content", async () => {
    const file = pastedDocumentFile({ kind: "sigmadoc", text: '{"docId":"doc_1"}', value: {} }, "material");

    await expect(file.text()).resolves.toBe('{"docId":"doc_1"}');
  });
});
