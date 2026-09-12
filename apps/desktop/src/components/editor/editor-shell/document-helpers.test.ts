import { describe, expect, it } from "vitest";

import { createEmptyEditorDocument } from "@/lib/blank-document";
import { createBlock } from "@/lib/document-tree";
import type { DocumentMetadata } from "@/lib/runtime/types";

import type { SelectedOverlayChart } from "@/components/editor/EditorSettings";

import {
  areSelectedOverlayChartsEqual,
  getDefaultDocumentSelectionId,
  sameDocumentMetadatas,
} from "./document-helpers";

function metadata(overrides: Partial<DocumentMetadata> = {}): DocumentMetadata {
  return {
    fileId: "file_1",
    workspaceId: "ws_1",
    folderId: null,
    docId: "doc_1",
    title: "教材",
    revision: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("sameDocumentMetadatas", () => {
  it("treats a freshly read list with the same content as unchanged", () => {
    // 保存のたびに台帳を読み直すので配列は毎回新しい。ここで同じと言えないと、
    // 打鍵 1 回ごとに画面全体が再描画される。
    expect(sameDocumentMetadatas([metadata()], [metadata()])).toBe(true);
    expect(sameDocumentMetadatas([], [])).toBe(true);
  });

  it("sees a rename, a save, a move, and a list that grew or shrank", () => {
    expect(sameDocumentMetadatas([metadata()], [metadata({ title: "改題" })])).toBe(false);
    expect(sameDocumentMetadatas([metadata()], [metadata({ revision: 4 })])).toBe(false);
    expect(sameDocumentMetadatas([metadata()], [metadata({ updatedAt: "2026-02-02T00:00:00.000Z" })])).toBe(false);
    expect(sameDocumentMetadatas([metadata()], [metadata({ folderId: "folder_1" })])).toBe(false);
    expect(sameDocumentMetadatas([metadata()], [metadata(), metadata({ fileId: "file_2" })])).toBe(false);
    expect(sameDocumentMetadatas(
      [metadata(), metadata({ fileId: "file_2" })],
      [metadata({ fileId: "file_2" }), metadata()],
    )).toBe(false);
  });
});

describe("getDefaultDocumentSelectionId", () => {
  it("selects the first editable paragraph inside a problem instead of the container", () => {
    const problem = createBlock("problem");
    if (problem.type !== "problem") {
      throw new Error("problem fixture was not created");
    }
    problem.id = "problem_1";
    problem.prompt[0].id = "prompt_1";
    const document = {
      ...structuredClone(createEmptyEditorDocument()),
      docId: "doc_problem",
      content: [problem],
    };

    expect(getDefaultDocumentSelectionId(document)).toBe("prompt_1");
  });

  it("falls back to the first top-level block when the document has no text-format target", () => {
    const problem = createBlock("problem");
    if (problem.type !== "problem") {
      throw new Error("problem fixture was not created");
    }
    problem.id = "problem_1";
    problem.lead = [];
    problem.prompt = [];
    problem.solution = [];
    problem.hints = [];
    const document = {
      ...structuredClone(createEmptyEditorDocument()),
      docId: "doc_problem_without_text",
      content: [problem],
    };

    expect(getDefaultDocumentSelectionId(document)).toBe("problem_1");
  });
});

describe("areSelectedOverlayChartsEqual", () => {
  const base: SelectedOverlayChart = {
    shapeId: "chart-1",
    spec: {
      version: 1,
      kind: "bar",
      orientation: "columns",
      headerRow: true,
      labelColumn: true,
      legend: true,
      seriesColors: { c2: "#0083d5" },
    },
    data: { labels: ["a"], series: [{ id: "c2", name: "Math", values: [1] }] },
    linked: true,
    onSpecChange: () => {},
  };

  it("treats a structurally identical payload as equal", () => {
    // The canvas re-dispatches on every commit; without this the shell would setState each time
    // and the two would re-render one another without end.
    expect(areSelectedOverlayChartsEqual(base, structuredClone({ ...base, onSpecChange: undefined }) as never)).toBe(true);
  });

  it("ignores a fresh callback identity", () => {
    expect(areSelectedOverlayChartsEqual(base, { ...base, onSpecChange: () => {} })).toBe(true);
  });

  it("notices a changed chart kind", () => {
    expect(areSelectedOverlayChartsEqual(base, { ...base, spec: { ...base.spec, kind: "line" } })).toBe(false);
  });

  it("notices a changed series colour", () => {
    expect(areSelectedOverlayChartsEqual(base, { ...base, spec: { ...base.spec, seriesColors: { c2: "#ff0000" } } }))
      .toBe(false);
  });

  it("notices new data from the table", () => {
    expect(areSelectedOverlayChartsEqual(base, {
      ...base,
      data: { labels: ["a"], series: [{ id: "c2", name: "Math", values: [2] }] },
    })).toBe(false);
  });

  it("notices the reference breaking", () => {
    expect(areSelectedOverlayChartsEqual(base, { ...base, linked: false })).toBe(false);
  });

  it("notices a different chart", () => {
    expect(areSelectedOverlayChartsEqual(base, { ...base, shapeId: "chart-2" })).toBe(false);
  });

  it("treats null on one side as different", () => {
    expect(areSelectedOverlayChartsEqual(base, null)).toBe(false);
  });

  it("treats two nulls as equal", () => {
    expect(areSelectedOverlayChartsEqual(null, null)).toBe(true);
  });
});
