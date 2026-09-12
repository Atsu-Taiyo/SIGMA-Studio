import { describe, expect, it } from "vitest";

import { searchSigmaDocLibrary, type LibrarySearchDocumentInput } from "@/lib/ai/sigma-doc-library-search";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import type { ProblemAreaBlock, RichBlock, SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

describe("searchSigmaDocLibrary", () => {
  it("returns no matches for an empty or blank query", () => {
    const documents = [libraryDoc("file_1", "教材A", [paragraph("p_1", "本文")])];

    expect(searchSigmaDocLibrary(documents, "")).toEqual({ documents: [], totalMatchingDocuments: 0 });
    expect(searchSigmaDocLibrary(documents, "   ")).toEqual({ documents: [], totalMatchingDocuments: 0 });
  });

  it("matches a Japanese query against a paragraph", () => {
    const documents = [
      libraryDoc("file_1", "二次関数", [paragraph("p_1", "二次方程式の解の公式を学びます。")]),
      libraryDoc("file_2", "図形", [paragraph("p_2", "三角形の合同条件について。")]),
    ];

    const result = searchSigmaDocLibrary(documents, "解の公式");

    expect(result.totalMatchingDocuments).toBe(1);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].fileId).toBe("file_1");
    expect(result.documents[0].matches[0]).toMatchObject({ blockId: "p_1", field: "text" });
    expect(result.documents[0].matches[0].excerpt).toContain("解の公式");
  });

  it("matches a math-tex query against a mathInline node", () => {
    const documents = [
      libraryDoc("file_1", "式変形", [
        {
          type: "paragraph",
          id: "p_1",
          children: [
            { type: "text", text: "式は " },
            { type: "mathInline", id: "m_1", tex: "x^2 + 2x + 1", display: "inline" },
            { type: "text", text: " である。" },
          ],
        },
      ]),
    ];

    const result = searchSigmaDocLibrary(documents, "x^2");

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].matches[0]).toMatchObject({ blockId: "p_1", field: "tex" });
  });

  it("scope:problems returns problem-shaped hits with a fuller excerpt including prompt and tags", () => {
    const documents = [
      libraryDoc("file_1", "教材A", [
        createProblem("problem_1", {
          tags: ["二次関数", "応用"],
          prompt: [richParagraph("prompt_1", "放物線 y = x^2 + 1 の頂点の座標を求めよ。".repeat(1))],
        }),
      ]),
    ];

    const result = searchSigmaDocLibrary(documents, "頂点", { scope: "problems" });

    expect(result.documents).toHaveLength(1);
    const [match] = result.documents[0].matches;
    expect(match.blockType).toBe("problem");
    expect(match.blockId).toBe("problem_1");
    expect(match.areaPath).toBe("problem_1");
    expect(match.excerpt).toContain("放物線");
    expect(match.excerpt).toContain("二次関数");
    expect(match.excerpt).toContain("応用");
  });

  it("scope:problems matches text inside solution layout sections", () => {
    const documents = [
      libraryDoc("file_1", "教材A", [
        createProblem("problem_1", {
          solution: [
            {
              type: "layoutSection",
              id: "solution_columns",
              layout: { columnCount: 2 },
              children: [richParagraph("solution_p", "相加相乗平均を使って最小値を求める。")],
            },
          ],
        }),
      ]),
    ];

    const result = searchSigmaDocLibrary(documents, "相加相乗", { scope: "problems" });

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].matches[0]).toMatchObject({ blockId: "problem_1", blockType: "problem" });
  });

  it("ranks a document matching all terms above one matching only one term", () => {
    const documents = [
      libraryDoc("file_both", "両方ヒット", [paragraph("p_1", "二次関数と放物線の頂点について説明する。")]),
      libraryDoc("file_one", "片方ヒット", [paragraph("p_2", "二次関数の基本を学ぶ。")]),
    ];

    const result = searchSigmaDocLibrary(documents, "二次関数 放物線");

    expect(result.documents.map((doc) => doc.fileId)).toEqual(["file_both", "file_one"]);
  });

  it("ranks a title hit above a body-only hit of equal term count", () => {
    const documents = [
      libraryDoc("file_body", "無関係なタイトル", [paragraph("p_1", "二次関数の解説です。")]),
      libraryDoc("file_title", "二次関数の教材", [paragraph("p_2", "別の内容です。")]),
    ];

    const result = searchSigmaDocLibrary(documents, "二次関数");

    expect(result.documents.map((doc) => doc.fileId)).toEqual(["file_title", "file_body"]);
  });

  it("caps the number of returned documents at `limit` while reporting totalMatchingDocuments", () => {
    const documents = Array.from({ length: 12 }, (_, index) =>
      libraryDoc(`file_${index}`, `教材${index}`, [paragraph(`p_${index}`, "検索対象の本文です。")]),
    );

    const result = searchSigmaDocLibrary(documents, "検索対象", { limit: 3 });

    expect(result.documents).toHaveLength(3);
    expect(result.totalMatchingDocuments).toBe(12);
  });

  it("flags isCurrentFile when currentFileId matches a result", () => {
    const documents = [
      libraryDoc("file_1", "教材A", [paragraph("p_1", "検索対象の本文です。")]),
      libraryDoc("file_2", "教材B", [paragraph("p_2", "検索対象の本文です。")]),
    ];

    const result = searchSigmaDocLibrary(documents, "検索対象", { currentFileId: "file_2" });

    const current = result.documents.find((doc) => doc.fileId === "file_2");
    const other = result.documents.find((doc) => doc.fileId === "file_1");
    expect(current?.isCurrentFile).toBe(true);
    expect(other?.isCurrentFile).toBe(false);
  });
});

function paragraph(id: string, text: string): SigmaBlock {
  return {
    type: "paragraph",
    id,
    children: [{ type: "text", text }],
  };
}

function richParagraph(id: string, text: string): RichBlock {
  return {
    type: "paragraph",
    id,
    children: [{ type: "text", text }],
  };
}

function createProblem(
  id: string,
  overrides: { tags?: string[]; prompt?: ProblemAreaBlock[]; solution?: ProblemAreaBlock[] } = {},
): SigmaBlock {
  return {
    type: "problem",
    id,
    tags: overrides.tags ?? [],
    lead: [],
    prompt: overrides.prompt ?? [richParagraph(`${id}_prompt`, "問題文")],
    solution: overrides.solution ?? [],
    hints: [],
  };
}

function createDocument(title: string, content: SigmaBlock[]): SigmaDocument {
  return parseSigmaDocument({
    version: "2.0",
    docId: `doc_${title}`,
    metadata: { title },
    content,
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
  });
}

function libraryDoc(fileId: string, title: string, content: SigmaBlock[]): LibrarySearchDocumentInput {
  return {
    fileId,
    title,
    updatedAt: "2026-01-01T00:00:00.000Z",
    document: createDocument(title, content),
  };
}
