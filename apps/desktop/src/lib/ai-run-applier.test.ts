import { describe, expect, it, vi } from "vitest";

import { DocumentHistoryController, type ParagraphNode, type SigmaDocument } from "@/features/document";
import { createEmptyProposalMergeReport } from "@/lib/ai/proposal-merge-basis";
import {
  applyMcpEditPreview,
  decideAiApprovedDocument,
} from "@/lib/ai-run-applier";
import { createBlankDocument } from "@/lib/blank-document";
import { areSigmaDocumentsEquivalent } from "@/lib/document-equivalence";

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

  it("reports nothing to count when the typing was in a different block", () => {
    const base = createDocument();
    const current = editParagraph(base, "p_2", "入力中の変更");
    const approved = editParagraph(base, "p_1", "AIの変更");

    const decision = decideAiApprovedDocument({
      documentAtApprovalStart: base,
      currentDocument: current,
      diskDocument: approved,
      normalizedApprovedDocument: approved,
    });

    // MISS R3: 重なりの無い採用では、合成も退避も起きていない。
    expect(decision.kind === "merge" && decision.mergeReport).toEqual(emptyAdoptionReport());
    expect(decision.kind === "merge" && decision.resolvedConflicts).toEqual([]);
  });

  it("keeps the human's typing at another position of the paragraph the AI changed", () => {
    const base = editParagraph(createDocument(), "p_1", "段落の本文");
    const current = {
      ...editParagraph(base, "p_1", "段落の本文です"),
      updatedAt: "2026-07-26T00:00:01.000Z",
    };
    const approved = editParagraph(base, "p_1", "新しい段落の本文");

    const decision = decideAiApprovedDocument({
      documentAtApprovalStart: base,
      currentDocument: current,
      diskDocument: approved,
      normalizedApprovedDocument: approved,
    });

    // 同じ段落でも、別の位置への入力は消さずにAIの変更と合成する。
    expect(decision.kind).toBe("merge");
    expect(paragraphText(decision.document, "p_1")).toBe("新しい段落の本文です");
    expect(decision.adoptedDocumentMatchesDisk).toBe(false);
    expect(decision.kind === "merge" && decision.resolvedConflicts).toEqual([]);
    expect(decision.kind === "merge" && decision.mergeReport).toEqual({
      ...emptyAdoptionReport(),
      humanEditedUnits: ["p_1"],
    });
  });

  it("keeps both replacements of the same words, the human's first, and reports the overlap", () => {
    const base = editParagraph(createDocument(), "p_1", "段落の本文");
    const current = editParagraph(base, "p_1", "段落の説明");
    const approved = editParagraph(base, "p_1", "段落の内容");

    const decision = decideAiApprovedDocument({
      documentAtApprovalStart: base,
      currentDocument: current,
      diskDocument: approved,
      normalizedApprovedDocument: approved,
    });

    expect(paragraphText(decision.document, "p_1")).toBe("段落の説明内容");
    expect(decision.kind === "merge" && decision.mergeReport.overlaps).toEqual(["#p_1.children"]);
  });

  it("adopts the AI's version of a block whose merge does not validate, and counts it", () => {
    const base = withContent(createDocument(), [
      { type: "quote", id: "quote", blocks: [paragraph("x", "引用1"), paragraph("z", "引用2")] },
    ]);
    const current = withContent(base, [{ type: "quote", id: "quote", blocks: [paragraph("z", "引用2")] }]);
    const approved = withContent(base, [{ type: "quote", id: "quote", blocks: [paragraph("x", "引用1")] }]);

    const decision = decideAiApprovedDocument({
      documentAtApprovalStart: base,
      currentDocument: current,
      diskDocument: approved,
      normalizedApprovedDocument: approved,
    });

    expect(decision.document.content).toEqual(approved.content);
    expect(decision.adoptedDocumentMatchesDisk).toBe(true);
    expect(decision.kind === "merge" && decision.mergeReport.invalidAfterMerge).toBe(1);
    expect(decision.kind === "merge" && decision.mergeReport.droppedHumanEdits).toEqual(["#quote"]);
    expect(decision.kind === "merge" && decision.resolvedConflicts).toHaveLength(1);
  });

  it("reports the approval as overriding the typing when both set the same attribute differently", () => {
    const base = createDocument();
    const current = withContent(base, [{ ...paragraph("p_1", "本文1"), align: "center" }, base.content[1]!]);
    const approved = withContent(base, [{ ...paragraph("p_1", "本文1"), align: "right" }, base.content[1]!]);

    const decision = decideAiApprovedDocument({
      documentAtApprovalStart: base,
      currentDocument: current,
      diskDocument: approved,
      normalizedApprovedDocument: approved,
    });

    // 人間の入力がAIの値で置き換わったので、黙らずに競合として伝える (従来の通知が出る)。
    expect(decision.document.content[0]).toEqual({ ...paragraph("p_1", "本文1"), align: "right" });
    expect(decision.kind === "merge" && decision.resolvedConflicts).toHaveLength(1);
    expect(decision.kind === "merge" && decision.mergeReport.droppedHumanEdits).toEqual(["#p_1.align"]);
    expect(decision.kind === "merge" && decision.mergeReport.droppedAiEdits).toEqual([]);
  });

  it("keeps every block id once when the human moved a block the AI edited where it was", () => {
    const base = withContent(createDocument(), [
      { type: "quote", id: "q", blocks: [paragraph("x", "引用")] },
      paragraph("y", "移す段落"),
    ]);
    const current = withContent(base, [{ type: "quote", id: "q", blocks: [paragraph("x", "引用"), paragraph("y", "移す段落")] }]);
    const approved = withContent(base, [
      { type: "quote", id: "q", blocks: [paragraph("x", "引用")] },
      paragraph("y", "AIが直した段落"),
    ]);

    const decision = decideAiApprovedDocument({
      documentAtApprovalStart: base,
      currentDocument: current,
      diskDocument: approved,
      normalizedApprovedDocument: approved,
    });

    expect(decision.document.content).toEqual([
      { type: "quote", id: "q", blocks: [paragraph("x", "引用"), paragraph("y", "AIが直した段落")] },
    ]);
    expect(decision.kind === "merge" && decision.mergeReport.duplicateIds).toEqual(["y"]);
  });

  it("adopts the approved document and counts one fallback when the merge gives up", () => {
    const base = createDocument();
    const current = editParagraph(base, "p_2", "入力中の変更");
    const approved = editParagraph(base, "p_1", "AIの変更");

    const decision = decideAiApprovedDocument({
      documentAtApprovalStart: base,
      currentDocument: current,
      diskDocument: approved,
      normalizedApprovedDocument: approved,
      merge: () => ({ ok: false, reason: "合成できません" }),
    });

    expect(decision).toMatchObject({
      kind: "merge",
      document: approved,
      adoptedDocumentMatchesDisk: true,
      resolvedConflicts: ["合成できません"],
      mergeReport: { ...emptyAdoptionReport(), invalidAfterMerge: 1, droppedHumanEdits: ["$"] },
    });
  });

  it("adopts a merged result in the same file and lets one undo restore the pre-adoption document", () => {
    const base = editParagraph(createDocument(), "p_1", "段落の本文");
    const current = deepFreeze(editParagraph(base, "p_1", "段落の本文です"));
    const beforeAdoption = structuredClone(current);
    const approved = editParagraph(base, "p_1", "新しい段落の本文");
    const history = new DocumentHistoryController<SigmaDocument, null>(10);

    const decision = decideAiApprovedDocument({
      documentAtApprovalStart: base,
      currentDocument: current,
      diskDocument: approved,
      normalizedApprovedDocument: approved,
    });
    // 呼び出し側 (EditorShell.applyAiApprovedDocument) と同じく、採用の直前に現在の文書を1手積む。
    history.record({ document: current, selection: null, metadata: { origin: "automation" } });

    // 承認結果は別の教材を作らず、いま開いている教材の文書として採用される (MISS R2)。
    expect(decision.document.docId).toBe(current.docId);
    const undone = history.undo({ document: decision.document, selection: null });
    expect(undone && areSigmaDocumentsEquivalent(undone.document, beforeAdoption)).toBe(true);
    expect(history.redo({ document: undone!.document, selection: null })?.document).toBe(decision.document);
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
  return block?.type === "paragraph"
    ? block.children.map((child) => (child.type === "text" ? child.text : "")).join("")
    : undefined;
}

/** 採用マージの報告で、何も起きなかったときの形。 */
function emptyAdoptionReport() {
  return { ...createEmptyProposalMergeReport(), droppedHumanEdits: [], droppedAiEdits: [] };
}

function paragraph(id: string, text: string): ParagraphNode {
  return { type: "paragraph", id, children: [{ type: "text", text }] };
}

function withContent(document: SigmaDocument, content: SigmaDocument["content"]): SigmaDocument {
  return { ...document, content };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}
