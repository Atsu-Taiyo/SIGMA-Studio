import { describe, expect, it } from "vitest";

import type {
  HeadingNode,
  ParagraphNode,
  SectionNode,
} from "@/features/document";
import {
  convertBlockStyle,
  type BlockStyleTarget,
} from "@/features/text-editing";

const pagination = {
  keepTogether: true,
  keepWithNext: true,
  break: true as const,
};

describe("convertBlockStyle", () => {
  const section: SectionNode = {
    type: "section",
    id: "section-1",
    title: "章の見出し",
    align: "center",
    lineHeight: "1.8",
    pagination,
  };
  const headingChildren: HeadingNode["children"] = [
    { type: "text", text: "見出し " },
    { type: "mathInline", id: "math-heading", tex: "x^2", display: "inline" },
  ];
  const heading: HeadingNode = {
    type: "heading",
    id: "heading-1",
    level: 2,
    children: headingChildren,
    align: "right",
    lineHeight: "1.6",
    pagination,
  };
  const paragraphChildren: ParagraphNode["children"] = [
    { type: "text", text: "本文" },
  ];
  const paragraph: ParagraphNode = {
    type: "paragraph",
    id: "paragraph-1",
    children: paragraphChildren,
    align: "justify",
    lineHeight: "1.5",
    pagination,
  };

  it.each([
    {
      name: "sectionをparagraphへ変換する",
      node: section,
      style: "paragraph",
      expected: {
        type: "paragraph",
        id: section.id,
        children: [{ type: "text", text: section.title }],
        align: section.align,
        lineHeight: section.lineHeight,
        pagination: section.pagination,
      },
    },
    {
      name: "headingをparagraphへ変換する",
      node: heading,
      style: "paragraph",
      expected: {
        type: "paragraph",
        id: heading.id,
        children: heading.children,
        align: heading.align,
        lineHeight: heading.lineHeight,
        pagination: heading.pagination,
      },
    },
    {
      name: "sectionをh2へ変換する",
      node: section,
      style: "h2",
      expected: {
        type: "heading",
        id: section.id,
        level: 2,
        children: [{ type: "text", text: section.title }],
        align: section.align,
        lineHeight: section.lineHeight,
        pagination: section.pagination,
      },
    },
    {
      name: "sectionをh3へ変換する",
      node: section,
      style: "h3",
      expected: {
        type: "heading",
        id: section.id,
        level: 3,
        children: [{ type: "text", text: section.title }],
        align: section.align,
        lineHeight: section.lineHeight,
        pagination: section.pagination,
      },
    },
    {
      name: "paragraphをh1へ変換する",
      node: paragraph,
      style: "h1",
      expected: {
        type: "heading",
        id: paragraph.id,
        level: 1,
        children: paragraph.children,
        align: paragraph.align,
        lineHeight: paragraph.lineHeight,
        pagination: paragraph.pagination,
      },
    },
    {
      name: "headingのlevelをh3へ変更する",
      node: heading,
      style: "h3",
      expected: {
        type: "heading",
        id: heading.id,
        level: 3,
        children: heading.children,
        align: heading.align,
        lineHeight: heading.lineHeight,
        pagination: heading.pagination,
      },
    },
  ])("$name", ({ node, style, expected }) => {
    expect(convertBlockStyle(node, style)).toEqual(expected);
  });

  it.each([
    {
      name: "sectionへh1を指定する",
      node: section,
      style: "h1",
    },
    {
      name: "listItemへ見出しを指定する",
      node: {
        type: "listItem",
        id: "list-item-1",
        children: [{ type: "text", text: "箇条書き" }],
      } satisfies BlockStyleTarget,
      style: "h2",
    },
    {
      name: "未対応styleを指定する",
      node: paragraph,
      style: "unknown",
    },
  ])("$name場合は同一参照のままにする", ({ node, style }) => {
    expect(convertBlockStyle(node, style)).toBe(node);
  });

  it.each([
    { node: heading, style: "paragraph", children: headingChildren },
    { node: heading, style: "h1", children: headingChildren },
    { node: paragraph, style: "h2", children: paragraphChildren },
  ])("既存children配列を保持する ($style)", ({ node, style, children }) => {
    const result = convertBlockStyle(node, style);
    expect(result.type === "paragraph" || result.type === "heading").toBe(true);
    if (result.type === "paragraph" || result.type === "heading") {
      expect(result.children).toBe(children);
    }
  });
});

describe("convertBlockStyle と文字サイズ", () => {
  it("見出しへ変換すると run の文字サイズ指定を落とす", () => {
    // インラインの font-size は見出しレベルの CSS に必ず勝つので、残すと
    // 見出し1/2/3 が同じ大きさに見える。
    const result = convertBlockStyle({
      type: "paragraph",
      id: "p1",
      children: [
        { type: "text", text: "本文", fontSize: 12, color: "#ff0000" },
        { type: "mathInline", id: "m1", tex: "x", display: "inline", fontSize: 12 },
      ],
    }, "h2");

    expect(result.type).toBe("heading");
    if (result.type === "heading") {
      expect(result.children).toEqual([
        { type: "text", text: "本文", color: "#ff0000" },
        { type: "mathInline", id: "m1", tex: "x", display: "inline" },
      ]);
    }
  });

  it("段落へ戻すときは文字サイズ指定に触らない", () => {
    const result = convertBlockStyle({
      type: "heading",
      id: "h1",
      level: 2,
      children: [{ type: "text", text: "見出し", fontSize: 20 }],
    }, "paragraph");

    expect(result.type).toBe("paragraph");
    if (result.type === "paragraph") {
      expect(result.children[0]).toMatchObject({ fontSize: 20 });
    }
  });
});

describe("コードブロック", () => {
  // ツールバーのコードボタンと同じ結果になること。押せるのに何も起きないコントロールを残さない。
  it("段落スタイルの「本文」で解除できる", () => {
    expect(convertBlockStyle({
      type: "codeBlock",
      id: "c1",
      language: "python",
      children: [{ type: "text", text: "x = 1" }],
    }, "paragraph")).toEqual({
      type: "paragraph",
      id: "c1",
      children: [{ type: "text", text: "x = 1" }],
      pagination: undefined,
    });
  });
});

describe("convertBlockStyle keeps the space below the block", () => {
  const paragraphWithSpace: ParagraphNode = {
    type: "paragraph",
    id: "p-space",
    children: [{ type: "text", text: "本文" }],
    spaceAfterPx: 24,
  };
  const headingWithSpace: HeadingNode = {
    type: "heading",
    id: "h-space",
    level: 2,
    children: [{ type: "text", text: "見出し" }],
    spaceAfterPx: 24,
  };
  const sectionWithSpace: SectionNode = {
    type: "section",
    id: "s-space",
    title: "節",
    spaceAfterPx: 24,
  };

  it.each([
    ["paragraph to h2", paragraphWithSpace as BlockStyleTarget, "h2"],
    ["heading to paragraph", headingWithSpace as BlockStyleTarget, "paragraph"],
    ["heading to h3", headingWithSpace as BlockStyleTarget, "h3"],
    ["section to paragraph", sectionWithSpace as BlockStyleTarget, "paragraph"],
    ["section to h2", sectionWithSpace as BlockStyleTarget, "h2"],
    ["code block to paragraph", { type: "codeBlock", id: "c-space", children: [], spaceAfterPx: 24 } as BlockStyleTarget, "paragraph"],
  ])("keeps it when converting %s", (_name, node, style) => {
    expect(spaceAfterOf(convertBlockStyle(node, style))).toBe(24);
  });

  it("leaves an untouched block without a space", () => {
    const plain: ParagraphNode = { type: "paragraph", id: "p-plain", children: [] };
    expect(spaceAfterOf(convertBlockStyle(plain, "h2"))).toBeUndefined();
  });
});

/** `BlockStyleTarget` は `ListItemNode` も含む (それだけが下余白を持たない)。 */
function spaceAfterOf(node: BlockStyleTarget): number | undefined {
  return node.type === "listItem" ? undefined : node.spaceAfterPx;
}
