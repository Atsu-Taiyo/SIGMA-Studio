import { describe, expect, it } from "vitest";

import {
  BUILTIN_BOX_STYLES,
  boxBlockSubtitleText,
  boxBlockTitleText,
  boxFrameHasSubtitle,
  boxFrameAppliesFontFamily,
  boxFrameClassName,
  boxFrameDecorationAttributes,
  boxFrameStyleAttribute,
  boxFrameStyleVars,
  cornerBoxFoldSizePx,
  cornerBoxReferenceHeightStyleVars,
  createBoxBlock,
  patchBoxFrame,
  resolveBoxFrame,
  setBoxStyle,
  setBoxTitle,
} from "@/lib/box-blocks";
import type { BoxBlockNode, BoxFrameSpec } from "@/features/document";

describe("cornerbox frame", () => {
  it("uses default editor text size unless the user customizes it", () => {
    const created = createBoxBlock("cornerbox");

    expect(created.frame).not.toHaveProperty("titleFontSizePx");
    expect(created.frame).not.toHaveProperty("bodyFontSizePx");
    expect(created.frame).toMatchObject({
      titleAlign: "left",
      bodyAlign: "left",
      paddingPx: { top: 24, right: 24, bottom: 24, left: 24 },
    });
    const defaultSizedFrame = resolveBoxFrame({
      styleId: "cornerbox",
      frame: {
        titleFontSizePx: 32,
        bodyFontSizePx: 21,
      },
    });
    expect(defaultSizedFrame).not.toHaveProperty("titleFontSizePx");
    expect(defaultSizedFrame).not.toHaveProperty("bodyFontSizePx");
    expect(resolveBoxFrame({
      styleId: "cornerbox",
      frame: {
        titleFontSizePx: 18,
        bodyFontSizePx: 14,
      },
    })).toMatchObject({
      titleFontSizePx: 18,
      bodyFontSizePx: 14,
    });
  });

  it("scales the fold size from the rendered reference height", () => {
    expect(cornerBoxFoldSizePx(20)).toBe(9);
    expect(cornerBoxFoldSizePx(80)).toBe(12);
    expect(cornerBoxFoldSizePx(160)).toBe(18);
    expect(cornerBoxReferenceHeightStyleVars(80)).toMatchObject({
      "--corner-frame-reference-height": "80px",
      "--corner-frame-fold-size": "12px",
      "--corner-frame-corner-size": "7.2px",
      "--corner-frame-guide-inset-x": "12px",
      "--corner-frame-rule-y": "7.44px",
      "--corner-frame-corner-y": "2.04px",
    });
  });
});

describe("box frame render metadata", () => {
  it("maps box decorations to shared render classes and stable debug attributes", () => {
    const doublebox = createBoxBlock("doublebox");
    const itembox = createBoxBlock("itembox");
    const notebook = createBoxBlock("tcolorbox-note");
    const cornerbox = createBoxBlock("cornerbox");

    expect(boxFrameClassName("sigma-doc-box-block", resolveBoxFrame(doublebox), doublebox.styleId)).toContain("box-frame--double-rule");
    expect(boxFrameClassName("sigma-doc-box-block", resolveBoxFrame(itembox), itembox.styleId)).toContain("box-frame--title-plate");
    expect(boxFrameClassName("sigma-doc-box-block", resolveBoxFrame(notebook), notebook.styleId)).toContain("box-frame--notebook-rules");
    expect(boxFrameClassName("sigma-doc-box-block", resolveBoxFrame(cornerbox), cornerbox.styleId)).toContain("box-frame--corner");
    expect(boxFrameDecorationAttributes(resolveBoxFrame(notebook))).toMatchObject({
      "data-box-notebook-rules": "true",
    });
    expect(boxFrameStyleVars(resolveBoxFrame(notebook))).toMatchObject({
      "--sigma-doc-box-notebook-base-body-width": "660px",
      "--sigma-doc-box-notebook-frame-left": "20px",
      "--sigma-doc-box-notebook-frame-height": "57.35px",
      "--sigma-doc-box-notebook-frame-border-color": "rgb(156 163 175 / 0.85)",
      "--sigma-doc-box-notebook-binding-color": "rgb(185 179 161 / 0.75)",
      "--sigma-doc-box-notebook-ring-width": "38px",
      "--sigma-doc-box-notebook-ring-height": "12px",
      "--sigma-doc-box-notebook-ring-gap": "23.35px",
      "--sigma-doc-box-notebook-ring-count": "1",
    });
    expect(boxFrameStyleVars(resolveBoxFrame(notebook))).not.toHaveProperty("--sigma-doc-box-notebook-line-gap");
    expect(boxFrameStyleAttribute(resolveBoxFrame(doublebox))).toContain("--sigma-doc-box-double-offset:4px");
  });

  it("exports TeX title positions while mapping them to valid CSS alignment values", () => {
    expect(boxFrameStyleVars({ titlePosition: "c" })).toMatchObject({
      "--sigma-doc-box-title-position": "c",
      "--sigma-doc-box-title-align": "center",
    });
    expect(boxFrameClassName("print-box-block", { titlePosition: "r" })).toContain("box-frame--title-position-r");
  });

  it("gives the title band a rule and a filled tab their own render classes and lengths", () => {
    const titlebox = createBoxBlock("titlebox");
    const bandbox = createBoxBlock("bandbox");
    const tabbox = createBoxBlock("tabbox");
    const theorembox = createBoxBlock("theorembox");

    const bandFrame = resolveBoxFrame(titlebox);
    expect(boxFrameClassName("sigma-doc-box-block", bandFrame, titlebox.styleId)).toContain("box-frame--title-band");
    expect(boxFrameStyleVars(bandFrame)).toMatchObject({
      "--sigma-doc-box-title-background": "#e5e7eb",
      "--sigma-doc-box-title-band-rule-width": "1.2px",
      "--sigma-doc-box-title-band-rule-color": "#111111",
    });
    // 帯の高さぶんだけ上のパディングを取っておく (負のマージンで帯を枠の上端へ寄せるので、
    // ここがずれると帯と枠線のあいだに隙間が出る)。
    const band = bandFrame.decorations?.find((decoration) => decoration.type === "titleBand");
    expect(band?.type === "titleBand" && band.heightPx).toBe(bandFrame.paddingPx?.top);

    // 罫を持たない既存の帯箱は 0px のまま = 線を引かない。
    expect(boxFrameStyleVars(resolveBoxFrame(createBoxBlock("tcolorbox"))))
      .toMatchObject({ "--sigma-doc-box-title-band-rule-width": "0px" });

    expect(boxFrameStyleVars(resolveBoxFrame(bandbox))).toMatchObject({
      "--sigma-doc-box-title-background": "#1f2937",
      "--sigma-doc-box-title-color": "#ffffff",
    });

    const tabFrame = resolveBoxFrame(tabbox);
    expect(boxFrameClassName("sigma-doc-box-block", tabFrame, tabbox.styleId)).toContain("box-frame--title-tab");
    expect(boxFrameDecorationAttributes(tabFrame)).toMatchObject({ "data-box-title-tab": "true" });
    expect(boxFrameStyleVars(tabFrame)).toMatchObject({
      "--sigma-doc-box-title-tab-height": "26px",
      "--sigma-doc-box-title-tab-radius": "4px",
      "--sigma-doc-box-title-tab-offset-x": "0px",
      "--sigma-doc-box-title-tab-padding-left": "14px",
      "--sigma-doc-box-title-background": "#1f3864",
      "--sigma-doc-box-title-color": "#ffffff",
    });

    // 定理箱は枠線を持たず、左の太罫と地色だけで示す。
    expect(boxFrameClassName("sigma-doc-box-block", resolveBoxFrame(theorembox), theorembox.styleId))
      .toContain("box-frame--left-bar");
    expect(boxFrameStyleVars(resolveBoxFrame(theorembox))).toMatchObject({
      "--sigma-doc-box-border-style": "none",
      "--sigma-doc-box-left-bar-width": "4px",
      "--sigma-doc-box-left-bar-color": "#1f3864",
      "--sigma-doc-box-title-color": "#1f3864",
    });
  });

  it("splits the heading into two cells whose order, share and gap are free", () => {
    const splitbox = createBoxBlock("splitbox");
    const frame = resolveBoxFrame(splitbox);

    expect(boxBlockTitleText(splitbox)).toBe("解法");
    expect(boxBlockSubtitleText(splitbox)).toBe("Point");
    expect(boxFrameHasSubtitle(frame)).toBe(true);
    expect(boxFrameClassName("sigma-doc-box-block", frame, splitbox.styleId)).toContain("box-frame--title-split");
    expect(boxFrameDecorationAttributes(frame)).toMatchObject({ "data-box-title-split": "true" });

    // 既定はサブタイトルが左、幅は 1:5。枠の左端に接するのはサブタイトル、右端はタイトル。
    expect(boxFrameStyleVars(frame)).toMatchObject({
      "--sigma-doc-box-split-columns": "minmax(0, 0.1667fr) minmax(0, 0.8333fr)",
      "--sigma-doc-box-split-gap": "0px",
      "--sigma-doc-box-subtitle-col": "1",
      "--sigma-doc-box-title-col": "2",
      "--sigma-doc-box-subtitle-margin-left": "-14px",
      "--sigma-doc-box-subtitle-margin-right": "0px",
      "--sigma-doc-box-title-margin-right": "-14px",
      "--sigma-doc-box-title-margin-left": "0px",
      "--sigma-doc-box-subtitle-background": "#333333",
      "--sigma-doc-box-subtitle-color": "#ffffff",
    });

    // 左右を入れ替え、幅と隙間を変える (段組みの列と同じ扱い)。
    const swapped = boxFrameStyleVars(patchBoxFrame(splitbox, {
      decorations: [
        ...(frame.decorations ?? []).filter((d) => d.type !== "titleSplit"),
        { type: "titleSplit", order: "titleFirst", subtitleShare: 0.25, gapPx: 6, subtitleAlign: "c" },
      ],
    }).frame ?? {});
    expect(swapped).toMatchObject({
      "--sigma-doc-box-split-columns": "minmax(0, 0.75fr) minmax(0, 0.25fr)",
      "--sigma-doc-box-split-gap": "6px",
      "--sigma-doc-box-title-col": "1",
      "--sigma-doc-box-subtitle-col": "2",
      "--sigma-doc-box-subtitle-justify": "center",
    });

    // 角丸の箱でも、丸めるのは外周に接する角だけ。2 欄の境目は直線で切る。
    const rounded = boxFrameStyleVars({ ...frame, cornerStyle: "round", radiusPx: 20, borderWidthPx: 2 });
    expect(rounded).toMatchObject({
      "--sigma-doc-box-subtitle-radius": "18px 0 0 0",
      "--sigma-doc-box-title-radius": "0 18px 0 0",
    });
    expect(boxFrameStyleVars({
      ...frame,
      cornerStyle: "round",
      radiusPx: 20,
      borderWidthPx: 2,
      decorations: [{ type: "titleSplit", order: "titleFirst" }],
    })).toMatchObject({
      "--sigma-doc-box-title-radius": "18px 0 0 0",
      "--sigma-doc-box-subtitle-radius": "0 18px 0 0",
    });

    // 割れない箱は何も足さない。
    const plain = resolveBoxFrame(createBoxBlock("titlebox"));
    expect(boxFrameHasSubtitle(plain)).toBe(false);
    expect(boxFrameClassName("sigma-doc-box-block", plain, "titlebox")).not.toContain("box-frame--title-split");
    expect(boxFrameStyleVars(plain)).not.toHaveProperty("--sigma-doc-box-split-columns");
    expect(createBoxBlock("titlebox").subtitle).toBeUndefined();
  });

  it("adds and drops the subtitle when the style gains or loses the split heading", () => {
    const withSubtitle = setBoxStyle(createBoxBlock("titlebox", "見出し"), "splitbox");
    expect(boxBlockSubtitleText(withSubtitle)).toBe("Point");
    expect(boxBlockTitleText(withSubtitle)).toBe("見出し");

    const edited = { ...withSubtitle, subtitle: [{ type: "text" as const, text: "要点" }] };
    expect(boxBlockSubtitleText(setBoxStyle(edited, "splitbox"))).toBe("要点");
    expect(setBoxStyle(edited, "titlebox")).not.toHaveProperty("subtitle");
  });

  it("falls back to the tab color for the title background when the frame sets none", () => {
    expect(boxFrameStyleVars({
      backgroundColor: "#ffffff",
      decorations: [{ type: "titleTab", backgroundColor: "#123456" }],
    })).toMatchObject({ "--sigma-doc-box-title-background": "#123456" });
  });

  it("exposes the box background as the shared editor and print title-plate color", () => {
    expect(boxFrameStyleVars({ backgroundColor: "#fef3c7" })).toMatchObject({
      "--sigma-doc-box-background": "#fef3c7",
    });
  });
});

describe("box block editing", () => {
  it("updates style, title, and frame without changing box contents", () => {
    const block = createBoxBlock("itembox", "変更前", { bodyText: "本文" });
    const restyled = setBoxStyle(block, "doublebox");
    const retitled = setBoxTitle(restyled, "  変更後  ");
    const patched = patchBoxFrame(retitled, {
      borderWidthPx: 2.5,
      titlePosition: "r",
      paddingPx: { top: 20, right: 18, bottom: 16, left: 18 },
    });

    expect(restyled).toMatchObject({
      styleId: "doublebox",
      blocks: block.blocks,
    });
    expect(restyled.frame).toEqual(BUILTIN_BOX_STYLES.find((style) => style.id === "doublebox")?.frame);
    expect(restyled.frame).not.toEqual(block.frame);
    expect(boxBlockTitleText(retitled)).toBe("変更後");
    expect(patched).toMatchObject({
      frame: {
        borderWidthPx: 2.5,
        titlePosition: "r",
        paddingPx: { top: 20, right: 18, bottom: 16, left: 18 },
      },
      blocks: block.blocks,
    });
    expect(block.styleId).toBe("itembox");
    expect(boxBlockTitleText(block)).toBe("変更前");
  });

  it("clears empty titles, falls back to fancybox, and ignores non-box blocks", () => {
    const block = createBoxBlock("itembox", "ポイント");
    const paragraph = block.blocks[0];

    expect(setBoxTitle(block, "   ").title).toBeUndefined();
    expect(setBoxStyle(block, "unknown-style").styleId).toBe(BUILTIN_BOX_STYLES[0]?.id);
    expect(setBoxStyle(paragraph, "doublebox")).toBe(paragraph);
    expect(setBoxTitle(paragraph, "見出し")).toBe(paragraph);
    expect(patchBoxFrame(paragraph, { borderWidthPx: 2 })).toBe(paragraph);
  });

  it("does not add fallback padding when a frame has no padding inputs", () => {
    const block = {
      ...createBoxBlock(),
      frame: undefined,
    } satisfies BoxBlockNode;

    expect(patchBoxFrame(block, { borderWidthPx: 2 }).frame).toEqual({
      borderWidthPx: 2,
      decorations: undefined,
    });
    expect(resolveBoxFrame({ styleId: "unknown-style", frame: undefined })).not.toHaveProperty("paddingPx");
  });
});


/**
 * `boxFrameAppliesFontFamily` は CSS に対する主張である: 「この枠のクラスは `font-family` を
 * 打ち消すので、`frame` に保存された書体はグリフに届かない」。
 *
 * その CSS 側は `src/app/document-surface.test.ts` の
 * 「cornerbox の font-family 打ち消し」ブロックが固定しており、**両方そろって初めて**
 * 「ツールバーに出る書体 = 実際に描かれる書体」が保証される。片方だけ変えると向こうが赤くなる。
 */
describe("boxFrameAppliesFontFamily", () => {
  it("reports that a cornerbox never draws the font it stores", () => {
    const frame = resolveBoxFrame(createBoxBlock("cornerbox"));
    // プリセットは明朝を持っているのに、描画には届かない。ここが「嘘の表示」の入口だった。
    expect(frame.bodyFontFamily).toBeTruthy();
    expect(frame.titleFontFamily).toBeTruthy();
    expect(boxFrameAppliesFontFamily("cornerbox", frame)).toBe(false);
  });

  it("reports that an ordinary frame does draw the font it stores", () => {
    // 判定が「常に false」へ退化していないこと。
    const frame = resolveBoxFrame(createBoxBlock("fancybox"));
    expect(boxFrameAppliesFontFamily("fancybox", frame)).toBe(true);
  });

  it("keys off the decoration that actually produces the corner frame class", () => {
    // `box-frame--corner` は styleId だけでなく titleDoubleRule 装飾の有無で決まる
    // (`boxFrameClassName`)。装飾を落とした cornerbox はそのクラスが付かない = 打ち消されない。
    const withoutDoubleRule = { decorations: [{ type: "cornerSquares" as const, sizePx: 8, color: "#000000" }] };
    // トークン単位で見る: `box-frame--corner-squares` は別クラスで、部分一致では区別できない。
    expect(boxFrameClassName("cornerbox", withoutDoubleRule).split(/\s+/))
      .not.toContain("box-frame--corner");
    expect(boxFrameAppliesFontFamily("cornerbox", withoutDoubleRule)).toBe(true);
  });

  it("treats a frame with no style id as one that draws its font", () => {
    expect(boxFrameAppliesFontFamily(undefined, { decorations: [] })).toBe(true);
  });
});

describe("box frame style attribute CSS injection", () => {
  // ProseMirror assigns this string to `dom.style.cssText`, which parses it as a declaration list,
  // and box frame colors are plain `z.string().optional()` in the schema.
  const INJECTED = "red;position:fixed;top:0;left:0;width:100vw;height:100vh;background:#fff;z-index:2147483647";

  it("drops an injected border color instead of adding declarations", () => {
    const style = boxFrameStyleAttribute({ borderColor: INJECTED } as BoxFrameSpec);

    expect(style).not.toContain("position:fixed");
    expect(style).not.toContain("z-index:2147483647");
  });

  it("drops a value that would fetch an external resource", () => {
    const style = boxFrameStyleAttribute({
      backgroundColor: "url(https://example.com/beacon.png)",
    } as BoxFrameSpec);

    expect(style).not.toContain("example.com");
  });

  it("keeps every declaration a legitimate frame produces", () => {
    const frame = { borderColor: "#111827", backgroundColor: "#ffffff" } as BoxFrameSpec;

    expect(boxFrameStyleAttribute(frame).split(";")).toHaveLength(
      Object.keys(boxFrameStyleVars(frame)).length,
    );
  });
});
