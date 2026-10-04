import { describe, expect, it } from "vitest";

import { createEmptyDocumentMergeReport, mergeExternalDocumentChange } from "./document-block-merge";
import { ensurePageLayout } from "@/lib/page-layout";
import { normalizeOverlaySnapshot } from "@/features/document";
import type {
  OverlayGeoShape,
  OverlayShape,
  OverlaySnapshot,
  OverlayTableShape,
  ProblemNode,
  QuoteBlockNode,
} from "@/features/document";
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

function withShapes(document: SigmaDocument, shapes: OverlayShape[]): SigmaDocument {
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

  it("does not reconcile a block one side moved and the other edited, under prefer-theirs", () => {
    // prefer-theirs は単位ごとの規則のまま (他者の書き込みの取り込み)。id の重複を解く規則は
    // merge-both だけが持つ。
    const base = withContent(baseDocument(), [quote("q", [paragraph("x", "引用")]), paragraph("y", "移す段落")]);
    const mine = withContent(base, [quote("q", [paragraph("x", "引用"), paragraph("y", "移す段落")])]);
    const theirs = withContent(base, [quote("q", [paragraph("x", "引用")]), paragraph("y", "AIが直した段落")]);

    const result = mergeExternalDocumentChange(base, mine, theirs, { resolution: "prefer-theirs" });

    expect(result.ok && result.merged.content).toEqual([
      quote("q", [paragraph("x", "引用"), paragraph("y", "移す段落")]),
      paragraph("y", "AIが直した段落"),
    ]);
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

describe("mergeExternalDocumentChange with merge-both", () => {
  const mergeBoth = (base: SigmaDocument, mine: SigmaDocument, theirs: SigmaDocument) => {
    const result = mergeExternalDocumentChange(base, mine, theirs, { resolution: "merge-both" });
    if (!result.ok) {
      throw new Error(`merge-both must not fail: ${result.reason}`);
    }
    return result;
  };

  it("keeps both edits when the human and the AI edit different places of the same paragraph", () => {
    const base = replaceParagraphText(baseDocument(), "p1", "段落の本文");
    const mine = replaceParagraphText(base, "p1", "段落の本文です");
    const theirs = replaceParagraphText(base, "p1", "新しい段落の本文");

    const result = mergeBoth(base, mine, theirs);

    expect(paragraphText(result.merged, "p1")).toBe("新しい段落の本文です");
    expect(result.report?.mergedUnits).toEqual(["p1"]);
    expect(result.report?.overlaps).toEqual([]);
    expect(result.resolvedConflicts).toBeUndefined();
  });

  it("keeps both replacements of the same range, the human's first", () => {
    const base = replaceParagraphText(baseDocument(), "p1", "段落の本文");
    const mine = replaceParagraphText(base, "p1", "段落の説明");
    const theirs = replaceParagraphText(base, "p1", "段落の内容");

    const result = mergeBoth(base, mine, theirs);

    expect(paragraphText(result.merged, "p1")).toBe("段落の説明内容");
    expect(result.report?.overlaps).toEqual(["#p1.children"]);
    // 両方の文字が残ったので、どちらの入力も落ちていない。
    expect(result.report?.droppedHumanEdits).toEqual([]);
    expect(result.report?.droppedAiEdits).toEqual([]);
    expect(result.resolvedConflicts).toBeUndefined();
  });

  it("puts the human's text before the AI's when both insert at the same position", () => {
    const base = replaceParagraphText(baseDocument(), "p1", "段落の本文");
    const mine = replaceParagraphText(base, "p1", "段落の本文（手入力）");
    const theirs = replaceParagraphText(base, "p1", "段落の本文【AI】");

    const result = mergeBoth(base, mine, theirs);

    expect(paragraphText(result.merged, "p1")).toBe("段落の本文（手入力）【AI】");
  });

  it("keeps the edits of different blocks and leaves an untouched document report empty", () => {
    const base = baseDocument();
    const mine = replaceParagraphText(base, "p1", "人間が入力中の段落X");
    const theirs = replaceParagraphText(base, "p2", "AIが書き換えた段落Y");

    const result = mergeBoth(base, mine, theirs);

    expect(paragraphText(result.merged, "p1")).toBe("人間が入力中の段落X");
    expect(paragraphText(result.merged, "p2")).toBe("AIが書き換えた段落Y");
    expect(result.report).toEqual({
      mergedUnits: [],
      overlaps: [],
      capped: false,
      cappedPaths: [],
      reidentified: 0,
      editBeatsDelete: [],
      duplicateIds: [],
      invalidAfterMerge: 0,
      droppedHumanEdits: [],
      droppedAiEdits: [],
    });
  });

  it("orders blocks both sides inserted at the same place human first, then AI", () => {
    const base = baseDocument();
    const mine = insertBlock(base, 1, paragraph("p_human", "人間が追加した段落"));
    const theirs = insertBlock(base, 1, paragraph("p_ai", "AIが追加した段落"));

    const result = mergeBoth(base, mine, theirs);

    expect(result.merged.content.map((block) => block.id)).toEqual(["p1", "p_human", "p_ai", "p2", "p3"]);
  });

  it("orders shapes both sides added human first, then AI", () => {
    const base = withShapes(baseDocument(), [geoShape("shape_1")]);
    const mine = withShapes(base, [geoShape("shape_1"), geoShape("shape_human")]);
    const theirs = withShapes(base, [geoShape("shape_1"), geoShape("shape_ai")]);

    const result = mergeBoth(base, mine, theirs);

    expect(shapesOf(result.merged).map((shape) => shape.id)).toEqual(["shape_1", "shape_human", "shape_ai"]);
  });

  it("merges a shape both sides changed key by key", () => {
    const base = withShapes(baseDocument(), [geoShape("shape_1")]);
    const mine = withShapes(base, [geoShape("shape_1", { fill: "solid" })]);
    const theirs = withShapes(base, [geoShape("shape_1", { color: "#ff0000" })]);

    const result = mergeBoth(base, mine, theirs);

    expect(shapesOf(result.merged)).toEqual([geoShape("shape_1", { fill: "solid", color: "#ff0000" })]);
    expect(result.report?.mergedUnits).toEqual(["shape_1"]);
  });

  it("takes the AI's value where both set the same shape property differently", () => {
    const base = withShapes(baseDocument(), [geoShape("shape_1")]);
    const mine = withShapes(base, [geoShape("shape_1", { color: "#00ff00" })]);
    const theirs = withShapes(base, [geoShape("shape_1", { color: "#ff0000" })]);

    const result = mergeBoth(base, mine, theirs);

    expect(shapesOf(result.merged)).toEqual([geoShape("shape_1", { color: "#ff0000" })]);
    expect(result.report?.overlaps).toEqual(["#shape_1.props.color"]);
    expect(result.report?.droppedHumanEdits).toEqual(["#shape_1.props.color"]);
    expect(result.resolvedConflicts).toHaveLength(1);
  });

  it("keeps the human's edit of a block the AI deleted", () => {
    const base = baseDocument();
    const mine = replaceParagraphText(base, "p2", "人間が入力中");
    const theirs = removeBlock(base, "p2");

    const result = mergeBoth(base, mine, theirs);

    expect(result.merged.content.map((block) => block.id)).toEqual(["p1", "p2", "p3"]);
    expect(paragraphText(result.merged, "p2")).toBe("人間が入力中");
    expect(result.report?.editBeatsDelete).toEqual(["#p2"]);
    // 承認したAIの削除は反映されなかったので、黙らずに記録する。
    expect(result.report?.droppedAiEdits).toEqual(["#p2"]);
    expect(result.resolvedConflicts).toHaveLength(1);
  });

  it("keeps the AI's edit of a block the human deleted, as a conflict resolved for the AI", () => {
    const base = baseDocument();
    const mine = removeBlock(base, "p2");
    const theirs = replaceParagraphText(base, "p2", "AIが書き換えた段落");

    const result = mergeBoth(base, mine, theirs);

    expect(paragraphText(result.merged, "p2")).toBe("AIが書き換えた段落");
    expect(result.report?.editBeatsDelete).toEqual(["#p2"]);
    expect(result.report?.droppedHumanEdits).toEqual(["#p2"]);
    expect(result.resolvedConflicts).toHaveLength(1);
  });

  it("merges a block both sides added under the same id instead of giving up", () => {
    const base = baseDocument();
    const mine = insertBlock(base, 0, paragraph("p_new", "人間"));
    const theirs = insertBlock(base, 3, paragraph("p_new", "AI"));

    const result = mergeBoth(base, mine, theirs);

    expect(result.merged.content.map((block) => block.id)).toEqual(["p_new", "p1", "p2", "p3"]);
    expect(paragraphText(result.merged, "p_new")).toBe("人間AI");
    expect(result.report?.mergedUnits).toEqual(["p_new"]);
  });

  it("follows the AI's order when both sides reordered differently, keeping both insertions", () => {
    const base = baseDocument();
    const [p1, p2, p3] = base.content;
    const mine = withContent(base, [paragraph("p_human", "人間が追加した段落"), p2!, p1!, p3!]);
    const theirs = withContent(base, [p3!, p1!, p2!]);

    const result = mergeBoth(base, mine, theirs);

    expect(result.merged.content.map((block) => block.id)).toEqual(["p_human", "p3", "p1", "p2"]);
    expect(result.report?.overlaps).toEqual(["$.content"]);
    expect(result.report?.droppedHumanEdits).toEqual(["$.content"]);
    expect(result.resolvedConflicts).toHaveLength(1);
  });

  it("takes the AI's version of a block whose merge does not validate, keeping the other merges", () => {
    // 人間が x を、AIが z を消すと、合成した引用は空になり (引用は1ブロック以上が必要) 検証を通らない。
    const base = withContent(baseDocument(), [
      quote("quote", [paragraph("x", "引用1"), paragraph("z", "引用2")]),
      paragraph("p1", "段落の本文"),
    ]);
    const mine = withContent(base, [quote("quote", [paragraph("z", "引用2")]), paragraph("p1", "段落の本文です")]);
    const theirs = withContent(base, [quote("quote", [paragraph("x", "引用1")]), paragraph("p1", "新しい段落の本文")]);

    const result = mergeBoth(base, mine, theirs);

    expect(result.merged.content[0]).toEqual(quote("quote", [paragraph("x", "引用1")]));
    expect(paragraphText(result.merged, "p1")).toBe("新しい段落の本文です");
    expect(result.report?.invalidAfterMerge).toBe(1);
    expect(result.report?.mergedUnits).toEqual(["p1"]);
    expect(result.report?.droppedHumanEdits).toEqual(["#quote"]);
    expect(result.resolvedConflicts).toHaveLength(1);
  });

  it("keeps the AI's move inside a block and merges the human's edit into the moved block", () => {
    // AIが設問 q1 を解答へ移し、人間は設問のまま q1 を直した。合成すると q1 が2か所に入るので、
    // 移した側 (AI) の位置に1つだけ残し、人間の直した文を合成する。
    const base = withContent(baseDocument(), [
      problem("prob", [paragraph("q1", "設問")], [paragraph("s1", "解答")]),
    ]);
    const mine = withContent(base, [problem("prob", [paragraph("q1", "設問を直した")], [paragraph("s1", "解答")])]);
    const theirs = withContent(base, [problem("prob", [], [paragraph("s1", "解答"), paragraph("q1", "設問")])]);

    const result = mergeBoth(base, mine, theirs);

    expect(result.merged.content).toEqual([
      problem("prob", [], [paragraph("s1", "解答"), paragraph("q1", "設問を直した")]),
    ]);
    expect(result.report?.duplicateIds).toEqual(["q1"]);
    expect(result.report?.invalidAfterMerge).toBe(0);
    expect(result.report?.mergedUnits).toEqual(["prob", "q1"]);
    expect(result.report?.editBeatsDelete).toEqual([]);
    expect(result.resolvedConflicts).toBeUndefined();
  });

  it("keeps the human's move into a merged block and merges the AI's edit of the moved block", () => {
    // 人間が段落 y を引用の中へ移し、AIは引用の中身と y をそれぞれ直した。合成した引用に y を
    // 入れると、AIの直した y (本文の直下) と2か所になる。人間が移した位置に1つだけ残す。
    const base = withContent(baseDocument(), [quote("quote", [paragraph("x", "引用")]), paragraph("y", "移す段落")]);
    const mine = withContent(base, [quote("quote", [paragraph("x", "引用"), paragraph("y", "移す段落")])]);
    const theirs = withContent(base, [
      quote("quote", [paragraph("x", "AIが直した引用")]),
      paragraph("y", "AIが直した段落"),
    ]);

    const result = mergeBoth(base, mine, theirs);

    expect(result.merged.content).toEqual([
      quote("quote", [paragraph("x", "AIが直した引用"), paragraph("y", "AIが直した段落")]),
    ]);
    expect(result.report?.duplicateIds).toEqual(["y"]);
    expect(result.report?.invalidAfterMerge).toBe(0);
    expect(result.report?.editBeatsDelete).toEqual([]);
    expect(result.resolvedConflicts).toBeUndefined();
  });

  it("takes the AI's version of a shape whose merge does not validate", () => {
    // AIが2行目を消し、人間は2行目のセルを直した。セルが消えた行を指すので表として成り立たない。
    const base = withShapes(baseDocument(), [tableShape("table", ["r1", "r2"], { c1: "上", c2: "下" })]);
    const mine = withShapes(base, [tableShape("table", ["r1", "r2"], { c1: "上", c2: "下を直した" })]);
    const theirs = withShapes(base, [tableShape("table", ["r1"], { c1: "上" })]);

    const result = mergeBoth(base, mine, theirs);

    expect(shapesOf(result.merged)).toEqual(shapesOf(theirs));
    expect(result.report?.invalidAfterMerge).toBe(1);
    expect(result.report?.droppedHumanEdits).toEqual(["#table"]);
    expect(result.resolvedConflicts).toHaveLength(1);
  });

  it("merges document settings both sides changed, keeping the AI's write timestamp", () => {
    const base = { ...baseDocument(), updatedAt: "2024-01-01T00:00:00.000Z" };
    const mine = {
      ...base,
      metadata: { ...base.metadata, title: "人間が変えた題名" },
      updatedAt: "2024-01-01T00:00:01.000Z",
    };
    const theirs = {
      ...base,
      outputProfiles: { ...base.outputProfiles, student: { includeAnswers: false } },
      updatedAt: "2024-01-01T00:00:09.000Z",
    };

    const result = mergeBoth(base, mine, theirs);

    expect(result.merged.metadata.title).toBe("人間が変えた題名");
    expect(result.merged.outputProfiles.student).toEqual({ includeAnswers: false });
    expect(result.merged.updatedAt).toBe("2024-01-01T00:00:09.000Z");
    expect(result.report?.mergedUnits).toEqual(["$"]);
    expect(result.resolvedConflicts).toBeUndefined();
  });

  it("takes the AI's setting where both changed the same one", () => {
    const base = baseDocument();
    const mine: SigmaDocument = { ...base, metadata: { ...base.metadata, title: "人間が変更したタイトル" } };
    const theirs: SigmaDocument = { ...base, metadata: { ...base.metadata, title: "AIが変更したタイトル" } };

    const result = mergeBoth(base, mine, theirs);

    expect(result.merged.metadata.title).toBe("AIが変更したタイトル");
    expect(result.report?.overlaps).toEqual(["$.metadata.title"]);
    expect(result.report?.droppedHumanEdits).toEqual(["$.metadata.title"]);
    expect(result.resolvedConflicts).toHaveLength(1);
  });

  it("takes the AI's settings when the merged settings do not validate", () => {
    // 安全網の確認: 合成した教材全体の情報が検証を通らなければ、AI側の情報を採る。
    const base = baseDocument();
    const mine = {
      ...base,
      metadata: { ...base.metadata, styleUnits: "壊れた値" },
    } as unknown as SigmaDocument;
    const theirs: SigmaDocument = { ...base, metadata: { ...base.metadata, title: "AIが変更したタイトル" } };

    const result = mergeBoth(base, mine, theirs);

    expect(result.merged.metadata).toEqual(theirs.metadata);
    expect(result.report?.invalidAfterMerge).toBe(1);
    expect(result.report?.droppedHumanEdits).toEqual(["$.metadata"]);
    expect(result.resolvedConflicts).toHaveLength(1);
  });

  it("keeps the overlay assets both sides added", () => {
    const base = withShapes(baseDocument(), [geoShape("shape_1")]);
    const mine = withAssets(withShapes(base, [geoShape("shape_1"), imageShape("image_human", "asset_human")]), ["asset_human"]);
    const theirs = withAssets(withShapes(base, [geoShape("shape_1"), imageShape("image_ai", "asset_ai")]), ["asset_ai"]);

    const result = mergeBoth(base, mine, theirs);

    const snapshot = normalizeOverlaySnapshot(result.merged.pageLayout?.overlay?.overlaySnapshot);
    expect(Object.keys(snapshot.assets).sort()).toEqual(["asset_ai", "asset_human"]);
    expect(snapshot.shapes.map((shape) => shape.id)).toEqual(["shape_1", "image_human", "image_ai"]);
  });

  it("returns the AI's document with an empty report when the human changed nothing", () => {
    const base = baseDocument();
    const theirs = replaceParagraphText(base, "p1", "AIが書き換えた段落");

    const result = mergeBoth(base, base, theirs);

    expect(result.merged).toBe(theirs);
    expect(result.report?.mergedUnits).toEqual([]);
    expect(result.report?.invalidAfterMerge).toBe(0);
  });

  it("keeps the AI's move and merges the human's edit of the moved block", () => {
    // AIが段落 y を引用の中へ移し、人間は元の場所の y を直した。編集を残すと y が2か所になるので、
    // 移した側 (AI) の位置に1つだけ残し、人間の直した文を合成する。
    const base = withContent(baseDocument(), [quote("quote", [paragraph("x", "引用")]), paragraph("y", "移す段落")]);
    const mine = withContent(base, [quote("quote", [paragraph("x", "引用")]), paragraph("y", "人間が直した段落")]);
    const theirs = withContent(base, [quote("quote", [paragraph("x", "引用"), paragraph("y", "移す段落")])]);

    const result = mergeBoth(base, mine, theirs);

    expect(result.merged.content).toEqual([
      quote("quote", [paragraph("x", "引用"), paragraph("y", "人間が直した段落")]),
    ]);
    expect(result.report?.duplicateIds).toEqual(["y"]);
    expect(result.report?.invalidAfterMerge).toBe(0);
    expect(result.report?.editBeatsDelete).toEqual([]);
    expect(result.resolvedConflicts).toBeUndefined();
  });

  it("takes the AI's block whole when the AI changed its kind", () => {
    const base = replaceParagraphText(baseDocument(), "p1", "段落の本文");
    const mine = replaceParagraphText(base, "p1", "段落の本文です");
    const theirs = withContent(base, [
      { type: "heading", id: "p1", level: 2, children: [{ type: "text", text: "段落の本文" }] },
      ...base.content.slice(1),
    ]);

    const result = mergeBoth(base, mine, theirs);

    expect(result.merged.content[0]).toEqual(theirs.content[0]);
    expect(result.report?.overlaps).toEqual(["#p1"]);
    expect(result.report?.mergedUnits).toEqual([]);
    expect(result.report?.droppedHumanEdits).toEqual(["#p1"]);
    expect(result.resolvedConflicts).toHaveLength(1);
  });

  it("records the AI's edit as dropped when the human changed the block's kind", () => {
    const base = replaceParagraphText(baseDocument(), "p1", "段落の本文");
    const mine = withContent(base, [
      { type: "heading", id: "p1", level: 2, children: [{ type: "text", text: "段落の本文" }] },
      ...base.content.slice(1),
    ]);
    const theirs = replaceParagraphText(base, "p1", "新しい段落の本文");

    const result = mergeBoth(base, mine, theirs);

    expect(result.merged.content[0]).toEqual(mine.content[0]);
    expect(result.report?.droppedAiEdits).toEqual(["#p1"]);
    expect(result.report?.droppedHumanEdits).toEqual([]);
    expect(result.resolvedConflicts).toHaveLength(1);
  });

  it("takes the AI's value and records the human's input as dropped when both set an attribute differently", () => {
    const base = baseDocument();
    const mine = withContent(base, [{ ...paragraph("p1", "最初の段落"), align: "center" }, ...base.content.slice(1)]);
    const theirs = withContent(base, [{ ...paragraph("p1", "最初の段落"), align: "right" }, ...base.content.slice(1)]);

    const result = mergeBoth(base, mine, theirs);

    expect(result.merged.content[0]).toEqual({ ...paragraph("p1", "最初の段落"), align: "right" });
    expect(result.report?.droppedHumanEdits).toEqual(["#p1.align"]);
    expect(result.resolvedConflicts).toHaveLength(1);
  });

  it("keeps the human's move when the AI edited the moved block where it was", () => {
    // 人間が段落 y を引用 q の中へ移し、AIは元の場所の y を直した (q はAI側で無変更)。
    const base = withContent(baseDocument(), [quote("q", [paragraph("x", "引用")]), paragraph("y", "移す段落")]);
    const mine = withContent(base, [quote("q", [paragraph("x", "引用"), paragraph("y", "移す段落")])]);
    const theirs = withContent(base, [quote("q", [paragraph("x", "引用")]), paragraph("y", "AIが直した段落")]);

    const result = mergeBoth(base, mine, theirs);

    expect(result.merged.content).toEqual([quote("q", [paragraph("x", "引用"), paragraph("y", "AIが直した段落")])]);
    expect(repeatedNodeIds(result.merged.content)).toEqual([]);
    expect(result.report?.duplicateIds).toEqual(["y"]);
    expect(result.report?.mergedUnits).toEqual(["y"]);
    expect(result.report?.editBeatsDelete).toEqual([]);
    expect(result.resolvedConflicts).toBeUndefined();
  });

  it("keeps the human's move of a nested block between two blocks the AI edited it in", () => {
    // 人間が入れ子の段落 L を引用 X から Y へ移し、AIは X の中の L を直した。
    const base = withContent(baseDocument(), [
      quote("X", [paragraph("L", "移す段落"), paragraph("M", "残る段落")]),
      quote("Y", [paragraph("N", "移し先")]),
    ]);
    const mine = withContent(base, [
      quote("X", [paragraph("M", "残る段落")]),
      quote("Y", [paragraph("N", "移し先"), paragraph("L", "移す段落")]),
    ]);
    const theirs = withContent(base, [
      quote("X", [paragraph("L", "AIが直した段落"), paragraph("M", "残る段落")]),
      quote("Y", [paragraph("N", "移し先")]),
    ]);

    const result = mergeBoth(base, mine, theirs);

    expect(result.merged.content).toEqual([
      quote("X", [paragraph("M", "残る段落")]),
      quote("Y", [paragraph("N", "移し先"), paragraph("L", "AIが直した段落")]),
    ]);
    expect(repeatedNodeIds(result.merged.content)).toEqual([]);
    expect(result.report?.invalidAfterMerge).toBe(0);
    expect(result.report?.duplicateIds).toEqual(["L"]);
    expect(result.resolvedConflicts).toBeUndefined();
  });

  it("records the human's value as dropped when the moved block's attribute was also set by the AI", () => {
    // 人間が y を引用の中へ移して中央揃えにし、AIは元の場所の y を右揃えにした。
    const base = withContent(baseDocument(), [quote("q", [paragraph("x", "引用")]), paragraph("y", "移す段落")]);
    const mine = withContent(base, [quote("q", [paragraph("x", "引用"), { ...paragraph("y", "移す段落"), align: "center" }])]);
    const theirs = withContent(base, [quote("q", [paragraph("x", "引用")]), { ...paragraph("y", "移す段落"), align: "right" }]);

    const result = mergeBoth(base, mine, theirs);

    expect(result.merged.content).toEqual([
      quote("q", [paragraph("x", "引用"), { ...paragraph("y", "移す段落"), align: "right" }]),
    ]);
    expect(result.report?.droppedHumanEdits).toEqual(["#y.align"]);
    expect(result.resolvedConflicts).toHaveLength(1);
  });

  it("keeps the AI's place and merges both edits when both sides moved the same block", () => {
    const base = withContent(baseDocument(), [
      quote("q1", [paragraph("a", "引用1")]),
      quote("q2", [paragraph("b", "引用2")]),
      paragraph("y", "移す段落"),
    ]);
    const mine = withContent(base, [
      quote("q1", [paragraph("a", "引用1"), paragraph("y", "移す段落")]),
      quote("q2", [paragraph("b", "引用2")]),
    ]);
    const theirs = withContent(base, [
      quote("q1", [paragraph("a", "引用1")]),
      quote("q2", [paragraph("b", "引用2"), paragraph("y", "AIが直した段落")]),
    ]);

    const result = mergeBoth(base, mine, theirs);

    expect(result.merged.content).toEqual(theirs.content);
    expect(result.report?.overlaps).toEqual(["#y"]);
    expect(result.report?.droppedHumanEdits).toEqual(["#y"]);
    expect(result.resolvedConflicts).toHaveLength(1);
  });

  it("keeps the moved block as the human left it when the AI's edit of it cannot be merged in", () => {
    // 人間が引用 Qd を設問へ移して a を消し、AIは元の場所の Qd から b を消した。合成すると引用が
    // 空になる (引用は1ブロック以上が必要) ので、移した先の人間の Qd を残し、AIの編集は落ちる。
    const base = withContent(baseDocument(), [
      problem("prob", [], [paragraph("s1", "解答")]),
      quote("Qd", [paragraph("a", "引用1"), paragraph("b", "引用2")]),
    ]);
    const mine = withContent(base, [
      problem("prob", [quote("Qd", [paragraph("b", "引用2")]) as unknown as ParagraphNode], [paragraph("s1", "解答")]),
    ]);
    const theirs = withContent(base, [
      problem("prob", [], [paragraph("s1", "解答")]),
      quote("Qd", [paragraph("a", "引用1")]),
    ]);

    const result = mergeBoth(base, mine, theirs);

    expect(result.merged.content).toEqual(mine.content);
    expect(result.report?.duplicateIds).toEqual(["Qd"]);
    expect(result.report?.droppedAiEdits).toEqual(["#Qd"]);
    expect(result.report?.droppedHumanEdits).toEqual([]);
    expect(result.resolvedConflicts).toHaveLength(1);
  });

  it("adopts the AI's whole document only when the ids cannot be made unique", () => {
    // 人間が a を Y へ移し、AIは b を消した。合成した引用 Q は空で検証を通らず AI 側へ戻るが、
    // AI 側の Q は a を持つ。a を Q から外すと Q が空になるので、文書全体をAI側にする。
    const base = withContent(baseDocument(), [
      quote("Q", [paragraph("a", "移す段落"), paragraph("b", "消す段落")]),
      quote("Y", [paragraph("n", "移し先")]),
    ]);
    const mine = withContent(base, [
      quote("Q", [paragraph("b", "消す段落")]),
      quote("Y", [paragraph("n", "移し先"), paragraph("a", "移す段落")]),
    ]);
    const theirs = withContent(base, [
      quote("Q", [paragraph("a", "移す段落")]),
      quote("Y", [paragraph("n", "移し先")]),
    ]);

    const result = mergeBoth(base, mine, theirs);

    expect(result.merged).toBe(theirs);
    expect(result.report).toEqual({
      ...createEmptyDocumentMergeReport(),
      invalidAfterMerge: 1,
      droppedHumanEdits: ["$"],
    });
    expect(result.resolvedConflicts).toHaveLength(1);
  });

  it("keeps the human's reorder when the AI edited a block the human deleted", () => {
    const base = baseDocument();
    const mine = withContent(base, [paragraph("p3", "3番目の段落"), paragraph("p2", "2番目の段落")]);
    const theirs = replaceParagraphText(base, "p1", "AIが直した段落");

    const result = mergeBoth(base, mine, theirs);

    expect(result.merged.content.map((block) => block.id)).toEqual(["p1", "p3", "p2"]);
    expect(paragraphText(result.merged, "p1")).toBe("AIが直した段落");
  });

  it("keeps the AI's reorder when the human edited a block the AI deleted", () => {
    const base = baseDocument();
    const mine = replaceParagraphText(base, "p1", "人間が直した段落");
    const theirs = withContent(base, [paragraph("p3", "3番目の段落"), paragraph("p2", "2番目の段落")]);

    const result = mergeBoth(base, mine, theirs);

    expect(result.merged.content.map((block) => block.id)).toEqual(["p1", "p3", "p2"]);
    expect(paragraphText(result.merged, "p1")).toBe("人間が直した段落");
  });

  it("does not change its inputs", () => {
    const base = replaceParagraphText(baseDocument(), "p1", "段落の本文");
    const mine = replaceParagraphText(base, "p1", "段落の本文です");
    const theirs = replaceParagraphText(base, "p1", "新しい段落の本文");
    const snapshots = [structuredClone(base), structuredClone(mine), structuredClone(theirs)];

    mergeBoth(deepFreeze(base), deepFreeze(mine), deepFreeze(theirs));

    expect([base, mine, theirs]).toEqual(snapshots);
  });
});

function paragraphText(document: SigmaDocument, id: string): string | undefined {
  const block = document.content.find((candidate) => candidate.id === id);
  return block?.type === "paragraph"
    ? block.children.map((child) => (child.type === "text" ? child.text : "")).join("")
    : undefined;
}

/** 同じノードid (`id` と `type` を持つもの) が2回以上現れるもの。 */
function repeatedNodeIds(value: unknown): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  const visit = (current: unknown) => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (typeof current !== "object" || current === null) {
      return;
    }
    const record = current as Record<string, unknown>;
    if (typeof record.id === "string" && typeof record.type === "string") {
      (seen.has(record.id) ? repeated : seen).add(record.id);
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  return [...repeated];
}

function withContent(document: SigmaDocument, content: SigmaDocument["content"]): SigmaDocument {
  return { ...document, content };
}

function quote(id: string, blocks: ParagraphNode[]): QuoteBlockNode {
  return { type: "quote", id, blocks };
}

function problem(id: string, prompt: ParagraphNode[], solution: ParagraphNode[]): ProblemNode {
  return { type: "problem", id, tags: [], lead: [], prompt, solution, hints: [] };
}

function tableShape(id: string, rowIds: string[], cellTexts: Record<string, string>): OverlayTableShape {
  const cellRows: Record<string, string> = { c1: "r1", c2: "r2" };
  return {
    id,
    type: "tableShape",
    x: 0,
    y: 0,
    props: {
      w: 120,
      h: 60,
      table: {
        version: 1,
        kind: "plain",
        columns: [{ id: "col1", width: { mode: "fr", value: 1 } }],
        rows: rowIds.map((rowId) => ({ id: rowId, height: { mode: "auto" } })),
        cells: Object.entries(cellTexts).map(([cellId, text]) => ({
          id: cellId,
          rowId: cellRows[cellId]!,
          columnId: "col1",
          content: [{ id: `${cellId}_p`, type: "paragraph", children: [{ type: "text", text }] }],
        })),
        grid: {
          borderColor: "#111827",
          borderWidth: 1,
          borderStyle: "solid",
          showOuterBorder: true,
          showInnerBorders: true,
        },
        defaultCellStyle: {
          align: "center",
          verticalAlign: "middle",
          paddingX: 8,
          paddingY: 5,
          color: "#111827",
          fontSize: 15,
          fontWeight: "normal",
        },
      },
    },
  };
}

function imageShape(id: string, assetId: string): OverlayShape {
  return { id, type: "image", x: 0, y: 0, props: { w: 40, h: 40, assetId } } as OverlayShape;
}

function withAssets(document: SigmaDocument, assetIds: string[]): SigmaDocument {
  const overlaySnapshot = normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot);
  const assets = Object.fromEntries(assetIds.map((assetId) => [assetId, {
    id: assetId,
    type: "image",
    props: {
      name: `${assetId}.png`,
      src: `sigma-doc-storage://${assetId}.png`,
      w: 40,
      h: 40,
      mimeType: "image/png",
      isAnimated: false,
      fileSize: 100,
    },
  }]));
  return {
    ...document,
    pageLayout: {
      ...document.pageLayout!,
      overlay: {
        ...document.pageLayout?.overlay,
        overlaySnapshot: { ...overlaySnapshot, assets: { ...overlaySnapshot.assets, ...assets } } as OverlaySnapshot,
      },
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}
