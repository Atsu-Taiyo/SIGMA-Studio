import { describe, expect, it } from "vitest";

import { createLayoutSection } from "@/lib/document-tree";
import { getHeadingNumberMap } from "@/lib/heading-numbering";
import { createTranslator } from "@/lib/i18n";
import { buildOutlineNavigation } from "@/lib/outline-navigation";
import type { HeadingNode, ParagraphNode, ProblemNode, SectionNode, SigmaDocument } from "@/types/sigma-doc";

const paragraph = (id: string, text: string): ParagraphNode => ({
  type: "paragraph",
  id,
  children: [{ type: "text", text }],
});

const heading = (id: string, level: 1 | 2 | 3, text: string): HeadingNode => ({
  type: "heading",
  id,
  level,
  children: [{ type: "text", text }],
});

const section = (id: string, title: string): SectionNode => ({ type: "section", id, title });

const problem = (id: string): ProblemNode => ({
  type: "problem",
  id,
  tags: [],
  lead: [],
  prompt: [paragraph(`${id}_prompt`, "prompt")],
  solution: [],
  hints: [],
});

const documentOf = (content: SigmaDocument["content"], metadata: Partial<SigmaDocument["metadata"]> = {}): SigmaDocument => ({
  version: "2.0",
  docId: "doc_outline_navigation",
  metadata: { title: "Test", ...metadata },
  outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  content,
});

describe("buildOutlineNavigation", () => {
  it("lists sections, headings and problems in document order and skips body text", () => {
    const items = buildOutlineNavigation(documentOf([
      paragraph("intro", "導入"),
      heading("h1", 1, "二次関数"),
      paragraph("body", "本文"),
      problem("problem_1"),
    ]));

    expect(items.map(({ id, title, kind }) => ({ id, title, kind }))).toEqual([
      { id: "h1", title: "二次関数", kind: "heading" },
      { id: "problem_1", title: "問題 1", kind: "problem" },
    ]);
  });

  it("indents by heading level, measured from the shallowest level the material uses", () => {
    const items = buildOutlineNavigation(documentOf([
      heading("a", 1, "A"),
      heading("a1", 2, "A-1"),
      heading("a1x", 3, "A-1-x"),
      heading("b", 1, "B"),
    ]));
    expect(items.map((item) => item.depth)).toEqual([0, 1, 2, 0]);

    // H1 を使わない教材では H2 が左端になる。
    const fromH2 = buildOutlineNavigation(documentOf([
      heading("a", 2, "A"),
      heading("a1", 3, "A-1"),
    ]));
    expect(fromH2.map((item) => item.depth)).toEqual([0, 1]);
  });

  it("counts a section as a level-1 heading and puts a problem one step under the heading before it", () => {
    const items = buildOutlineNavigation(documentOf([
      problem("before_any_heading"),
      section("s1", "第1節"),
      problem("p_under_section"),
      heading("h2", 2, "小見出し"),
      problem("p_under_h2"),
    ]));

    expect(items.map(({ id, depth }) => ({ id, depth }))).toEqual([
      { id: "before_any_heading", depth: 0 },
      { id: "s1", depth: 0 },
      { id: "p_under_section", depth: 1 },
      { id: "h2", depth: 1 },
      { id: "p_under_h2", depth: 2 },
    ]);
  });

  it("includes headings inside a column section but not the column section itself", () => {
    const columns = createLayoutSection([heading("inner", 2, "段組みの中の見出し")], 2);
    const items = buildOutlineNavigation(documentOf([heading("outer", 1, "外"), columns]));

    expect(items.map((item) => item.id)).toEqual(["outer", "inner"]);
    expect(items.map((item) => item.kind)).toEqual(["heading", "heading"]);
  });

  it("prefixes heading numbers only when numbering is on", () => {
    const content = [heading("h1", 1, "一"), heading("h2", 2, "二"), problem("p1")];
    const plain = buildOutlineNavigation(documentOf(content));
    expect(plain.every((item) => item.number === undefined)).toBe(true);

    const numbered = documentOf(content, { headingNumbering: { enabled: true, depth: 3, style: "decimal" } });
    const items = buildOutlineNavigation(numbered, {
      headingNumbers: getHeadingNumberMap(numbered.content, numbered.metadata.headingNumbering),
    });
    expect(items.map((item) => item.number)).toEqual(["1", "1.1", undefined]);
  });

  it("names empty headings and problems in the language it is given", () => {
    const content = [heading("empty", 1, ""), problem("p1")];
    const en = buildOutlineNavigation(documentOf(content), { t: createTranslator("en", "editor") });
    expect(en.map((item) => item.title)).toEqual(["Heading", "Problem 1"]);

    const ja = buildOutlineNavigation(documentOf(content));
    expect(ja.map((item) => item.title)).toEqual(["見出し", "問題 1"]);
  });

  it("returns nothing for a material without headings or problems", () => {
    expect(buildOutlineNavigation(documentOf([paragraph("p", "本文だけ")]))).toEqual([]);
  });
});
