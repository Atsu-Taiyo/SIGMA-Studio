import { describe, expect, it } from "vitest";

import { mergeExternalDocumentChange } from "./document-block-merge";
import { ensurePageLayout } from "@/lib/page-layout";
import { normalizeOverlaySnapshot } from "@/features/document";
import type { OverlayGeoShape } from "@/features/document";
import type { ParagraphNode, SigmaDocument } from "@/types/sigma-doc";

function paragraph(id: string, text: string): ParagraphNode {
  return { type: "paragraph", id, children: [{ type: "text", text }] };
}

function baseDocument(): SigmaDocument {
  return ensurePageLayout({
    version: "2.0",
    docId: "doc_test",
    metadata: { title: "テスト教材", styleUnits: { fontSize: "pt" } },
    content: [
      paragraph("p1", "最初の段落"),
      paragraph("p2", "2番目の段落"),
      paragraph("p3", "3番目の段落"),
    ],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    updatedAt: "2024-01-01T00:00:00.000Z",
  });
}

function geoShape(id: string, propsOverrides: Partial<OverlayGeoShape["props"]> = {}): OverlayGeoShape {
  return {
    id,
    type: "geo",
    x: 10,
    y: 10,
    props: {
      w: 40,
      h: 20,
      geo: "rectangle",
      fill: "none",
      color: "#000000",
      labelColor: "#000000",
      dash: "solid",
      size: "m",
      ...propsOverrides,
    },
  };
}

function withShapes(document: SigmaDocument, shapes: OverlayGeoShape[]): SigmaDocument {
  const overlaySnapshot = normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot);
  return ensurePageLayout({
    ...document,
    pageLayout: {
      ...document.pageLayout!,
      overlay: {
        ...document.pageLayout?.overlay,
        overlaySnapshot: { ...overlaySnapshot, shapes },
      },
    },
  });
}

function replaceParagraphText(document: SigmaDocument, id: string, text: string): SigmaDocument {
  return {
    ...document,
    content: document.content.map((block) => (block.id === id ? paragraph(id, text) : block)),
  };
}

function removeBlock(document: SigmaDocument, id: string): SigmaDocument {
  return { ...document, content: document.content.filter((block) => block.id !== id) };
}

function insertBlock(document: SigmaDocument, index: number, block: ParagraphNode): SigmaDocument {
  const content = [...document.content];
  content.splice(index, 0, block);
  return { ...document, content };
}

function withOverlayTimestamp(document: SigmaDocument, updatedAt: string): SigmaDocument {
  return {
    ...document,
    pageLayout: {
      ...document.pageLayout!,
      overlay: { ...document.pageLayout?.overlay, updatedAt },
    },
  };
}

function shapesOf(document: SigmaDocument): OverlayGeoShape[] {
  return normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot).shapes as OverlayGeoShape[];
}

describe("mergeExternalDocumentChange", () => {
  it("adopts theirs as-is when the human made no unsaved edits", () => {
    const base = baseDocument();
    const mine = base;
    const theirs = replaceParagraphText(base, "p1", "AIが書き換えた段落");

    const result = mergeExternalDocumentChange(base, mine, theirs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged).toEqual(theirs);
    }
  });

  it("does not treat object key reordering as a human edit", () => {
    const base = baseDocument();
    const first = base.content[0];
    if (first?.type !== "paragraph") {
      throw new Error("paragraph fixture expected");
    }
    const mine: SigmaDocument = {
      ...base,
      content: [
        { id: first.id, children: first.children, type: first.type },
        ...base.content.slice(1),
      ],
    };
    const theirs = replaceParagraphText(base, "p1", "AIが書き換えた段落");

    const result = mergeExternalDocumentChange(base, mine, theirs);
    expect(result).toEqual({ ok: true, merged: theirs });
  });

  it("keeps both edits when the human and the AI touch different paragraphs", () => {
    const base = baseDocument();
    const mine = replaceParagraphText(base, "p1", "人間が入力中の段落X");
    const theirs = replaceParagraphText(base, "p2", "AIが書き換えた段落Y");

    const result = mergeExternalDocumentChange(base, mine, theirs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged.content.find((b) => b.id === "p1")).toEqual(paragraph("p1", "人間が入力中の段落X"));
      expect(result.merged.content.find((b) => b.id === "p2")).toEqual(paragraph("p2", "AIが書き換えた段落Y"));
      expect(result.merged.content.find((b) => b.id === "p3")).toEqual(paragraph("p3", "3番目の段落"));
    }
  });

  it("fails when the human and the AI edit the exact same block differently", () => {
    const base = baseDocument();
    const mine = replaceParagraphText(base, "p1", "人間の書き換え");
    const theirs = replaceParagraphText(base, "p1", "AIの書き換え");

    const result = mergeExternalDocumentChange(base, mine, theirs);
    expect(result.ok).toBe(false);
  });

  it("succeeds when the AI inserts a block and the human edits an unrelated paragraph", () => {
    const base = baseDocument();
    const mine = replaceParagraphText(base, "p3", "人間が入力中の段落");
    const theirs = insertBlock(base, 1, paragraph("p_ai_inserted", "AIが挿入した段落"));

    const result = mergeExternalDocumentChange(base, mine, theirs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged.content.map((b) => b.id)).toEqual(["p1", "p_ai_inserted", "p2", "p3"]);
      expect(result.merged.content.find((b) => b.id === "p3")).toEqual(paragraph("p3", "人間が入力中の段落"));
      expect(result.merged.content.find((b) => b.id === "p_ai_inserted")).toEqual(
        paragraph("p_ai_inserted", "AIが挿入した段落"),
      );
    }
  });

  it("keeps both blocks when the human adds one and the AI inserts another elsewhere", () => {
    // 承認IPCの往復中にユーザーが改行して段落を足す、というのは競合ではない。挿入位置を
    // それぞれのアンカーで解決し、どちらの段落も残す。
    const base = baseDocument();
    const mine = insertBlock(base, 0, paragraph("p_human_inserted", "人間が追加した段落"));
    const theirs = insertBlock(base, 1, paragraph("p_ai_inserted", "AIが挿入した段落"));

    const result = mergeExternalDocumentChange(base, mine, theirs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged.content.map((block) => block.id)).toEqual([
        "p_human_inserted",
        "p1",
        "p_ai_inserted",
        "p2",
        "p3",
      ]);
      expect(result.resolvedConflicts).toBeUndefined();
    }
  });

  it("succeeds when the AI changes an overlay shape and the human edits body text", () => {
    const base = withShapes(baseDocument(), [geoShape("shape_1")]);
    const mine = replaceParagraphText(base, "p1", "人間が入力中の段落");
    const theirs = withShapes(base, [geoShape("shape_1", { color: "#ff0000" })]);

    const result = mergeExternalDocumentChange(base, mine, theirs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged.content.find((b) => b.id === "p1")).toEqual(paragraph("p1", "人間が入力中の段落"));
      expect(shapesOf(result.merged)).toEqual([geoShape("shape_1", { color: "#ff0000" })]);
    }
  });

  it("fails when the human and the AI edit the same overlay shape differently", () => {
    const base = withShapes(baseDocument(), [geoShape("shape_1")]);
    const mine = withShapes(base, [geoShape("shape_1", { color: "#00ff00" })]);
    const theirs = withShapes(base, [geoShape("shape_1", { color: "#ff0000" })]);

    const result = mergeExternalDocumentChange(base, mine, theirs);
    expect(result.ok).toBe(false);
  });

  it("keeps both new shapes when the human and the AI each add one", () => {
    const base = withShapes(baseDocument(), [geoShape("shape_1")]);
    const mine = withShapes(base, [geoShape("shape_1"), geoShape("shape_human")]);
    const theirs = withShapes(base, [geoShape("shape_1"), geoShape("shape_ai")]);

    // どちらもshape_1には触れておらず、追加したIDも別。同じアンカーへの追加はAI→人間の順で
    // 決定的に並べる。
    const result = mergeExternalDocumentChange(base, mine, theirs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(shapesOf(result.merged).map((shape) => shape.id)).toEqual([
        "shape_1",
        "shape_ai",
        "shape_human",
      ]);
    }
  });

  it("keeps the human's shape reordering while adopting the AI's edit to another shape", () => {
    // shapes の配列順は重なり(描画)順に影響しうるため、人間の並び替えだけの変更も
    // 構造変更として扱い、theirs が構造無変更なら mine の順序が勝つこと。
    const base = withShapes(baseDocument(), [geoShape("shape_1"), geoShape("shape_2")]);
    const mine = withShapes(base, [geoShape("shape_2"), geoShape("shape_1")]);
    const theirs = withShapes(base, [geoShape("shape_1", { color: "#ff0000" }), geoShape("shape_2")]);

    const result = mergeExternalDocumentChange(base, mine, theirs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(shapesOf(result.merged)).toEqual([
        geoShape("shape_2"),
        geoShape("shape_1", { color: "#ff0000" }),
      ]);
    }
  });

  it("succeeds trivially when neither side changed anything relevant to the other axis", () => {
    const base = withShapes(baseDocument(), [geoShape("shape_1")]);
    const mine = replaceParagraphText(base, "p1", "人間の編集");
    const theirs = base;

    const result = mergeExternalDocumentChange(base, mine, theirs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged.content.find((b) => b.id === "p1")).toEqual(paragraph("p1", "人間の編集"));
      expect(shapesOf(result.merged)).toEqual([geoShape("shape_1")]);
    }
  });

  it("fails on an edit-vs-delete conflict: the human deletes a block the AI just edited", () => {
    const base = baseDocument();
    const mine = removeBlock(base, "p2");
    const theirs = replaceParagraphText(base, "p2", "AIが編集した段落");

    const result = mergeExternalDocumentChange(base, mine, theirs);
    expect(result.ok).toBe(false);
  });

  it("fails on an edit-vs-delete conflict: the AI deletes a block the human is editing", () => {
    const base = baseDocument();
    const mine = replaceParagraphText(base, "p2", "人間が入力中の段落");
    const theirs = removeBlock(base, "p2");

    const result = mergeExternalDocumentChange(base, mine, theirs);
    expect(result.ok).toBe(false);
  });

  it("succeeds when both sides delete the exact same block (identical structural change)", () => {
    const base = baseDocument();
    const mine = removeBlock(base, "p2");
    const theirs = removeBlock(base, "p2");

    const result = mergeExternalDocumentChange(base, mine, theirs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged.content.map((b) => b.id)).toEqual(["p1", "p3"]);
    }
  });

  it("adopts theirs's document-level metadata change (e.g. AI-driven title update) alongside a human content edit", () => {
    const base = baseDocument();
    const mine = replaceParagraphText(base, "p1", "人間が入力中の段落");
    const theirs: SigmaDocument = { ...base, metadata: { ...base.metadata, title: "AIが変更したタイトル" } };

    const result = mergeExternalDocumentChange(base, mine, theirs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged.metadata.title).toBe("AIが変更したタイトル");
      expect(result.merged.content.find((b) => b.id === "p1")).toEqual(paragraph("p1", "人間が入力中の段落"));
    }
  });

  it("fails when both the human and the AI change document-level metadata differently", () => {
    const base = baseDocument();
    const mine: SigmaDocument = { ...base, metadata: { ...base.metadata, title: "人間が変更したタイトル" } };
    const theirs: SigmaDocument = { ...base, metadata: { ...base.metadata, title: "AIが変更したタイトル" } };

    const result = mergeExternalDocumentChange(base, mine, theirs);
    expect(result.ok).toBe(false);
  });

  it("returns theirs when mine happens to already match theirs (defensive no-op case)", () => {
    const base = baseDocument();
    const theirs = replaceParagraphText(base, "p1", "収束済みの内容");
    const mine = replaceParagraphText(base, "p1", "収束済みの内容");

    const result = mergeExternalDocumentChange(base, mine, theirs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged).toEqual(theirs);
    }
  });
  it("does not treat the save timestamp as a metadata change", () => {
    // 保存経路もキー入力も `{...doc, updatedAt: now}` という別コピーを作る。updatedAt を
    // 内容差分として数えていたころは、AI承認のたびにここでメタ競合になり、未保存の入力が
    // 「（アプリ内編集の退避）」という別教材へ切り出されていた。
    const base = { ...baseDocument(), updatedAt: "2024-01-01T00:00:00.000Z" };
    const mine = { ...replaceParagraphText(base, "p2", "人間が入力中"), updatedAt: "2024-01-01T00:00:01.000Z" };
    const theirs = { ...replaceParagraphText(base, "p1", "AIの変更"), updatedAt: "2024-01-01T00:00:09.000Z" };

    const result = mergeExternalDocumentChange(base, mine, theirs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged.content.find((block) => block.id === "p1")).toEqual(paragraph("p1", "AIの変更"));
      expect(result.merged.content.find((block) => block.id === "p2")).toEqual(paragraph("p2", "人間が入力中"));
      // 記録用の時刻はディスク正本に揃える。
      expect(result.merged.updatedAt).toBe("2024-01-01T00:00:09.000Z");
    }
  });

  it("does not treat the overlay write timestamp as a metadata change", () => {
    const base = withOverlayTimestamp(withShapes(baseDocument(), [geoShape("shape_1")]), "2024-01-01T00:00:00.000Z");
    const mine = withOverlayTimestamp(replaceParagraphText(base, "p1", "人間が入力中"), "2024-01-01T00:00:02.000Z");
    const theirs = withOverlayTimestamp(
      withShapes(base, [geoShape("shape_1", { color: "#ff0000" })]),
      "2024-01-01T00:00:07.000Z",
    );

    const result = mergeExternalDocumentChange(base, mine, theirs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged.content.find((block) => block.id === "p1")).toEqual(paragraph("p1", "人間が入力中"));
      expect(shapesOf(result.merged)).toEqual([geoShape("shape_1", { color: "#ff0000" })]);
      expect(result.merged.pageLayout?.overlay?.updatedAt).toBe("2024-01-01T00:00:07.000Z");
    }
  });

  it("takes theirs for the conflicting block only when resolution is prefer-theirs", () => {
    const base = baseDocument();
    const mine = replaceParagraphText(replaceParagraphText(base, "p1", "人間の変更"), "p2", "人間だけが触った段落");
    const theirs = replaceParagraphText(base, "p1", "AIの変更");

    const result = mergeExternalDocumentChange(base, mine, theirs, { resolution: "prefer-theirs" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged.content.find((block) => block.id === "p1")).toEqual(paragraph("p1", "AIの変更"));
      expect(result.merged.content.find((block) => block.id === "p2")).toEqual(paragraph("p2", "人間だけが触った段落"));
      expect(result.resolvedConflicts).toHaveLength(1);
    }
  });

  it("keeps theirs' edit when the human deleted the block, under prefer-theirs", () => {
    const base = baseDocument();
    const mine = removeBlock(base, "p2");
    const theirs = replaceParagraphText(base, "p2", "AIが書き換えた段落");

    expect(mergeExternalDocumentChange(base, mine, theirs).ok).toBe(false);

    const result = mergeExternalDocumentChange(base, mine, theirs, { resolution: "prefer-theirs" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged.content.map((block) => block.id)).toEqual(["p1", "p2", "p3"]);
      expect(result.merged.content.find((block) => block.id === "p2")).toEqual(paragraph("p2", "AIが書き換えた段落"));
      expect(result.resolvedConflicts).toHaveLength(1);
    }
  });

  it("drops the block the AI deleted even when the human was editing it, under prefer-theirs", () => {
    const base = baseDocument();
    const mine = replaceParagraphText(base, "p2", "人間が入力中");
    const theirs = removeBlock(base, "p2");

    const result = mergeExternalDocumentChange(base, mine, theirs, { resolution: "prefer-theirs" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged.content.map((block) => block.id)).toEqual(["p1", "p3"]);
      expect(result.resolvedConflicts).toHaveLength(1);
    }
  });

  it("falls back to theirs' order when both sides added the same block id, under prefer-theirs", () => {
    const base = baseDocument();
    const mine = insertBlock(base, 0, paragraph("p_new", "人間が追加"));
    const theirs = insertBlock(base, 3, paragraph("p_new", "AIが追加"));

    expect(mergeExternalDocumentChange(base, mine, theirs).ok).toBe(false);

    const result = mergeExternalDocumentChange(base, mine, theirs, { resolution: "prefer-theirs" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged.content.map((block) => block.id)).toEqual(["p1", "p2", "p3", "p_new"]);
      expect(result.merged.content.find((block) => block.id === "p_new")).toEqual(paragraph("p_new", "AIが追加"));
      expect(result.resolvedConflicts).toHaveLength(1);
    }
  });

  it("keeps the human's block move while adopting the AI's insertion", () => {
    const base = baseDocument();
    const mine = insertBlock(removeBlock(base, "p3"), 0, paragraph("p3", "3番目の段落"));
    const theirs = insertBlock(base, 1, paragraph("p_ai_inserted", "AIが挿入した段落"));

    const result = mergeExternalDocumentChange(base, mine, theirs);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.merged.content.map((block) => block.id)).toEqual(["p3", "p1", "p_ai_inserted", "p2"]);
    }
  });
});
