import { describe, expect, it } from "vitest";

import type { HeadingNode, SectionNode, SigmaBlock } from "@/features/document";

import { formatHeadingNumber, getHeadingNumberMap } from "./heading-numbering";

const heading = (id: string, level: 1 | 2 | 3): HeadingNode => ({
  type: "heading",
  id,
  level,
  children: [{ type: "text", text: id }],
});

const section = (id: string): SectionNode => ({
  type: "section",
  id,
  title: id,
});

describe("getHeadingNumberMap", () => {
  it("increments levels, resets descendants, and initializes missing ancestor levels", () => {
    const content: SigmaBlock[] = [
      heading("h1-a", 1),
      heading("h2-a", 2),
      heading("h3-a", 3),
      heading("h2-b", 2),
      heading("h1-b", 1),
      heading("h3-b", 3),
    ];

    expect([...getHeadingNumberMap(content, { enabled: true })]).toEqual([
      ["h1-a", "1"],
      ["h2-a", "1.1"],
      ["h3-a", "1.1.1"],
      ["h2-b", "1.2"],
      ["h1-b", "2"],
      ["h3-b", "2.1.1"],
    ]);
  });

  it("starts documents with H2 or H3 without zero-valued ancestors", () => {
    expect([...getHeadingNumberMap(
      [heading("h2", 2), heading("h3", 3)],
      { enabled: true },
    )]).toEqual([["h2", "1.1"], ["h3", "1.1.1"]]);

    expect([...getHeadingNumberMap(
      [heading("h3", 3)],
      { enabled: true },
    )]).toEqual([["h3", "1.1.1"]]);
  });

  it("treats sections as level-1 headings and resets descendant counters", () => {
    const content: SigmaBlock[] = [
      section("section-a"),
      heading("h2-a", 2),
      section("section-b"),
      heading("h2-b", 2),
    ];

    expect([...getHeadingNumberMap(content, { enabled: true })]).toEqual([
      ["section-a", "1"],
      ["h2-a", "1.1"],
      ["section-b", "2"],
      ["h2-b", "2.1"],
    ]);
  });

  it("does not let an invisible H2 mutate counters at depth 1", () => {
    const numbers = getHeadingNumberMap(
      [heading("hidden-h2", 2), heading("visible-h1", 1)],
      { enabled: true, depth: 1 },
    );

    expect(numbers.get("hidden-h2")).toBeUndefined();
    expect([...numbers]).toEqual([["visible-h1", "1"]]);
  });

  it("does not let an invisible H3 mutate counters at depth 2", () => {
    const numbers = getHeadingNumberMap(
      [heading("hidden-h3", 3), heading("visible-h2", 2)],
      { enabled: true, depth: 2 },
    );

    expect(numbers.get("hidden-h3")).toBeUndefined();
    expect([...numbers]).toEqual([["visible-h2", "1.1"]]);
  });

  it("formats a section with the chapterJa level-1 style", () => {
    expect([...getHeadingNumberMap(
      [section("section-a")],
      { enabled: true, style: "chapterJa" },
    )]).toEqual([["section-a", "第1章"]]);
  });

  it("omits labels deeper than the configured depth", () => {
    expect([...getHeadingNumberMap(
      [heading("h1", 1), heading("h2", 2), heading("h3", 3)],
      { enabled: true, depth: 2 },
    )]).toEqual([["h1", "1"], ["h2", "1.1"]]);
  });

  it("is off when the optional config is absent or disabled", () => {
    expect(getHeadingNumberMap([heading("h1", 1)], undefined).size).toBe(0);
    expect(getHeadingNumberMap([heading("h1", 1)], { enabled: false }).size).toBe(0);
  });

  it("never writes derived labels into heading children", () => {
    const content: SigmaBlock[] = [heading("h1", 1), heading("h2", 2)];
    const before = JSON.stringify(content);

    expect([...getHeadingNumberMap(content, { enabled: true })]).toEqual([["h1", "1"], ["h2", "1.1"]]);
    expect(JSON.stringify(content)).toBe(before);
    expect(content[0]).toMatchObject({ children: [{ type: "text", text: "h1" }] });
  });

  it("numbers layout-section children in surrounding document order", () => {
    const content: SigmaBlock[] = [
      heading("h1", 1),
      {
        type: "layoutSection",
        id: "columns",
        layout: { columnCount: 2 },
        children: [heading("h2-column", 2), { type: "paragraph", id: "p", children: [] }],
      },
      heading("h2-after", 2),
    ];

    expect([...getHeadingNumberMap(content, { enabled: true })]).toEqual([
      ["h1", "1"],
      ["h2-column", "1.1"],
      ["h2-after", "1.2"],
    ]);
  });

  it("does not number headings inside quotes, boxes, or problems", () => {
    const content: SigmaBlock[] = [
      heading("top", 1),
      { type: "quote", id: "quote", blocks: [heading("quoted", 2)] },
      { type: "boxBlock", id: "box", styleId: "fancybox", blocks: [heading("boxed", 2)] },
      {
        type: "problem",
        id: "problem",
        tags: [],
        lead: [heading("problem-heading", 2)],
        prompt: [],
        hints: [],
        solution: [],
      },
      heading("after", 2),
    ];

    expect([...getHeadingNumberMap(content, { enabled: true })]).toEqual([
      ["top", "1"],
      ["after", "1.1"],
    ]);
  });
});

describe("formatHeadingNumber", () => {
  it("formats every supported style from one source", () => {
    expect(formatHeadingNumber([1, 2, 3], 1, "decimal")).toBe("1");
    expect(formatHeadingNumber([1, 2, 3], 3, "decimal")).toBe("1.2.3");
    expect(formatHeadingNumber([1, 2, 3], 2, "sectionSign")).toBe("§1.2");
    expect(formatHeadingNumber([1, 2, 3], 1, "chapterJa")).toBe("第1章");
    expect(formatHeadingNumber([1, 2, 3], 3, "chapterJa")).toBe("1.2.3");
  });
});
