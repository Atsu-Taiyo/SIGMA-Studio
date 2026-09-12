import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  BlockArrowIcon as legacyBlockArrowIcon,
  isLineToolCommand as legacyIsLineToolCommand,
  isShapeMenuCommand as legacyIsShapeMenuCommand,
  buildLineToolItems as legacyBuildLineToolItems,
  PolylineIcon as legacyPolylineIcon,
  buildShapeGallerySections as legacyBuildShapeGallerySections,
  buildShapeTypeChangeSections as legacyBuildShapeTypeChangeSections,
  ThreePointArcIcon as legacyThreePointArcIcon,
} from "../editor-shell/constants";
import {
  BlockArrowIcon,
  isLineToolCommand,
  isShapeMenuCommand,
  buildLineToolItems,
  buildShapeGallerySections,
  buildShapeTypeChangeSections,
  PolylineIcon,
  ThreePointArcIcon,
  type ShapeGallerySection,
} from "./shape-gallery";
import { createTranslator } from "@/lib/i18n";

/** 文言は辞書が持つので、テストは**日本語で引いた結果**に対して構造を固定する。 */
const t = createTranslator("ja", "shape");
const LINE_TOOL_ITEMS = buildLineToolItems(t);
const SHAPE_GALLERY_SECTIONS = buildShapeGallerySections(t);
const SHAPE_TYPE_CHANGE_SECTIONS = buildShapeTypeChangeSections(t);
const legacyLineToolItems = legacyBuildLineToolItems(t);
const legacyShapeGallerySections = legacyBuildShapeGallerySections(t);
const legacyShapeTypeChangeSections = legacyBuildShapeTypeChangeSections(t);

function galleryStructure(sections: ShapeGallerySection[]) {
  return sections.map((section) => ({
    label: section.label,
    items: section.items.map((item) => ({
      action: item.action,
      command: item.command,
      label: item.label,
    })),
  }));
}

describe("overlay toolbar menu classification", () => {
  it("keeps the line menu order and shape-menu classification stable", () => {
    expect(LINE_TOOL_ITEMS.map(({ command, label }) => ({ command, label }))).toEqual([
      { command: "line", label: "線" },
      { command: "polyline", label: "折れ線" },
      { command: "curve", label: "曲線" },
      { command: "freehand", label: "フリーハンド" },
      { command: "arrow", label: "矢印" },
      { command: "blockArrow", label: "太矢印" },
    ]);
    // 一覧と判定は同じ出典から出ていること。別々に持っていた頃は、線ツールを
    // 増やして片方を忘れると図形メニュー扱いに落ちて誰も気づかなかった。
    expect(LINE_TOOL_ITEMS.every((item) => isLineToolCommand(item.command))).toBe(true);
    expect(LINE_TOOL_ITEMS.filter((item) => isShapeMenuCommand(item.command))).toEqual([]);
    expect(isLineToolCommand("blockArrow")).toBe(true);
    expect(isShapeMenuCommand("blockArrow")).toBe(false);
    expect(isShapeMenuCommand("rectangle")).toBe(true);
  });
});

describe("shape gallery", () => {
  it("keeps insertion section and item order stable", () => {
    expect(galleryStructure(SHAPE_GALLERY_SECTIONS)).toEqual([
      {
        label: "基本図形",
        items: [
          { action: "command", command: "rectangle", label: "四角形" },
          { action: "command", command: "circle", label: "円" },
          { action: "command", command: "triangle", label: "三角形" },
          { action: "command", command: "diamond", label: "菱形" },
          { action: "command", command: "pentagon", label: "正五角形" },
          { action: "command", command: "hexagon", label: "正六角形" },
          { action: "command", command: "heptagon", label: "正七角形" },
          { action: "command", command: "octagon", label: "正八角形" },
          { action: "command", command: "nonagon", label: "正九角形" },
          { action: "command", command: "decagon", label: "正十角形" },
          { action: "command", command: "hendecagon", label: "正十一角形" },
          { action: "command", command: "dodecagon", label: "正十二角形" },
        ],
      },
      {
        label: "円弧・扇形",
        items: [
          { action: "command", command: "arc", label: "円弧" },
          { action: "command", command: "sector", label: "扇形" },
          { action: "command", command: "threePointArc", label: "3点円弧" },
        ],
      },
      {
        label: "その他",
        items: [
          { action: "command", command: "text", label: "テキスト" },
          { action: "command", command: "callout", label: "吹き出し" },
          { action: "command", command: "table", label: "表" },
          { action: "image", command: undefined, label: "画像" },
        ],
      },
    ]);
  });

  it("keeps the type-change filter and ordering stable", () => {
    expect(galleryStructure(SHAPE_TYPE_CHANGE_SECTIONS)).toEqual([
      {
        label: "基本図形",
        items: galleryStructure(SHAPE_GALLERY_SECTIONS)[0].items,
      },
      {
        label: "円弧・扇形",
        items: [
          { action: "command", command: "arc", label: "円弧" },
          { action: "command", command: "sector", label: "扇形" },
        ],
      },
      {
        label: "その他",
        items: [
          { action: "command", command: "callout", label: "吹き出し" },
        ],
      },
      {
        label: "線・矢印",
        items: [
          { action: "command", command: "line", label: "線" },
          { action: "command", command: "polyline", label: "折れ線" },
          { action: "command", command: "curve", label: "曲線" },
          { action: "command", command: "freehand", label: "フリーハンド" },
          { action: "command", command: "arrow", label: "矢印" },
          { action: "command", command: "blockArrow", label: "太矢印" },
        ],
      },
    ]);
  });

  it("has no duplicate insertion commands or line-menu commands in the insertion gallery", () => {
    const commands = SHAPE_GALLERY_SECTIONS
      .flatMap((section) => section.items)
      .filter((item) => item.action === "command")
      .map((item) => item.command);

    expect(new Set(commands).size).toBe(commands.length);
    expect(commands).not.toContain("select");
    for (const item of LINE_TOOL_ITEMS) {
      expect(commands).not.toContain(item.command);
    }
  });

  it("reuses each canonical icon in the type-change menu", () => {
    const insertionIcons = new Map(
      SHAPE_GALLERY_SECTIONS
        .flatMap((section) => section.items)
        .filter((item) => item.command)
        .map((item) => [item.command, item.icon]),
    );
    const lineIcons = new Map(LINE_TOOL_ITEMS.map((item) => [item.command, item.icon]));

    for (const item of SHAPE_TYPE_CHANGE_SECTIONS.flatMap((section) => section.items)) {
      if (!item.command) {
        throw new Error(`Type-change item must have a command: ${item.label}`);
      }
      expect(item.icon).toBe(insertionIcons.get(item.command) ?? lineIcons.get(item.command));
    }
  });

  it("shows side-count numerals inside polygon menu icons from six sides onward", () => {
    const items = SHAPE_GALLERY_SECTIONS.flatMap((section) => section.items);
    const pentagon = items.find((item) => item.label === "正五角形")!;
    const hexagon = items.find((item) => item.label === "正六角形")!;
    const dodecagon = items.find((item) => item.label === "正十二角形")!;
    const pentagonMarkup = renderToStaticMarkup(createElement(pentagon.icon));
    const hexagonMarkup = renderToStaticMarkup(createElement(hexagon.icon));
    const dodecagonMarkup = renderToStaticMarkup(createElement(dodecagon.icon));

    expect(pentagonMarkup.match(/<path/g)).toBeNull();
    expect(hexagonMarkup.match(/<path/g)).toHaveLength(1);
    expect(dodecagonMarkup.match(/<path/g)).toHaveLength(1);
  });

  it("keeps the legacy shell exports as identity-preserving compatibility aliases", () => {
    // 一覧は文言を持つようになったので、再エクスポートが同じ**関数**を指していることを見る
    // (呼ぶたびに新しい配列を返すのが正しいので、配列の同一性では判定できない)。
    expect(legacyBuildShapeGallerySections).toBe(buildShapeGallerySections);
    expect(legacyBuildShapeTypeChangeSections).toBe(buildShapeTypeChangeSections);
    expect(legacyBuildLineToolItems).toBe(buildLineToolItems);
    expect(legacyShapeGallerySections).toEqual(SHAPE_GALLERY_SECTIONS);
    expect(legacyShapeTypeChangeSections).toEqual(SHAPE_TYPE_CHANGE_SECTIONS);
    expect(legacyLineToolItems).toEqual(LINE_TOOL_ITEMS);
    expect(legacyIsLineToolCommand).toBe(isLineToolCommand);
    expect(legacyIsShapeMenuCommand).toBe(isShapeMenuCommand);
    expect(legacyThreePointArcIcon).toBe(ThreePointArcIcon);
    expect(legacyBlockArrowIcon).toBe(BlockArrowIcon);
    expect(legacyPolylineIcon).toBe(PolylineIcon);
  });
});
