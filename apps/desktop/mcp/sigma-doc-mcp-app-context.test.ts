import { PDFDocument } from "pdf-lib";
import type { AttachedPdfPages } from "../electron/ai-edit-pdf";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  runGetActiveReference,
  runGetAttachedMedia,
  runGetInsertionCandidates,
  runGetMentionedSigmaDocs,
  runGetNeighborBlocks,
  runGetSelectedBlock,
  type AppContextToolDeps,
} from "./sigma-doc-mcp-app-context";
import { LocalAiEditRunContextStore, SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV, type AiEditRunContext } from "../electron/ai-edit-run-context";
import { LocalSigmaDocStore } from "../electron/local-sigma-doc-store";
import { SIGMA_STUDIO_MCP_PROVIDER_ENV } from "../electron/sigma-studio-mcp-launch";
import { sampleDocument } from "@/lib/sample-document";

describe("sigma-doc-mcp-app-context", () => {
  let userDataDir: string;
  let sigmaDocStore: LocalSigmaDocStore;
  let runContextStore: LocalAiEditRunContextStore;
  let fileId: string;
  let firstBlockId: string;
  let middleBlockId: string;

  function deps(runContextFile: string | undefined, mcpProvider?: string): AppContextToolDeps {
    return {
      env: runContextFile === undefined
        ? {}
        : { [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: runContextFile, ...(mcpProvider ? { [SIGMA_STUDIO_MCP_PROVIDER_ENV]: mcpProvider } : {}) },
      loadSigmaDocStore: () => new LocalSigmaDocStore(userDataDir),
    };
  }

  function baseContext(overrides: Partial<AiEditRunContext> = {}): AiEditRunContext {
    return {
      version: 1,
      runId: "run_1",
      createdAt: "2026-07-02T00:00:00.000Z",
      provider: "claude",
      fileId,
      fileRevision: 1,
      selectedId: null,
      references: [],
      attachments: [],
      mentionedDocuments: [],
      ...overrides,
    };
  }

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-mcp-app-context-"));
    sigmaDocStore = new LocalSigmaDocStore(userDataDir);
    await sigmaDocStore.initializeWorkspace({ initialDocument: sampleDocument });
    runContextStore = new LocalAiEditRunContextStore(userDataDir, "claude");

    const files = await sigmaDocStore.listFiles();
    fileId = files[0]!.fileId;
    const document = await sigmaDocStore.loadDocument(fileId);
    firstBlockId = document!.content[0]!.id;
    middleBlockId = document!.content[Math.floor(document!.content.length / 2)]!.id;
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("returns hasAppContext:false with a Japanese message when there is no run context", async () => {
    const outcome = await runGetSelectedBlock(deps(undefined), {});
    expect(outcome.payload.ok).toBe(true);
    expect(outcome.payload.hasAppContext).toBe(false);
    expect(String(outcome.payload.message)).toContain("アプリの実行コンテキスト");
    expect(outcome.extraContent).toHaveLength(0);
  });

  it("returns hasAppContext:false with a detail when the run context file is invalid", async () => {
    const filePath = runContextStore.getRunContextFilePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{not json", "utf8");

    const outcome = await runGetSelectedBlock(deps(filePath), {});
    expect(outcome.payload.ok).toBe(true);
    expect(outcome.payload.hasAppContext).toBe(false);
    expect(String(outcome.payload.message)).toContain("アプリの実行コンテキスト");
    expect(String(outcome.payload.detail).length).toBeGreaterThan(0);
  });

  it("returns hasAppContext:false with a detail when the run-context fileId cannot be resolved (e.g. deleted file)", async () => {
    await runContextStore.write(baseContext({ fileId: "file_does_not_exist", selectedId: firstBlockId }));
    const outcome = await runGetSelectedBlock(deps(runContextStore.getRunContextFilePath()), {});

    expect(outcome.payload.ok).toBe(true);
    expect(outcome.payload.hasAppContext).toBe(false);
    expect(String(outcome.payload.message)).toContain("アプリの実行コンテキスト");
    expect(String(outcome.payload.detail).length).toBeGreaterThan(0);
  });

  it("returns hasAppContext:false for get_attached_media when the run-context fileId cannot be resolved", async () => {
    await runContextStore.write(baseContext({ fileId: "file_does_not_exist" }));
    const outcome = await runGetAttachedMedia(deps(runContextStore.getRunContextFilePath()));

    expect(outcome.payload.ok).toBe(true);
    expect(outcome.payload.hasAppContext).toBe(false);
    expect(outcome.extraContent).toHaveLength(0);
  });

  it("get_selected_block returns the matching block with revisionMatched:true", async () => {
    await runContextStore.write(baseContext({ selectedId: firstBlockId }));
    const outcome = await runGetSelectedBlock(deps(runContextStore.getRunContextFilePath()), {});

    expect(outcome.payload.hasAppContext).toBe(true);
    expect(outcome.payload.fileId).toBe(fileId);
    expect(outcome.payload.revisionMatched).toBe(true);
    const data = outcome.payload.data as { block: { id?: string } | null };
    expect(data.block?.id).toBe(firstBlockId);
  });

  it("get_selected_block resolves app context from a provider:\"chatgpt\" run context file", async () => {
    const chatgptRunContextStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt");
    await chatgptRunContextStore.write(baseContext({ provider: "chatgpt", selectedId: firstBlockId }));
    const outcome = await runGetSelectedBlock(deps(chatgptRunContextStore.getRunContextFilePath()), {});

    expect(outcome.payload.hasAppContext).toBe(true);
    expect(outcome.payload.fileId).toBe(fileId);
    const data = outcome.payload.data as { block: { id?: string } | null };
    expect(data.block?.id).toBe(firstBlockId);
  });

  it("get_selected_block resolves app context from a provider:\"antigravity\" run context file", async () => {
    const geminiRunContextStore = new LocalAiEditRunContextStore(userDataDir, "antigravity");
    await geminiRunContextStore.write(baseContext({ provider: "antigravity", selectedId: firstBlockId }));
    const outcome = await runGetSelectedBlock(deps(geminiRunContextStore.getRunContextFilePath()), {});

    expect(outcome.payload.hasAppContext).toBe(true);
    expect(outcome.payload.fileId).toBe(fileId);
    const data = outcome.payload.data as { block: { id?: string } | null };
    expect(data.block?.id).toBe(firstBlockId);
  });

  it("get_selected_block with a stale selectedId returns a null block", async () => {
    await runContextStore.write(baseContext({ selectedId: "missing_id" }));
    const outcome = await runGetSelectedBlock(deps(runContextStore.getRunContextFilePath()), {});

    expect(outcome.payload.ok).toBe(true);
    const data = outcome.payload.data as { block: unknown };
    expect(data.block).toBeNull();
  });

  it("get_insertion_candidates returns non-empty candidates and honors targetId", async () => {
    await runContextStore.write(baseContext({ selectedId: firstBlockId }));
    const outcome = await runGetInsertionCandidates(deps(runContextStore.getRunContextFilePath()), {
      targetId: middleBlockId,
    });

    const data = outcome.payload.data as { candidates: unknown[]; targetId: string };
    expect(data.candidates.length).toBeGreaterThan(0);
    expect(data.targetId).toBe(middleBlockId);
  });

  it("get_neighbor_blocks returns topLevel scope for a middle block", async () => {
    await runContextStore.write(baseContext({ selectedId: middleBlockId }));
    const outcome = await runGetNeighborBlocks(deps(runContextStore.getRunContextFilePath()), {});

    const data = outcome.payload.data as { scope: string };
    expect(data.scope).toBe("topLevel");
  });

  it("get_attached_media emits image content for supported images and resource content for every other file", async () => {
    await runContextStore.write(baseContext({
      attachments: [
        {
          id: "att_png",
          name: "a.png",
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,AAAA",
          sourceReferenceKey: "block:p_1:::overlay:shape_1",
        },
        { id: "att_svg", name: "a.svg", mimeType: "image/svg+xml", dataUrl: "data:image/svg+xml;base64,AAAA" },
        { id: "att_pdf", name: "worksheet.pdf", mimeType: "application/pdf", dataUrl: "data:application/pdf;base64,JVBERg==" },
      ],
    }));
    const outcome = await runGetAttachedMedia(deps(runContextStore.getRunContextFilePath()));

    expect(outcome.extraContent).toHaveLength(3);
    expect(outcome.extraContent[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(outcome.extraContent[1]).toMatchObject({
      type: "resource",
      resource: { mimeType: "image/svg+xml", blob: "AAAA" },
    });
    expect(outcome.extraContent[2]).toMatchObject({
      type: "resource",
      resource: { mimeType: "application/pdf", blob: "JVBERg==" },
    });

    const data = outcome.payload.data as {
      attachments: Array<{
        id: string;
        imageContentIncluded: boolean;
        contentIncluded: boolean;
        contentType: "image" | "resource" | null;
        sourceReferenceKey: string | null;
      }>;
    };
    const png = data.attachments.find((item) => item.id === "att_png");
    const svg = data.attachments.find((item) => item.id === "att_svg");
    const pdf = data.attachments.find((item) => item.id === "att_pdf");
    expect(png?.imageContentIncluded).toBe(true);
    expect(png?.contentType).toBe("image");
    expect(png?.sourceReferenceKey).toBe("block:p_1:::overlay:shape_1");
    expect(svg?.imageContentIncluded).toBe(false);
    expect(svg?.contentIncluded).toBe(true);
    expect(svg?.contentType).toBe("resource");
    expect(svg?.sourceReferenceKey).toBeNull();
    expect(pdf?.contentType).toBe("resource");
  });

  it("get_attached_media emits image content for WEBP attachments", async () => {
    await runContextStore.write(baseContext({
      attachments: [
        { id: "att_webp", name: "a.webp", mimeType: "image/webp", dataUrl: "data:image/webp;base64,AAAA" },
      ],
    }));
    const outcome = await runGetAttachedMedia(deps(runContextStore.getRunContextFilePath()));

    expect(outcome.extraContent).toHaveLength(1);
    expect(outcome.extraContent[0]).toMatchObject({ type: "image", mimeType: "image/webp" });

    const data = outcome.payload.data as { attachments: Array<{ id: string; imageContentIncluded: boolean }> };
    const webp = data.attachments.find((item) => item.id === "att_webp");
    expect(webp?.imageContentIncluded).toBe(true);
  });

  it("writes attachment files and omits inline image content for ChatGPT", async () => {
    await runContextStore.write(baseContext({
      provider: "chatgpt",
      attachments: [
        { id: "att_chatgpt", name: "reference.png", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA" },
      ],
    }));

    const outcome = await runGetAttachedMedia(deps(runContextStore.getRunContextFilePath()));
    expect(outcome.extraContent).toHaveLength(0);
    expect(String(outcome.payload.message)).toContain("view_image");

    const data = outcome.payload.data as { attachments: Array<{ filePath: string | null; imageContentIncluded: boolean }> };
    expect(data.attachments[0]?.imageContentIncluded).toBe(false);
    const filePath = data.attachments[0]?.filePath;
    expect(filePath).toBeTruthy();
    if (!filePath) throw new Error("attachment file path was not returned");
    expect(path.isAbsolute(filePath)).toBe(true);
    await expect(fs.readFile(filePath)).resolves.toEqual(Buffer.from([0, 0, 0]));
  });

  it.each(["chatgpt", "antigravity"] as const)("makes every PDF page readable for %s through the run-scoped MCP tool", async (provider) => {
    const pdf = await PDFDocument.create();
    for (let number = 1; number <= 5; number += 1) {
      pdf.addPage([200, 300]).drawText(`Page ${number}`, { x: 20, y: 200, size: 16 });
    }
    const bytes = await pdf.save();
    const store = new LocalAiEditRunContextStore(userDataDir, provider, { runId: "run_1" });
    await store.write(baseContext({ provider, attachments: [{
      id: "worksheet", name: "worksheet.pdf", mimeType: "application/pdf",
      dataUrl: `data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}`,
    }] }));
    const toolDeps = deps(store.getRunContextFilePath(), provider);
    const result = await runGetAttachedMedia(toolDeps, { runId: "run_1" });
    const data = result.payload.data as { attachments: Array<{ filePath: string; contentType: string; pdf: AttachedPdfPages }> };
    expect(result.payload.warnings).toBeUndefined();
    expect(data.attachments[0].contentType).toBe("pdf");
    await expect(fs.readFile(data.attachments[0].filePath)).resolves.toEqual(Buffer.from(bytes));
    const rendered = data.attachments[0].pdf;
    expect(rendered.pageCount).toBe(5);
    expect(rendered.nextPageStart).toBe(5);
    expect(rendered.pages[0].text).toContain("Page 1");
    for (const page of rendered.pages) {
      expect((await fs.readFile(page.previewFile)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
    expect(result.extraContent.filter((part) => part.type === "image")).toHaveLength(provider === "chatgpt" ? 0 : 4);
    expect(result.extraContent.some((part) => part.type === "resource")).toBe(false);
    const next = await runGetAttachedMedia(toolDeps, { runId: "run_1", attachmentId: "worksheet", pageStart: rendered.nextPageStart! });
    const nextData = next.payload.data as typeof data;
    expect(nextData.attachments[0].pdf.pages.map((page) => page.pageNumber)).toEqual([5]);
    expect(nextData.attachments[0].pdf.pages[0].text).toContain("Page 5");
    expect(nextData.attachments[0].pdf.nextPageStart).toBeNull();
  });

  it("reports a broken PDF without losing other attachments", async () => {
    await runContextStore.write(baseContext({ provider: "chatgpt", attachments: [
      { id: "bad", name: "broken.pdf", mimeType: "application/pdf", dataUrl: "data:application/pdf;base64,AQID" },
      { id: "text", name: "note.txt", mimeType: "text/plain", dataUrl: "data:text/plain;base64,SGVsbG8=" },
    ] }));
    const result = await runGetAttachedMedia(deps(runContextStore.getRunContextFilePath()));
    const data = result.payload.data as { attachments: Array<{ id: string; error?: string; contentIncluded: boolean }> };
    expect(data.attachments[0].error).toBeTruthy();
    expect(data.attachments[0].contentIncluded).toBe(false);
    expect(data.attachments[1].contentIncluded).toBe(true);
    expect(result.payload.warnings).toEqual([expect.stringContaining("broken.pdf")]);
  });

  it("get_attached_media with no attachments returns an empty list and no image content", async () => {
    await runContextStore.write(baseContext({ attachments: [] }));
    const outcome = await runGetAttachedMedia(deps(runContextStore.getRunContextFilePath()));

    expect(outcome.extraContent).toHaveLength(0);
    const data = outcome.payload.data as { attachments: unknown[] };
    expect(data.attachments).toHaveLength(0);
  });

  it("get_mentioned_sigma_docs keeps valid documents and warns about schema-broken ones", async () => {
    await runContextStore.write(baseContext({
      mentionedDocuments: [
        {
          id: "doc_ok",
          fileId: "file_ok",
          title: "OK教材",
          documentPath: "/ok.json",
          revision: 1,
          excerpt: "抜粋",
          document: sampleDocument as unknown as Record<string, unknown>,
        },
        {
          id: "doc_bad",
          fileId: "file_bad",
          title: "壊れた教材",
          documentPath: "/bad.json",
          revision: 1,
          excerpt: "抜粋",
          document: { not: "a valid sigma doc" },
        },
      ],
    }));
    const outcome = await runGetMentionedSigmaDocs(deps(runContextStore.getRunContextFilePath()));

    const data = outcome.payload.data as { documents: Array<{ id: string }> };
    expect(data.documents).toHaveLength(1);
    expect(data.documents[0]?.id).toBe("doc_ok");
    expect((outcome.payload.warnings as string[]).length).toBe(1);
  });

  it("resolves the per-run context file over the static one when runId + SIGMA_STUDIO_MCP_PROVIDER are given", async () => {
    await runContextStore.write(baseContext({ runId: "run_static_stale", selectedId: "does_not_exist" }));
    const perRunStore = new LocalAiEditRunContextStore(userDataDir, "claude", { runId: "run_mine" });
    await perRunStore.write(baseContext({ runId: "run_mine", selectedId: firstBlockId }));

    const outcome = await runGetSelectedBlock(
      deps(runContextStore.getRunContextFilePath(), "claude"),
      { runId: "run_mine" },
    );

    expect(outcome.payload.hasAppContext).toBe(true);
    const data = outcome.payload.data as { block: { id?: string } | null };
    expect(data.block?.id).toBe(firstBlockId);
  });

  it("falls back to the static context file when runId is given but SIGMA_STUDIO_MCP_PROVIDER is missing (cannot derive the per-run file name)", async () => {
    await runContextStore.write(baseContext({ runId: "run_static", selectedId: firstBlockId }));
    const perRunStore = new LocalAiEditRunContextStore(userDataDir, "claude", { runId: "run_mine" });
    await perRunStore.write(baseContext({ runId: "run_mine", selectedId: middleBlockId }));

    // No provider passed here, so resolveRunContextProviderFromEnv() returns
    // undefined and resolution falls back to the static file (firstBlockId),
    // NOT the per-run file's content (middleBlockId).
    const outcome = await runGetSelectedBlock(
      deps(runContextStore.getRunContextFilePath()),
      { runId: "run_mine" },
    );

    expect(outcome.payload.hasAppContext).toBe(true);
    const data = outcome.payload.data as { block: { id?: string } | null };
    expect(data.block?.id).toBe(firstBlockId);
  });

  it("falls back to the static context file when runId is omitted", async () => {
    await runContextStore.write(baseContext({ selectedId: firstBlockId }));
    const outcome = await runGetSelectedBlock(deps(runContextStore.getRunContextFilePath()), {});

    expect(outcome.payload.hasAppContext).toBe(true);
    const data = outcome.payload.data as { block: { id?: string } | null };
    expect(data.block?.id).toBe(firstBlockId);
  });

  it("does not cache: rewriting the run-context file changes subsequent results", async () => {
    await runContextStore.write(baseContext({ selectedId: firstBlockId }));
    const first = await runGetSelectedBlock(deps(runContextStore.getRunContextFilePath()), {});
    const firstData = first.payload.data as { block: { id?: string } | null };
    expect(firstData.block?.id).toBe(firstBlockId);

    await runContextStore.write(baseContext({ selectedId: middleBlockId }));
    const second = await runGetSelectedBlock(deps(runContextStore.getRunContextFilePath()), {});
    const secondData = second.payload.data as { block: { id?: string } | null };
    expect(secondData.block?.id).toBe(middleBlockId);
  });

  it("get_active_reference returns hasAppContext:false with no run context", async () => {
    const outcome = await runGetActiveReference(deps(undefined));
    expect(outcome.payload.ok).toBe(true);
    expect(outcome.payload.hasAppContext).toBe(false);
    expect(String(outcome.payload.message)).toContain("アプリの実行コンテキスト");
  });

  it("get_active_reference round-trips textSelection references including their extra detail fields", async () => {
    const reference = {
      kind: "textSelection",
      targetId: firstBlockId,
      targetType: "paragraph",
      excerpt: "選択したテキスト",
      selectedText: "選択したテキスト全体",
      mathTex: ["x^2+1"],
    };
    await runContextStore.write(baseContext({ selectedId: firstBlockId, references: [reference] }));

    const outcome = await runGetActiveReference(deps(runContextStore.getRunContextFilePath()));

    expect(outcome.payload.hasAppContext).toBe(true);
    const data = outcome.payload.data as { selectedId: string | null; reference: typeof reference; references: (typeof reference)[] };
    expect(data.selectedId).toBe(firstBlockId);
    expect(data.reference).toEqual(reference);
    expect(data.references).toEqual([reference]);
  });

  it("get_active_reference round-trips an inlineMath reference alongside a second reference", async () => {
    const inlineMathReference = {
      kind: "inlineMath",
      targetId: firstBlockId,
      targetType: "paragraph",
      excerpt: "x^2+1",
      mathInlineId: "math_1",
      tex: "x^2+1",
    };
    const blockReference = {
      kind: "block",
      targetId: firstBlockId,
      targetType: "paragraph",
      excerpt: "本文",
    };
    await runContextStore.write(baseContext({ references: [inlineMathReference, blockReference] }));

    const outcome = await runGetActiveReference(deps(runContextStore.getRunContextFilePath()));

    const data = outcome.payload.data as { reference: unknown; references: unknown[] };
    expect(data.reference).toEqual(inlineMathReference);
    expect(data.references).toEqual([inlineMathReference, blockReference]);
  });

  it("get_active_reference returns an empty references array when nothing is referenced", async () => {
    await runContextStore.write(baseContext({ references: [] }));

    const outcome = await runGetActiveReference(deps(runContextStore.getRunContextFilePath()));

    const data = outcome.payload.data as { reference: unknown; references: unknown[] };
    expect(data.reference).toBeNull();
    expect(data.references).toEqual([]);
  });

  it("reports revisionMatched:false and the current revision after the document is saved again", async () => {
    await runContextStore.write(baseContext({ selectedId: firstBlockId, fileRevision: 1 }));
    const document = await sigmaDocStore.loadDocument(fileId);
    await sigmaDocStore.saveDocument(fileId, document!, { expectedRevision: 1 });

    const outcome = await runGetSelectedBlock(deps(runContextStore.getRunContextFilePath()), {});
    expect(outcome.payload.revisionMatched).toBe(false);
    expect(outcome.payload.currentRevision).toBe(2);
  });
});
