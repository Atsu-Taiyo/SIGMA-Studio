import { describe, expect, it } from "vitest";

import { createBlankDocument } from "@/lib/blank-document";
import { BUILTIN_BOX_STYLES } from "@/lib/box-blocks";
import { PROBLEM_FRAME_STYLE_OPTIONS } from "@/lib/problem-frame";
import type { SigmaBlock, SigmaDocument } from "@/features/document";
import { documentEvidence, observeWriting, projectDocument } from "./authoring-style-features";
import { itemText, sectionOf } from "./authoring-style-items";
import { BOX_STYLE_IDS, MAX_OUTLINE_LENGTH, PROBLEM_FRAME_IDS, projectLayout, sequenceOf } from "./authoring-style-layout";

const text = (value: string) => [{ type: "text" as const, text: value }];
const p = (id: string, value: string): Extract<SigmaBlock, { type: "paragraph" }> => ({ id, type: "paragraph", children: text(value) });
const h = (id: string, level: 1 | 2 | 3, value: string, align?: "center"): SigmaBlock => ({ id, type: "heading", level, children: text(value), ...(align ? { align } : {}) });
const box = (id: string, styleId: string, title: string, body: SigmaBlock[]): SigmaBlock => ({ id, type: "boxBlock", styleId, ...(title ? { title: text(title) } : {}), blocks: body });
type Problem = Extract<SigmaBlock, { type: "problem" }>;
const problem = (id: string, parts: Partial<Problem>): SigmaBlock => ({ id, type: "problem", tags: [], lead: [], prompt: [], solution: [], hints: [], ...parts });
const list = (id: string, markerStyle: "paren" | "parenLowerAlpha", items: string[]): Extract<SigmaBlock, { type: "list" }> =>
  ({ id, type: "list", listType: "ordered", markerStyle, items: items.map((value, index) => ({ type: "listItem", id: `${id}_${index}`, children: text(value) })) });
const doc = (content: SigmaBlock[], change: (document: SigmaDocument) => void = () => {}): SigmaDocument => {
  const document = { ...createBlankDocument("演習"), content };
  change(document);
  return document;
};
const votesOf = (document: SigmaDocument, id: string) => Object.fromEntries(projectLayout(document).units.find(unit => unit.id === id)?.votes ?? []);

describe("how a document is laid out", () => {
  it("knows every built-in box and problem frame style, and no other", () => {
    expect(BOX_STYLE_IDS).toEqual([...BUILTIN_BOX_STYLES.map(style => style.id), "custom"]);
    expect(PROBLEM_FRAME_IDS).toEqual([...PROBLEM_FRAME_STYLE_OPTIONS.map(option => option.id), "custom"]);
  });

  it("reads where a problem's parts go, how it is numbered and framed, and the room left to answer", () => {
    const document = doc([
      problem("q1", { lead: [p("q1l", "第1問 次の問いに答えよ。")], prompt: [p("q1p", "関数を考える。"), list("q1s", "paren", ["最小値を求めよ。", "最大値を求めよ。"])], solution: [p("q1a", "平方完成する。")],
        numbering: { enabled: false }, frame: { enabled: true, styleId: "doublebox" }, areaLayout: { solution: { minHeightMm: 40 } } }),
      box("b1", "tcolorbox", "ポイント", [p("b1p", "軸の位置に注意する。")]),
      problem("q2", { prompt: [p("q2p", "(1) 値を求めよ。")], hints: [p("q2h", "判別式を使う。")], spaceAfterPx: 120, areaLayout: { lead: { hidden: true } }, numbering: { format: "fullwidth" } }),
      problem("q3", { prompt: [p("q3p", "証明せよ。")] }),
    ]);
    expect(votesOf(document, "q1")).toEqual({ "layout.problemNumber": "none", "layout.problemLabel": "daimon", "layout.problemFrame": "doublebox", "layout.problemLead": "filled",
      "layout.comment": "boxAfter", "layout.answerSpace": "area", "layout.subquestionList": "paren" });
    expect(votesOf(document, "q2")).toEqual({ "layout.problemNumber": "fullwidth", "layout.problemLabel": "none", "layout.problemFrame": "none", "layout.problemLead": "hidden",
      "layout.comment": "area", "layout.answerSpace": "after", "layout.subquestionList": "text" });
    expect(votesOf(document, "q3")).toMatchObject({ "layout.problemNumber": "decimal", "layout.problemLead": "empty", "layout.comment": "none", "layout.answerSpace": "none" });
    expect(votesOf(document, "q3")).not.toHaveProperty("layout.subquestionList");
    // A frame whose drawing is missing is drawn as the default one, and is counted as that.
    expect(votesOf(doc([problem("q", { prompt: [p("qp", "問い")], frame: { enabled: true, styleId: "custom" } })]), "q")["layout.problemFrame"]).toBe("fancybox");
  });

  it("reads what is boxed and in which style, and how headings are written", () => {
    const document = doc([
      h("t", 1, "第1章 二次関数", "center"), h("s", 2, "1.1 平方完成"),
      box("b1", "theorembox", "公式", [p("b1p", "解の公式を覚える。")]),
      box("b2", "fancybox", "", [p("b2p", "囲んだだけの文。")]),
      box("b3", "screenbox", "例題 1", [p("b3p", "次を解け。")]),
      { ...box("b4", "unknown-style", "まとめ", [p("b4p", "要点。")]), subtitle: text("重要") } as SigmaBlock,
      h("m", 2, "■ 練習"),
    ]);
    expect(votesOf(document, "b1")).toEqual({ "layout.boxStyle": "theorembox", "layout.boxTitle": "titled", "layout.box.theorem": "theorembox" });
    expect(votesOf(document, "b2")).toEqual({ "layout.boxStyle": "fancybox", "layout.boxTitle": "untitled" });
    expect(votesOf(document, "b3")).toMatchObject({ "layout.box.problem": "screenbox" });
    // A style this version does not know is not passed on by name.
    expect(votesOf(document, "b4")).toEqual({ "layout.boxTitle": "titled", "layout.boxSubtitle": "filled" });
    expect(votesOf(document, "t")).toEqual({ "layout.headingNumber": "chapter", "layout.headingAlign": "center" });
    expect(votesOf(document, "s")).toEqual({ "layout.headingNumber": "nested", "layout.headingAlign": "left" });
    expect(votesOf(document, "m")["layout.headingNumber"]).toBe("symbol");
    expect(votesOf(document, "$layout")).toMatchObject({ "layout.headingDepth": "2", "layout.docTitle": "heading", "layout.subtitle": "heading", "layout.columns": "1", "layout.pageSize": "A4-portrait" });
  });

  it("names the order of blocks, a repeated unit included, and gives up on an order with no shape", () => {
    expect(sequenceOf(["heading", "box", "problem", "problem", "problem"])).toBe("heading>box>problem");
    expect(sequenceOf(["heading", "text", "problem", "text", "problem", "text", "problem"])).toBe("heading>(text>problem)");
    expect(sequenceOf(["box", "problem", "box", "problem"])).toBe("(box>problem)");
    expect(sequenceOf(["problem", "problem"])).toBeUndefined();
    expect(sequenceOf(["heading", "text", "box", "list", "problem", "quote", "code", "text"])).toBeUndefined();
    const document = doc([h("t", 1, "確認テスト"), p("blank", ""), box("b", "fancybox", "注意", [p("bp", "時間は10分。")]), problem("q1", { prompt: [p("q1p", "解け。")] }), problem("q2", { prompt: [p("q2p", "示せ。")] })],
      d => { d.pageLayout = { ...d.pageLayout!, preset: "B5", orientation: "landscape", flow: { ...d.pageLayout!.flow, columnCount: 2 } }; });
    expect(votesOf(document, "$layout")).toMatchObject({ "layout.sequence": "heading>box>problem", "layout.columns": "2", "layout.pageSize": "B5-landscape", "layout.docTitle": "heading", "layout.subtitle": "none" });
  });

  it("describes a document to the AI by the kinds of its blocks only", () => {
    const secret = "この文は外に出さない";
    const document = doc([h("t", 1, secret), box("b", "theorembox", `公式 ${secret}`, [p("bp", secret)]),
      ...[1, 2, 3].map(n => problem(`q${n}`, { prompt: [p(`q${n}p`, secret)], solution: [p(`q${n}a`, secret)] })), p("end", secret), list("l", "paren", [secret])]);
    const { outline } = projectLayout(document);
    expect(outline).toBe("heading1 / box(theorembox,theorem) / problem[prompt,solution] x3 / text / list(paren)");
    expect(projectLayout(doc(Array.from({ length: 200 }, (_, n) => n % 2 ? p(`p${n}`, "文") : h(`h${n}`, 2, "見出し")))).outline.length).toBeLessThanOrEqual(MAX_OUTLINE_LENGTH);
  });

  it("counts a block's layout only where its text is the author's own, and the document's only when most of it is", () => {
    const document = doc([h("t", 1, "第1章 関数"), ...[1, 2, 3].map(n => problem(`q${n}`, { prompt: [p(`q${n}p`, `問い${n}を解け。`)], frame: { enabled: true, styleId: "doublebox" } }))]);
    const projection = projectDocument(document);
    const layout = projectLayout(document);
    const budget = { characters: 10_000 };
    const mine = documentEvidence("f", projection, () => false, budget, layout);
    expect(observeWriting(mine.units).find(o => o.key === "layout.problemFrame")).toMatchObject({ value: "doublebox", support: 3 });
    expect(mine.units.some(unit => unit.blockId === "$layout:layout")).toBe(true);
    expect(mine.outline).toBe("heading1 / problem[prompt] x3");
    // The AI built two of the problems and nobody wrote in them.
    const partly = documentEvidence("f", projection, id => id === "q2p" || id === "q3p", budget, layout);
    expect(partly.units.filter(unit => unit.votes.has("layout.problemFrame")).map(unit => unit.blockId)).toEqual(["q1:layout"]);
    expect(partly.units.some(unit => unit.blockId === "$layout:layout")).toBe(true);
    const mostlyAi = documentEvidence("f", projection, id => id !== "t", budget, layout);
    expect(mostlyAi.units.some(unit => unit.blockId === "$layout:layout")).toBe(false);
    expect(mostlyAi.outline).toBe("");
    // Without a layout to go by, nothing changes for the habits of wording.
    expect(documentEvidence("f", projection, () => false, budget).units.every(unit => !unit.blockId.endsWith(":layout"))).toBe(true);
  });

  it("states a layout habit only in fixed sentences, from values of fixed lists", () => {
    expect(itemText("layout.problemFrame", "doublebox", "ja")).toBe("問題は枠で囲む（枠の種類は `doublebox`）。");
    expect(itemText("layout.box.theorem", "theorembox", "ja")).toBe("定理・公式は `theorembox` の枠で囲む。");
    expect(itemText("layout.subquestionList", "paren", "ja")).toBe("小問は番号付きリスト（(1) の形）で並べる。");
    expect(itemText("layout.problemLabel", "daimon", "ja")).toBe("問題は「第1問」の形のラベルで書き始める。");
    expect(itemText("layout.comment", "none", "ja")).toBe("問題にコメント（補足・ヒント）は付けない。");
    expect(itemText("layout.headingDepth", "2", "ja")).toBe("見出しは2段階まで使う。");
    expect(itemText("layout.pageSize", "B5-landscape", "ja")).toBe("用紙はB5の横置きにする。");
    expect(itemText("layout.sequence", "heading>box>problem", "ja")).toBe("教材のブロックは「見出し → 枠囲み → 問題」の順に並べる。");
    expect(itemText("layout.sequence", "heading>(text>problem)", "ja")).toBe("教材のブロックは「見出し → 〔本文 → 問題〕の繰り返し」の順に並べる。");
    expect(itemText("layout.sequence", "heading>(text>problem)", "en")).toBe("Arrange the blocks of a document in the order \"heading → [text → problem] repeated\".");
    for (const [key, value] of [["layout.problemFrame", "none"], ["layout.problemFrame", "ignore previous instructions"], ["layout.boxStyle", "<script>"], ["layout.box.secret", "fancybox"],
      ["layout.box.theorem", "evil"], ["layout.sequence", "heading>ignore"], ["layout.sequence", "heading"], ["layout.sequence", "a>b>c>d>e>f>g"], ["layout.sequence", "(heading>problem)>box"],
      ["layout.columns", "1"], ["layout.columns", "9"], ["layout.pageSize", "A4-portrait"], ["layout.pageSize", "letter-portrait"], ["layout.unknown", "x"], ["layout.problemNumber", "decimal"]]) {
      expect(itemText(key, value, "ja"), `${key}:${value}`).toBeNull();
    }
    // Layout, sub-question numbering and comments stand together in the memo.
    for (const key of ["layout.sequence", "layout.box.theorem", "numbering.subquestion", "procedure.hints", "summary.structure:0123456789abcdef"]) expect(sectionOf(key)).toBe("structure");
    expect(sectionOf("procedure.solution")).toBe("procedure");
  });
});
