import { describe, expect, it, vi } from "vitest";

import type { SigmaDocument } from "@/features/document";
import {
  applyMcpEditPreview,
  decideAiApprovedDocument,
} from "@/lib/ai-run-applier";
import { createBlankDocument } from "@/lib/blank-document";

describe("decideAiApprovedDocument", () => {
  it("adopts the approved disk document when no typing occurred during approval", () => {
    const base = createDocument();
    const approved = editParagraph(base, "p_1", "AIの変更");

    const decision = decideAiApprovedDocument({
      documentAtApprovalStart: base,
      currentDocument: structuredClone(base),
      diskDocument: approved,
      normalizedApprovedDocument: approved,
    });

    expect(decision).toMatchObject({
      kind: "adopt",
      document: approved,
      adoptedDocumentMatchesDisk: true,
    });
  });

  it("merges typing from a different block into the approved document", () => {
    const base = createDocument();
    const current = {
      ...editParagraph(base, "p_2", "入力中の変更"),
      updatedAt: "2026-07-26T00:00:01.000Z",
    };
    const approved = editParagraph(base, "p_1", "AIの変更");

    const decision = decideAiApprovedDocument({
      documentAtApprovalStart: base,
      currentDocument: current,
      diskDocument: approved,
      normalizedApprovedDocument: approved,
    });

    expect(decision.kind).toBe("merge");
    expect(paragraphText(decision.document, "p_1")).toBe("AIの変更");
    expect(paragraphText(decision.document, "p_2")).toBe("入力中の変更");
    expect(decision.adoptedDocumentMatchesDisk).toBe(false);
  });

  it("keeps editing the same file when both sides changed the same block", () => {
    const base = createDocument();
    const current = {
      ...editParagraph(base, "p_1", "入力中の変更"),
      updatedAt: "2026-07-26T00:00:01.000Z",
    };
    const approved = editParagraph(base, "p_1", "AIの変更");

    const decision = decideAiApprovedDocument({
      documentAtApprovalStart: base,
      currentDocument: current,
      diskDocument: approved,
      normalizedApprovedDocument: approved,
    });

    // 競合しても別教材へ退避しない: 競合した単位だけ承認された内容を採り、同じファイルを更新する。
    expect(decision.kind).toBe("merge");
    expect(paragraphText(decision.document, "p_1")).toBe("AIの変更");
    expect(decision.adoptedDocumentMatchesDisk).toBe(true);
    expect(decision.kind === "merge" && decision.resolvedConflicts.length).toBeGreaterThan(0);
  });

  it("adopts the approval when only the save timestamp moved since the last sync", () => {
    // 保存経路は `{...doc, updatedAt: now}` という別コピーを lastSynced として覚えるため、
    // 承認開始時点の文書は現在の文書と updatedAt だけが違う。これを人手編集と数えると
    // 毎回マージ経路へ落ち、メタ競合で退避教材が生まれていた。
    const base = createDocument();
    const current = structuredClone(base);
    const documentAtApprovalStart = { ...base, updatedAt: "2026-07-26T00:00:05.000Z" };
    const approved = {
      ...editParagraph(base, "p_1", "AIの変更"),
      updatedAt: "2026-07-26T00:00:09.000Z",
    };

    const decision = decideAiApprovedDocument({
      documentAtApprovalStart,
      currentDocument: current,
      diskDocument: approved,
      normalizedApprovedDocument: approved,
    });

    expect(decision).toMatchObject({
      kind: "adopt",
      document: approved,
      adoptedDocumentMatchesDisk: true,
    });
  });

  it("keeps a normalized approval dirty until the normalized form is saved", () => {
    const base = createDocument();
    const diskDocument = editParagraph(base, "p_1", "AIの変更");
    const normalizedApprovedDocument = {
      ...diskDocument,
      metadata: { ...diskDocument.metadata, title: "正規化後" },
    };

    const decision = decideAiApprovedDocument({
      documentAtApprovalStart: base,
      currentDocument: base,
      diskDocument,
      normalizedApprovedDocument,
    });

    expect(decision).toMatchObject({
      kind: "adopt",
      document: normalizedApprovedDocument,
      adoptedDocumentMatchesDisk: false,
    });
  });
});

describe("applyMcpEditPreview", () => {
  it("flushes, awaits an in-flight save, then invokes approval", async () => {
    const order: string[] = [];
    let releaseSave!: () => void;
    const inFlightSave = new Promise<void>((resolve) => {
      releaseSave = () => {
        order.push("save-finished");
        resolve();
      };
    });
    const base = createDocument();
    const approval = applyMcpEditPreview({
      flushOverlayChanges: () => order.push("flushed"),
      inFlightSaveRef: { current: inFlightSave },
      isCurrentDocumentDirty: () => false,
      saveCurrentDocumentRecord: vi.fn(),
      onBeforeSave: vi.fn(),
      getDocumentAtApprovalStart: () => base,
      approve: async () => {
        order.push("approved");
        return { ok: true };
      },
    });

    await Promise.resolve();
    expect(order).toEqual(["flushed"]);
    releaseSave();

    await expect(approval).resolves.toMatchObject({
      ok: true,
      documentAtApprovalStart: base,
      approvalResult: { ok: true },
    });
    expect(order).toEqual(["flushed", "save-finished", "approved"]);
  });
});

function createDocument(): SigmaDocument {
  const blank = createBlankDocument("テスト");
  return {
    ...blank,
    updatedAt: "2026-07-26T00:00:00.000Z",
    content: [
      { type: "paragraph", id: "p_1", children: [{ type: "text", text: "本文1" }] },
      { type: "paragraph", id: "p_2", children: [{ type: "text", text: "本文2" }] },
    ],
  };
}

function editParagraph(document: SigmaDocument, id: string, text: string): SigmaDocument {
  return {
    ...document,
    content: document.content.map((block) => (
      block.id === id && block.type === "paragraph"
        ? { ...block, children: [{ type: "text" as const, text }] }
        : block
    )),
  };
}

function paragraphText(document: SigmaDocument, id: string): string | undefined {
  const block = document.content.find((candidate) => candidate.id === id);
  return block?.type === "paragraph" && block.children[0]?.type === "text"
    ? block.children[0].text
    : undefined;
}
