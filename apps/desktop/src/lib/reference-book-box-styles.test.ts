import { describe, expect, it } from "vitest";

import { boxFrameClassName, boxFrameStyleAttribute, createBoxBlock, isBoxTitleAtEnds, patchBoxFrame, resolveBoxFrame } from "@/lib/box-blocks";
import { createTranslator } from "@/lib/i18n";
import { SigmaBlockSchema } from "@/lib/sigma-doc-schema";

import { BOOK_MARKS_FONT_FAMILY, REFERENCE_BOOK_BOX_STYLES } from "./reference-book-box-styles";

describe("reference-book box styles", () => {
  it.each(REFERENCE_BOOK_BOX_STYLES.map((style) => [style.id] as const))("%s inserts a box the file schema accepts, with its styled default title", (styleId) => {
    const box = createBoxBlock(styleId);
    expect(SigmaBlockSchema.safeParse(box).success).toBe(true);
    expect(box.styleId).toBe(styleId);
    // 箱の設定の検証 (cssText に書ける値か) を通る。グラデーションの帯も落ちない。
    expect(boxFrameStyleAttribute(resolveBoxFrame(box))).toContain("--sigma-doc-box-border-color");
  });

  it("puts the difficulty marks last, in the marks font, so the band pushes them to the right end", () => {
    const box = createBoxBlock("chart-red-reidai");
    expect(box.subtitle).toEqual([expect.objectContaining({ text: "例題" })]);
    expect(box.title?.map((node) => node.type === "text" ? node.text : "")).toEqual(["1", " │ ", "見出し", "★★★", "☆☆"]);
    expect(box.title?.slice(-2).every((node) => node.fontFamily === BOOK_MARKS_FONT_FAMILY)).toBe(true);
    expect(boxFrameClassName("sigma-doc-box-block", resolveBoxFrame(box), box.styleId)).toContain("box-frame--title-ends");
  });

  it("uses the dictionary of the language the box is created in", () => {
    const box = createBoxBlock("chart-blue-kihon", "", {}, createTranslator("en", "editor"));
    expect(box.subtitle?.map((node) => node.type === "text" ? node.text : "").join("")).toBe("Basic Ex.");
    expect(box.title?.some((node) => node.type === "text" && node.text === "Heading")).toBe(true);
  });

  it("keeps a title the caller gives as plain text", () => {
    expect(createBoxBlock("focus-gold-reidai", "展開の工夫").title).toEqual([{ type: "text", text: "展開の工夫" }]);
  });
});

describe("title at both ends", () => {
  it("is the justify alignment without a chosen position, and a position turns it off", () => {
    expect(isBoxTitleAtEnds({ titleAlign: "justify" })).toBe(true);
    expect(isBoxTitleAtEnds({ titleAlign: "justify", titlePosition: "c" })).toBe(false);
    expect(isBoxTitleAtEnds({ titleAlign: "left" })).toBe(false);
    const box = createBoxBlock("titlebox");
    const atEnds = patchBoxFrame(box, { titlePosition: undefined, titleAlign: "justify" });
    expect(boxFrameClassName("sigma-doc-box-block", resolveBoxFrame(atEnds), atEnds.styleId)).toContain("box-frame--title-ends");
    const left = patchBoxFrame(atEnds, { titlePosition: "l" });
    expect(boxFrameClassName("sigma-doc-box-block", resolveBoxFrame(left), left.styleId)).not.toContain("box-frame--title-ends");
  });
});
