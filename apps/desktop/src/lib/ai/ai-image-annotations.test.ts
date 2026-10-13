import { describe, expect, it } from "vitest";
import { createTranslator } from "@/lib/i18n";
import { getAttachmentDefaultInstruction } from "./ai-edit-runtime";
import {
  createAiImageAnnotationShape,
  formatAiImageAnnotationsForPrompt,
  getAiImageAnnotationMarkLayout,
  MAX_AI_IMAGE_ANNOTATION_COMMENT_LENGTH,
  MAX_AI_IMAGE_ANNOTATIONS,
  normalizeAiImageAnnotations,
} from "./ai-image-annotations";

describe("normalizeAiImageAnnotations", () => {
  it("keeps points and regions inside the image and drops empty or broken entries", () => {
    expect(normalizeAiImageAnnotations([
      { id: "a", x: 1.4, y: -0.2, comment: "  右上の式  " },
      { id: "b", x: 0.8, y: 0.5, width: 0.5, height: 0.2, comment: "この表" },
      { id: "c", x: 0.2, y: 0.2, comment: "   " },
      { id: "d", x: Number.NaN, y: 0.2, comment: "壊れた座標" },
      "not an annotation",
      null,
    ])).toEqual([
      { id: "a", x: 1, y: 0, comment: "右上の式" },
      // 範囲は画像の右端で切る。
      { id: "b", x: 0.8, y: 0.5, width: expect.closeTo(0.2, 10), height: 0.2, comment: "この表" },
    ]);
  });

  it("treats a region too small to see as a point", () => {
    expect(normalizeAiImageAnnotations([{ id: "a", x: 0.3, y: 0.3, width: 0.001, height: 0.4, comment: "x" }]))
      .toEqual([{ id: "a", x: 0.3, y: 0.3, comment: "x" }]);
  });

  it("caps the count and the comment length, and repairs duplicate ids", () => {
    const many = Array.from({ length: MAX_AI_IMAGE_ANNOTATIONS + 3 }, (_, index) => ({
      id: "same",
      x: 0.1,
      y: 0.1,
      comment: index === 0 ? "あ".repeat(MAX_AI_IMAGE_ANNOTATION_COMMENT_LENGTH + 20) : `c${index}`,
    }));
    const normalized = normalizeAiImageAnnotations(many);
    expect(normalized).toHaveLength(MAX_AI_IMAGE_ANNOTATIONS);
    expect(normalized[0]?.comment).toHaveLength(MAX_AI_IMAGE_ANNOTATION_COMMENT_LENGTH);
    expect(new Set(normalized.map((annotation) => annotation.id)).size).toBe(MAX_AI_IMAGE_ANNOTATIONS);
  });

  it("returns an empty list for history entries written before annotations existed", () => {
    expect(normalizeAiImageAnnotations(undefined)).toEqual([]);
    expect(normalizeAiImageAnnotations({})).toEqual([]);
  });
});

describe("createAiImageAnnotationShape", () => {
  it("turns a drag in any direction into a top-left based region", () => {
    expect(createAiImageAnnotationShape({ x: 0.6, y: 0.7 }, { x: 0.2, y: 0.3 }))
      .toEqual({ x: 0.2, y: 0.3, width: expect.closeTo(0.4, 10), height: expect.closeTo(0.4, 10) });
  });

  it("keeps a click (or a tiny wobble) as a point at the start", () => {
    expect(createAiImageAnnotationShape({ x: 0.5, y: 0.5 }, { x: 0.505, y: 0.5 })).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe("getAiImageAnnotationMarkLayout", () => {
  it("puts the number up and to the right of a point so the point itself stays visible", () => {
    const layout = getAiImageAnnotationMarkLayout({ id: "a", x: 0.5, y: 0.5, comment: "x" }, { width: 200, height: 100 }, 10);
    expect(layout.point).toEqual({ x: 100, y: 50 });
    // 点は中を塗らない輪で囲み、番号の丸は輪の外 (右上) に添える。
    expect(layout.ringRadius).toBeGreaterThan(0);
    expect(layout.badgeCenter.x).toBeGreaterThan(100 + 10);
    expect(layout.badgeCenter.y).toBeLessThan(50 - 10);
    const gap = Math.hypot(layout.badgeCenter.x - 100, layout.badgeCenter.y - 50) - layout.badgeRadius;
    expect(gap).toBeGreaterThan(layout.ringRadius * 0.5);
  });

  it("pulls the number back inside the image at the edges", () => {
    const layout = getAiImageAnnotationMarkLayout({ id: "a", x: 1, y: 0, comment: "x" }, { width: 200, height: 100 }, 10);
    expect(layout.badgeCenter).toEqual({ x: 190, y: 10 });
    const region = getAiImageAnnotationMarkLayout(
      { id: "b", x: 0, y: 0, width: 0.5, height: 0.5, comment: "x" },
      { width: 200, height: 100 },
      10,
    );
    expect(region.rect).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(region.badgeCenter.y).toBe(10);
  });
});

describe("formatAiImageAnnotationsForPrompt", () => {
  const attachments = [
    { name: "plain.png" },
    {
      name: "worksheet.png",
      annotations: [
        { id: "a", x: 0.123, y: 0.456, comment: "ここの符号が\n逆" },
        { id: "b", x: 0.1, y: 0.2, width: 0.3, height: 0.25, comment: "この表を消して" },
      ],
    },
  ];

  it("lists each numbered mark with its shape, position, and comment", () => {
    const text = formatAiImageAnnotationsForPrompt(attachments, createTranslator("ja", "prompt"));
    expect(text).toContain("画像「worksheet.png」へのコメント:");
    expect(text).toContain("1. 点（左から12%、上から46%）: ここの符号が / 逆");
    expect(text).toContain("2. 範囲（横10〜40%、縦20〜45%）: この表を消して");
    expect(text).not.toContain("plain.png");
    // 描き込んだ印を教材へ写さないことも伝える。
    expect(text).toContain("教材へ写したり再現したりしないでください");
  });

  it("is written in the prompt language", () => {
    const text = formatAiImageAnnotationsForPrompt(attachments, createTranslator("en", "prompt"));
    expect(text).toContain("Comments on the image \"worksheet.png\":");
    expect(text).toContain("1. Point (12% from the left, 46% from the top): ここの符号が / 逆");
  });

  it("adds nothing when no image has comments", () => {
    expect(formatAiImageAnnotationsForPrompt([{ name: "a.png", annotations: [] }], createTranslator("ja", "prompt"))).toBe("");
  });
});

describe("getAttachmentDefaultInstruction with annotations", () => {
  it("asks the AI to follow the comments instead of rebuilding the image as material", () => {
    const t = createTranslator("ja", "prompt");
    expect(getAttachmentDefaultInstruction([
      { mimeType: "image/png", dataUrl: "data:image/png;base64,AA", annotations: [{ id: "a" }] },
    ], t)).toBe(t("runtime.imageAnnotationDefaultInstruction"));
    expect(getAttachmentDefaultInstruction([
      { mimeType: "image/png", dataUrl: "data:image/png;base64,AA" },
    ], t)).toBe(t("runtime.imageToSigmaDocDefaultInstruction"));
  });
});
