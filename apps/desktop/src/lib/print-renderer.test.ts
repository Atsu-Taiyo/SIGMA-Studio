import { describe, expect, it } from "vitest";

import { WHITEBOARD_BASE_CELL_PX } from "@/features/document";
import { createTranslator } from "@/lib/i18n";
import { ensurePageLayout, getDefaultPageLayout, MM_TO_PX } from "@/lib/page-layout";
import { getPrintableDocument, WHITEBOARD_PRINT_PADDING_PX } from "@/lib/print-renderer";
import type { SigmaDocument } from "@/types/sigma-doc";

const profileFilteringDocument: SigmaDocument = {
  version: "2.0",
  docId: "doc_print_profile_fixture",
  metadata: {
    title: "印刷プロファイル検証",
  },
  content: [
    {
      type: "problem",
      id: "problem_print_profile",
      tags: ["print"],
      lead: [],
      prompt: [
        {
          type: "paragraph",
          id: "p_print_prompt",
          children: [{ type: "text", text: "次の方程式を解け。" }],
        },
      ],
      answer: {
        type: "math",
        expected: "x=2,3",
      },
      solution: [
        {
          type: "paragraph",
          id: "p_print_solution",
          children: [{ type: "text", text: "因数分解して求める。" }],
        },
      ],
      hints: [
        {
          type: "paragraph",
          id: "p_print_hint",
          children: [{ type: "text", text: "積が 0 になる条件を使う。" }],
        },
      ],
    },
  ],
  outputProfiles: {
    student: { showSolutions: false, showHints: false, includeAnswers: false },
    teacher: { showSolutions: true, showHints: true, includeAnswers: true },
    answerBook: { onlySolutions: true, showSolutions: true, showHints: false, includeAnswers: true },
  },
};

describe("print renderer profile filtering", () => {
  it("filters answers inside nested boxes and includes their solutions in the answer book", () => {
    const document: SigmaDocument = { ...profileFilteringDocument, content: [
      { type: "boxBlock", id: "outer", styleId: "itembox", blocks: [
        { type: "boxBlock", id: "inner", styleId: "itembox", blocks: profileFilteringDocument.content },
      ] },
    ] };
    const student = getPrintableDocument(document, "student");
    expect(JSON.stringify(student.content)).toContain("次の方程式を解け。");
    expect(JSON.stringify(student.content)).not.toContain("因数分解して求める。");
    expect(JSON.stringify(student.content)).not.toContain("x=2,3");
    const answers = getPrintableDocument(document, "answerBook");
    expect(JSON.stringify(answers.content)).toContain("因数分解して求める。");
    expect(JSON.stringify(answers.content)).toContain("x=2,3");
    expect(JSON.stringify(document.content)).toContain("因数分解して求める。");
  });

  it("hides answers, solutions, and hints for student profile", () => {
    const printable = getPrintableDocument(profileFilteringDocument, "student");
    const problem = printable.content.find((block) => block.type === "problem");

    expect(problem?.type).toBe("problem");
    if (problem?.type === "problem") {
      expect(problem.answer).toBeUndefined();
      expect(problem.solution).toEqual([]);
      expect(problem.hints).toEqual([]);
    }
  });

  it("applies the default page layout to printable documents", () => {
    const printable = getPrintableDocument(profileFilteringDocument, "student");

    expect(printable.pageLayout?.pageSize).toEqual({ widthMm: 210, heightMm: 297 });
    expect(printable.pageLayout?.marginsMm).toEqual({ top: 18, right: 17, bottom: 18, left: 17 });
    expect(printable.pageLayout?.flow).toEqual({ type: "columns", columnCount: 1, columnGapMm: 8 });
  });

  it("preserves document page size, margins, and columns while filtering content", () => {
    const document = ensurePageLayout({
      ...profileFilteringDocument,
      pageLayout: {
        preset: "B5",
        orientation: "landscape",
        pageSize: { widthMm: 257, heightMm: 182 },
        marginsMm: { top: 24, right: 12, bottom: 20, left: 14 },
        flow: { type: "columns", columnCount: 2, columnGapMm: 6 },
      },
    });

    const printable = getPrintableDocument(document, "student");

    expect(printable.pageLayout?.pageSize).toEqual({ widthMm: 257, heightMm: 182 });
    expect(printable.pageLayout?.marginsMm).toEqual({ top: 24, right: 12, bottom: 20, left: 14 });
    expect(printable.pageLayout?.flow).toEqual({ type: "columns", columnCount: 2, columnGapMm: 6 });
  });

  it("builds an answer-only document for answerBook profile", () => {
    const printable = getPrintableDocument(profileFilteringDocument, "answerBook");
    const secondPrintable = getPrintableDocument(profileFilteringDocument, "answerBook");

    expect(printable.metadata.title).toContain("解答冊子");
    expect(printable.content.every((block) => block.type !== "problem")).toBe(true);
    expect(printable.content.map((block) => block.id)).toEqual(secondPrintable.content.map((block) => block.id));
    expect(
      printable.content.some(
        (block) =>
          block.type === "paragraph" &&
          block.children.some((child) => child.type === "mathInline" && child.tex === "x=2,3"),
      ),
    ).toBe(true);
  });

  it("bakes answer-book labels in the requested language without changing the source", () => {
    const source = structuredClone(profileFilteringDocument);
    const printable = getPrintableDocument(source, "answerBook", createTranslator("en", "print"));

    expect(printable.metadata.title).toBe("印刷プロファイル検証 Answer Book");
    expect(printable.content[0]).toMatchObject({
      type: "heading",
      children: [{ type: "text", text: "Answers" }],
    });
    expect(printable.content[1]).toMatchObject({
      type: "heading",
      children: [{ type: "text", text: "Problem 1" }],
    });
    expect(source).toEqual(profileFilteringDocument);
  });

  it("never appends comments when a stored output profile includes comments", () => {
    const document: SigmaDocument = {
      ...profileFilteringDocument,
      outputProfiles: {
        ...profileFilteringDocument.outputProfiles,
        teacher: {
          ...profileFilteringDocument.outputProfiles.teacher,
          includeComments: true,
        },
      },
      comments: [
        {
          id: "thread_unresolved",
          anchor: { type: "block", blockId: "p_print_prompt", quote: "次の方程式を解け。" },
          messages: [
            {
              id: "message_unresolved",
              body: [{ type: "text", text: "ここに補足を入れる。" }],
              createdAt: "2026-06-16T00:00:00.000Z",
            },
          ],
          createdAt: "2026-06-16T00:00:00.000Z",
        },
        {
          id: "thread_resolved",
          anchor: { type: "block", blockId: "p_print_solution" },
          resolved: true,
          messages: [
            {
              id: "message_resolved",
              body: [{ type: "text", text: "解決済み。" }],
              createdAt: "2026-06-16T00:00:00.000Z",
            },
          ],
          createdAt: "2026-06-16T00:00:00.000Z",
        },
      ],
    };

    const teacher = getPrintableDocument(document, "teacher");

    expect(teacher.content.some((block) => block.id === "comments_appendix_heading")).toBe(false);
    expect(JSON.stringify(teacher.content)).not.toContain("ここに補足を入れる。");
    expect(JSON.stringify(teacher.content)).not.toContain("解決済み。");
  });

  it("preserves the page overlay while filtering printable content", () => {
    const document = ensurePageLayout(profileFilteringDocument);
    document.pageLayout!.overlay = {
      overlaySnapshot: {
        version: 1,
        assets: {},
        shapes: [
          {
            id: "shape_overlay_kept",
            type: "arc",
            x: 0,
            y: 0,
            props: { r: 60, startAngle: 0, endAngle: Math.PI, color: "black", dash: "solid", size: "m" },
          },
        ],
      },
      updatedAt: "2026-05-14T00:00:00.000Z",
    };

    const printable = getPrintableDocument(document, "student");

    expect(printable.pageLayout?.overlay?.overlaySnapshot?.shapes).toHaveLength(1);
  });

  it("filters block-anchored overlay shapes with the printable profile", () => {
    const document = ensurePageLayout(profileFilteringDocument);
    document.pageLayout!.overlay = {
      overlaySnapshot: {
        version: 1,
        assets: {},
        shapes: [
          overlayRectangle("shape_prompt", "p_print_prompt"),
          overlayRectangle("shape_solution", "p_print_solution"),
          overlayShapeAnchoredRectangle("shape_solution_label", "shape_solution"),
          overlayRectangle("shape_page"),
        ],
      },
    };

    const student = getPrintableDocument(document, "student");
    const answerBook = getPrintableDocument(document, "answerBook");

    expect(student.pageLayout?.overlay?.overlaySnapshot?.shapes.map((shape) => shape.id)).toEqual([
      "shape_prompt",
      "shape_page",
    ]);
    expect(answerBook.pageLayout?.overlay?.overlaySnapshot?.shapes.map((shape) => shape.id)).toEqual([
      "shape_solution",
      "shape_solution_label",
      "shape_page",
    ]);
  });
});

describe("whiteboard print background", () => {
  function whiteboardWithBackground(background: "grid" | "dots" | "none"): SigmaDocument {
    return {
      ...profileFilteringDocument,
      content: [],
      pageLayout: {
        ...getDefaultPageLayout("whiteboard"),
        background,
        overlay: {
          overlaySnapshot: {
            version: 1,
            assets: {},
            shapes: [
              {
                ...overlayRectangle("visible"),
                x: -50,
                y: 100,
                anchor: undefined,
                props: { ...overlayRectangle("visible").props, w: 200, h: 80 },
              },
            ],
          },
        },
      },
    };
  }

  /** ワールド上のセル境界からの位相。紙面でこれが変わるとグリッドと図形がずれる。 */
  function cellPhase(value: number): number {
    return ((value % WHITEBOARD_BASE_CELL_PX) + WHITEBOARD_BASE_CELL_PX) % WHITEBOARD_BASE_CELL_PX;
  }

  function croppedShape(document: SigmaDocument) {
    const printable = getPrintableDocument(document, "teacher");
    const shape = printable.pageLayout?.overlay?.overlaySnapshot?.shapes
      .find((candidate) => candidate.id === "visible");
    return { printable, shape };
  }

  it("carries the chosen ground onto the cropped sheet", () => {
    const { printable } = croppedShape(whiteboardWithBackground("grid"));

    expect(printable.pageLayout?.preset).toBe("custom");
    expect(printable.pageLayout?.background).toBe("grid");
  });

  it("keeps an explicit 'none' instead of letting it fall back to the default", () => {
    expect(croppedShape(whiteboardWithBackground("none")).printable.pageLayout?.background).toBe("none");
  });

  it("carries the ground onto the empty-whiteboard fallback sheet too", () => {
    const printable = getPrintableDocument({
      ...profileFilteringDocument,
      content: [],
      pageLayout: { ...getDefaultPageLayout("whiteboard"), background: "grid" },
    }, "teacher");

    expect(printable.pageLayout?.background).toBe("grid");
    expect(printable.pageLayout?.pageSize).toMatchObject({ widthMm: 210, heightMm: 297 });
  });

  it("snaps the crop origin to the cell grid so the paper phase matches the screen", () => {
    for (const background of ["grid", "dots"] as const) {
      const { shape } = croppedShape(whiteboardWithBackground(background));

      expect(shape, background).toBeDefined();
      // 原点がセルの倍数なら、図形のセル境界からの位相はワールドと紙面で変わらない。
      expect(cellPhase(shape!.x), background).toBe(cellPhase(-50));
      expect(cellPhase(shape!.y), background).toBe(cellPhase(100));
    }
  });

  it("keeps the snapped margin within one cell of the requested padding", () => {
    const { shape } = croppedShape(whiteboardWithBackground("dots"));

    expect(shape!.x).toBeGreaterThanOrEqual(WHITEBOARD_PRINT_PADDING_PX);
    expect(shape!.x).toBeLessThan(WHITEBOARD_PRINT_PADDING_PX + WHITEBOARD_BASE_CELL_PX);
    expect(shape!.y).toBeGreaterThanOrEqual(WHITEBOARD_PRINT_PADDING_PX);
    expect(shape!.y).toBeLessThan(WHITEBOARD_PRINT_PADDING_PX + WHITEBOARD_BASE_CELL_PX);
  });

  it("still leaves the requested padding on the far edges after snapping", () => {
    const { printable, shape } = croppedShape(whiteboardWithBackground("grid"));
    const widthPx = (printable.pageLayout?.pageSize.widthMm ?? 0) * MM_TO_PX;
    const heightPx = (printable.pageLayout?.pageSize.heightMm ?? 0) * MM_TO_PX;

    // 原点を左上へ寄せたぶん紙も広がる。右下の余白が 40px を割ると図形が切れる。
    expect(widthPx - (shape!.x + 200)).toBeGreaterThanOrEqual(WHITEBOARD_PRINT_PADDING_PX - 0.001);
    expect(heightPx - (shape!.y + 80)).toBeGreaterThanOrEqual(WHITEBOARD_PRINT_PADDING_PX - 0.001);
  });

  it("leaves the crop origin alone when there is no pattern to line up with", () => {
    const { shape } = croppedShape(whiteboardWithBackground("none"));

    expect(shape).toMatchObject({ x: WHITEBOARD_PRINT_PADDING_PX, y: WHITEBOARD_PRINT_PADDING_PX });
  });
});

function overlayRectangle(id: string, blockId?: string) {
  return {
    id,
    type: "geo" as const,
    x: 10,
    y: 20,
    rotation: 0,
    anchor: blockId ? { type: "block" as const, blockId, dy: 20 } : { type: "page" as const },
    props: {
      w: 80,
      h: 40,
      geo: "rectangle" as const,
      fill: "none" as const,
      color: "#0d0d0d",
      labelColor: "#0d0d0d",
      dash: "solid" as const,
      size: "s" as const,
    },
  };
}

function overlayShapeAnchoredRectangle(id: string, shapeId: string) {
  return {
    ...overlayRectangle(id),
    anchor: { type: "shape" as const, shapeId, dx: 8, dy: 8 },
  };
}

describe("whiteboard print crop", () => {
  it("creates one custom sheet around every visible shape with padding", () => {
    const document: SigmaDocument = {
      ...profileFilteringDocument,
      content: [],
      pageLayout: {
        ...getDefaultPageLayout("whiteboard"),
        // 余白がちょうど 40px になるのは下地が無いときだけ。方眼/点では位相合わせのために
        // 切り出し原点をセル境界へ寄せるので、余白は 40〜63px に振れる (別テストで固定)。
        background: "none",
        overlay: {
          overlaySnapshot: {
            version: 1,
            assets: {},
            shapes: [
              { ...overlayRectangle("visible"), x: -50, y: 100, anchor: undefined, props: { ...overlayRectangle("visible").props, w: 200, h: 80 } },
              { ...overlayRectangle("hidden"), x: 5000, y: 5000, anchor: undefined, hidden: true },
            ],
          },
        },
      },
    };

    const printable = getPrintableDocument(document, "teacher");
    const visible = printable.pageLayout?.overlay?.overlaySnapshot?.shapes.find((shape) => shape.id === "visible");

    expect(printable.content).toEqual([]);
    expect(printable.pageLayout?.preset).toBe("custom");
    expect(printable.pageLayout?.pageSize.widthMm).toBeCloseTo((200 + WHITEBOARD_PRINT_PADDING_PX * 2) / MM_TO_PX);
    expect(printable.pageLayout?.pageSize.heightMm).toBeCloseTo((80 + WHITEBOARD_PRINT_PADDING_PX * 2) / MM_TO_PX);
    expect(visible).toMatchObject({ x: WHITEBOARD_PRINT_PADDING_PX, y: WHITEBOARD_PRINT_PADDING_PX });
  });

  it("uses a small stable paper fallback for an empty whiteboard", () => {
    const document: SigmaDocument = {
      ...profileFilteringDocument,
      content: [],
      pageLayout: getDefaultPageLayout("whiteboard"),
    };

    expect(getPrintableDocument(document, "teacher").pageLayout).toMatchObject({
      preset: "custom",
      pageSize: { widthMm: 210, heightMm: 297 },
    });
  });
});
