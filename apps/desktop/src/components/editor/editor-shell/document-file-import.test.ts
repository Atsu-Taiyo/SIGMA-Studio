import { afterEach, describe, expect, it, vi } from "vitest";

import { ensurePageLayout, type SigmaDocument } from "@/features/document";
import * as locale from "@/lib/i18n";
import * as powerpoint from "@/lib/powerpoint-import";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";

import { fileFromDesktopImport, planDocumentFileImport, prepareDocumentFileImport } from "./document-file-import";

const IMPORTED_AT = "2026-09-08T15:00:00.000Z";

function document(): SigmaDocument {
  return {
    version: "2.0",
    docId: "source_doc",
    metadata: { title: "元の教材", styleUnits: { fontSize: "pt" }, mathFractionSizing: "texDefault" },
    content: [{ type: "paragraph", id: "p_source", children: [{ type: "text", text: "本文" }] }],
    outputProfiles: { student: {}, teacher: { showSolutions: true }, answerBook: {} },
    updatedAt: "2020-01-01T00:00:00.000Z",
  };
}

function environment() {
  let id = 0;
  return {
    now: () => IMPORTED_AT,
    createId: (prefix: string) => `${prefix}_import_${++id}`,
    createDocumentId: () => "doc_imported",
    defaultTitle: vi.fn(() => "取り込んだ教材"),
  };
}

function readable(file: File) {
  const request = planDocumentFileImport(file);
  if (request.kind !== "readable") throw new Error("Expected a readable import request");
  return request;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("document import planning", () => {
  it.each([
    ["教材.sigmadoc.json", "sigmadoc"],
    ["教材.unknown", "sigmadoc"],
    ["教材.TEX", "tex"],
    ["教材.latex", "tex"],
    ["教材.PPTX ", "pptx"],
  ])("classifies %s without reading file contents", (name, format) => {
    const file = new File(["not read yet"], name);
    const text = vi.spyOn(file, "text");
    const arrayBuffer = vi.spyOn(file, "arrayBuffer");
    expect(planDocumentFileImport(file)).toEqual({ kind: "readable", file, format });
    expect(text).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});

describe("prepared SigmaDoc imports", () => {
  it("uses the opened filename while preserving content, other metadata and output settings", async () => {
    const source = document();
    const ports = environment();
    const file = new File([JSON.stringify(source)], "ファイル名.json");
    const result = await prepareDocumentFileImport(readable(file), ports);

    expect(result.document).toEqual(ensurePageLayout({
      ...source, metadata: { ...source.metadata, title: "ファイル名" }, docId: "doc_imported", updatedAt: IMPORTED_AT,
    }));
    expect(parseSigmaDocument(result.document)).toEqual(result.document);
    expect(result.recoveryIssues).toEqual([]);
    expect(result.successMessageKey).toBe("status.jsonImported");
    expect(ports.defaultTitle).not.toHaveBeenCalled();
    expect(JSON.parse(await file.text())).toEqual(source);
  });

  it("repairs duplicate top-level ids without rewriting the retained first block", async () => {
    const source = document();
    source.content.push({ type: "heading", id: "p_source", level: 2, children: [{ type: "text", text: "見出し" }] });
    const result = await prepareDocumentFileImport(readable(new File([JSON.stringify(source)], "教材.json")), environment());

    expect(result.document.content.map((block) => block.id)).toEqual(["p_source", "heading_import_1"]);
    expect(result.document.content[0]).toEqual(source.content[0]);
    expect(result.document.content[1]).toEqual({ ...source.content[1], id: "heading_import_1" });
  });

  it.each([
    ["ファイル名.sigmadoc.json", "ファイル名"],
    ["数学.第1回.SIGMADOC.JSON", "数学.第1回"],
    ["数学.sigmadoc.tex", "数学.sigmadoc"],
    ["教材", "教材"],
    [".json", "取り込んだ教材"],
  ])("uses the filename without its format extension for %s", async (filename, title) => {
    const source = document();
    source.metadata.title = "";
    const result = await prepareDocumentFileImport(readable(new File([JSON.stringify(source)], filename)), environment());
    expect(result.document.metadata.title).toBe(title);
  });

  it("returns recovery details alongside the usable content", async () => {
    const source = {
      ...document(),
      comments: [{ id: "broken_comment", anchor: { type: "unknown" }, messages: [] }],
    };
    const result = await prepareDocumentFileImport(readable(new File([JSON.stringify(source)], "教材.json")), environment());

    expect(result.document.content).toEqual(source.content);
    expect(result.document.comments).toEqual([]);
    expect(result.recoveryIssues).toEqual([expect.objectContaining({ kind: "comment", id: "broken_comment" })]);
  });

  it("rejects invalid JSON before allocating a new document identity", async () => {
    const ports = { ...environment(), createDocumentId: vi.fn(() => "unexpected") };
    await expect(prepareDocumentFileImport(readable(new File(["{broken"], "教材.json")), ports)).rejects.toThrow(SyntaxError);
    expect(ports.createDocumentId).not.toHaveBeenCalled();
  });

  it("reports an unrecoverable schema error without switching to another parser", async () => {
    const source = ensurePageLayout(document());
    const raw = { ...source, pageLayout: { ...source.pageLayout, preset: "unknown" } };
    await expect(prepareDocumentFileImport(readable(new File([JSON.stringify(raw)], "教材.json")), environment()))
      .rejects.toThrow("pageLayout.preset");
  });

  it("imports real TeX content through the same normalization boundary", async () => {
    const file = new File([String.raw`\documentclass{article}
\title{数学の教材}
\begin{document}
\section{練習}
式 $x^2+1$ を考える。
\end{document}`], "教材.tex");
    const result = await prepareDocumentFileImport(readable(file), environment());

    expect(result.document.docId).toBe("doc_imported");
    expect(result.document.metadata.title).toBe("教材");
    expect(result.document.updatedAt).toBe(IMPORTED_AT);
    expect(JSON.stringify(result.document.content)).toContain("x^2+1");
    expect(result.successMessageKey).toBe("status.texConverted");
    expect(result.recoveryIssues).toEqual([]);
    expect(() => parseSigmaDocument(result.document)).not.toThrow();
  });

  it("uses the UI locale at the time the PPTX buffer finishes loading", async () => {
    const source = ensurePageLayout(document());
    const importer = vi.spyOn(powerpoint, "importPowerPointPptxBuffer").mockResolvedValue(source);
    const getAppLocale = vi.spyOn(locale, "getAppLocale").mockReturnValue("ja");
    const file = new File([], "教材.pptx");
    const buffer = new Uint8Array([1, 2, 3]).buffer;
    let resolveRead!: (value: ArrayBuffer) => void;
    vi.spyOn(file, "arrayBuffer").mockReturnValue(new Promise((resolve) => { resolveRead = resolve; }));
    const pending = prepareDocumentFileImport(readable(file), environment());

    expect(importer).not.toHaveBeenCalled();
    getAppLocale.mockReturnValue("en");
    resolveRead(buffer);
    const result = await pending;

    expect(importer).toHaveBeenCalledWith(buffer, "教材.pptx", { locale: "en" });
    expect(result.document.content).toEqual(source.content);
    expect(result.document.metadata.title).toBe("教材");
    expect(result.successMessageKey).toBe("status.powerPointConverted");
  });
});

describe("desktop import file adapter", () => {
  it.each(["/tmp/教材.pptx", "C:\\Documents\\教材.pptx"])("preserves binary bytes and the basename from %s", async (filePath) => {
    vi.stubGlobal("window", { atob: globalThis.atob });
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    const file = fileFromDesktopImport({ filePath, dataBase64: Buffer.from(bytes).toString("base64") });

    expect(file.name).toBe("教材.pptx");
    expect(file.type).toBe("");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  it("propagates a decoding failure to the existing file-read error handler", () => {
    vi.stubGlobal("window", { atob: globalThis.atob });
    expect(() => fileFromDesktopImport({ filePath: "/tmp/教材.pptx", dataBase64: "!invalid!" })).toThrow();
  });
});
