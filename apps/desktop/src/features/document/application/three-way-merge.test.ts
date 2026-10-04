import { describe, expect, it } from "vitest";

import type { InlineNode, MathInlineNode, ParagraphNode, TextInlineNode } from "../model";
import { mergeEntity3, mergeInline3 } from "./three-way-merge";

function text(value: string, extra: Partial<Omit<TextInlineNode, "type" | "text">> = {}): TextInlineNode {
  return { type: "text", text: value, ...extra };
}

function math(
  id: string,
  tex: string,
  extra: Partial<Omit<MathInlineNode, "type" | "id" | "tex" | "display">> = {},
): MathInlineNode {
  return { type: "mathInline", id, tex, display: "inline", ...extra };
}

function plain(nodes: readonly InlineNode[]): string {
  return nodes.map((node) => node.type === "text" ? node.text : `$${node.tex}$`).join("");
}

function paragraph(id: string, value: string): ParagraphNode {
  return { id, type: "paragraph", children: [text(value)] };
}

function texts(blocks: readonly ParagraphNode[]): string[] {
  return blocks.map((block) => `${block.id}:${plain(block.children)}`);
}

describe("mergeInline3", () => {
  it("returns the side that changed when only one side changed", () => {
    const base = [text("今日は晴れです。")];
    const changed = [text("今日は雨です。")];

    expect(mergeInline3(base, changed, base).value).toEqual(changed);
    expect(mergeInline3(base, base, changed).value).toEqual(changed);
  });

  it("does not apply an identical change twice", () => {
    const base = [text("今日は晴れです。")];
    const changed = [text("今日は雨です。")];

    expect(mergeInline3(base, changed, changed).value).toEqual(changed);
  });

  it("keeps edits to different words from both sides", () => {
    const base = [text("今日は晴れです。明日は雨です。")];
    const ours = [text("今日は快晴です。明日は雨です。")];
    const theirs = [text("今日は晴れです。明日は雪です。")];

    const merged = mergeInline3(base, ours, theirs);

    expect(plain(merged.value)).toBe("今日は快晴です。明日は雪です。");
    expect(merged.report.overlaps).toEqual([]);
  });

  it("orders insertions into the same gap as ours (human) then theirs (AI)", () => {
    const base = [text("りんごを買う")];
    const ours = [text("赤いりんごを買う")];
    const theirs = [text("大きなりんごを買う")];

    const merged = mergeInline3(base, ours, theirs);

    expect(plain(merged.value)).toBe("赤い大きなりんごを買う");
    expect(merged.report.overlaps).toEqual(["$"]);
  });

  it("keeps the human word and then the AI word when both replace the same word", () => {
    const base = [text("犬が走る")];
    const ours = [text("猫が走る")];
    const theirs = [text("鳥が走る")];

    expect(plain(mergeInline3(base, ours, theirs).value)).toBe("猫鳥が走る");
  });

  it("collapses the same insertion even when the other side's edits elsewhere shift its position", () => {
    const merged = mergeInline3(
      [text("関数の最大値を求めよ。")],
      [text("関数の最大値と最小値を求めよ。")],
      [text("関数 f(x) の最大値と最小値を求めよ。")],
    );

    expect(plain(merged.value)).toBe("関数 f(x) の最大値と最小値を求めよ。");
    expect(plain(mergeInline3([text("the mat")], [text("the soft mat")], [text("on the soft mat")]).value))
      .toBe("on the soft mat");
    expect(plain(mergeInline3([text("the mat")], [text("on the soft mat")], [text("the soft mat")]).value))
      .toBe("on the soft mat");
  });

  it("deletes a repeated character once when one side's deletion is glued to another edit", () => {
    expect(plain(mergeInline3([text("1000円")], [text("100円")], [text("100")]).value)).toBe("100");
    expect(plain(mergeInline3([text("1000円")], [text("100")], [text("100円")]).value)).toBe("100");
    expect(plain(mergeInline3([text("the the cat")], [text("the cat")], [text("the dog")]).value)).toBe("the dog");
    expect(plain(mergeInline3([text("ありがとうう。")], [text("ありがとう。")], [text("ありがとう!")]).value))
      .toBe("ありがとう!");
  });

  it("deletes a repeated character once when both sides deleted the same one", () => {
    expect(plain(mergeInline3([text("ああいう")], [text("あいう")], [text("Xあいう")]).value)).toBe("Xあいう");
  });

  it("keeps text both sides inserted once when one side added more right next to it", () => {
    expect(plain(mergeInline3([text("答え: 。")], [text("答え: 12。")], [text("答え: 12 です。")]).value))
      .toBe("答え: 12 です。");
    expect(plain(mergeInline3([text("答え: 。")], [text("答え: およそ12。")], [text("答え: 12。")]).value))
      .toBe("答え: およそ12。");
  });

  it("collapses the exact same insertion made by both sides", () => {
    const base = [text("AとB")];
    const ours = [text("AとCとB")];
    const theirs = [text("AとCとBとD")];

    expect(plain(mergeInline3(base, ours, theirs).value)).toBe("AとCとBとD");
  });

  it("merges both replacements of one word character by character (CRDT style)", () => {
    const base = [text("the cat sat")];
    const ours = [text("the dog sat")];
    const theirs = [text("the cow sat")];

    // The AI kept the "c"; the human deleted it. Deletions win, insertions are all kept.
    expect(plain(mergeInline3(base, ours, theirs).value)).toBe("the dogow sat");
  });

  it("keeps fixes to different characters of one word from both sides", () => {
    expect(plain(mergeInline3([text("x 1234567 y")], [text("x 1934567 y")], [text("x 1234587 y")]).value))
      .toBe("x 1934587 y");
    expect(plain(mergeInline3([text("colour")], [text("color")], [text("colours")]).value)).toBe("colors");
  });

  it("keeps an insertion before a word together with a fix inside that word", () => {
    const base = [text("the cat sat")];
    const ours = [text("the cot sat")];
    const theirs = [text("the big cat sat")];

    expect(plain(mergeInline3(base, ours, theirs).value)).toBe("the big cot sat");
  });

  it("keeps the human's appended letters when the AI replaced the word", () => {
    const base = [text("I run fast")];
    const ours = [text("I running fast")];
    const theirs = [text("I walk fast")];

    expect(plain(mergeInline3(base, ours, theirs).value)).toBe("I walkning fast");
  });

  it("keeps word edits on both sides of a sentence", () => {
    const base = [text("the quick brown fox")];
    const ours = [text("the quick black fox")];
    const theirs = [text("the slow brown fox")];

    expect(plain(mergeInline3(base, ours, theirs).value)).toBe("the slow black fox");
  });

  describe("diff size cap", () => {
    const base = [text("一二三四五六")];
    const ours = [text("一甲三乙五六")];
    const theirs = [text("一二参四五六")];

    it("reports the cap and falls back to replacing the differing span without losing either side", () => {
      const merged = mergeInline3(base, ours, theirs, { maxEditDistance: 2 });

      expect(merged.report.capped).toBe(true);
      expect(merged.report.cappedPaths).toEqual(["$"]);
      expect(plain(merged.value)).toBe("一甲三乙参五六");
    });

    it("aligns whole nodes instead of characters in a huge run, and reports the cap", () => {
      const huge = "あ".repeat(60_000);
      const merged = mergeInline3([text(huge)], [text(`${huge}人`)], [text(`AI${huge}`)]);

      expect(merged.report.capped).toBe(true);
      expect(merged.report.cappedPaths).toEqual(["$"]);
      expect(plain(merged.value)).toBe(`${huge}人AI${huge}`);
    });

    it("does not report the cap for a huge run only the AI changed", () => {
      const huge = "あ".repeat(60_000);
      const theirs = [text(`AI${huge}`)];

      const merged = mergeInline3([text(huge)], [text(huge)], theirs);

      expect(merged.report.capped).toBe(false);
      expect(merged.value).toEqual(theirs);
    });

    it("returns a long AI rewrite of a run the human did not touch without the cap", () => {
      const original = [text("あいうえお".repeat(600))];
      const rewritten = [text("かきくけこ".repeat(600))];

      const merged = mergeInline3(original, original, rewritten);

      expect(merged.report.capped).toBe(false);
      expect(merged.value).toEqual(rewritten);
    });

    it("reports the cap when the length difference alone exceeds the edit distance bound", () => {
      const merged = mergeInline3([text("一二三四")], [text("一甲乙丙丁戊四")], [text("一二三四五")], { maxEditDistance: 2 });

      expect(merged.report.capped).toBe(true);
      expect(plain(merged.value)).toBe("一甲乙丙丁戊四五");
    });

    it("does not report the cap for an ordinary edit", () => {
      const merged = mergeInline3(base, ours, theirs);

      expect(merged.report.capped).toBe(false);
      expect(merged.report.cappedPaths).toEqual([]);
      expect(plain(merged.value)).toBe("一甲参乙五六");
    });
  });

  describe("inline math", () => {
    it("keeps ours' id when the AI re-emitted the same formula under a new id", () => {
      const base = [text("x="), math("m1", "a^2"), text("です")];
      const ours = [text("x="), math("m1", "a^2"), text("でした")];
      const theirs = [text("y="), math("m9", "a^2"), text("です")];

      const merged = mergeInline3(base, ours, theirs);

      expect(merged.value).toEqual([text("y="), math("m1", "a^2"), text("でした")]);
      expect(merged.report.reidentified).toBe(1);
    });

    it("returns the AI run as it is when the human did not touch it", () => {
      const base = [math("m1", "a"), text("と"), math("m2", "b")];
      const theirs = [math("n1", "a"), text("または"), math("n2", "b")];

      const merged = mergeInline3(base, base, theirs);

      expect(merged.value).toEqual(theirs);
      expect(merged.report.reidentified).toBe(0);
    });

    it("collapses the same formula inserted by both sides and keeps ours' id", () => {
      const base = [text("答えは。")];
      const ours = [text("答えは"), math("h1", "42"), text("。")];
      const theirs = [text("答えは"), math("a1", "42"), text("。です")];

      const merged = mergeInline3(base, ours, theirs);

      expect(merged.value).toEqual([text("答えは"), math("h1", "42"), text("。です")]);
      expect(merged.report.reidentified).toBe(1);
    });

    it("pairs a formula with the same id before pairing it by TeX, so no id is emitted twice", () => {
      const base = [math("m21", "x")];
      const ours = [math("m21", "x"), text("です")];
      const theirs = [math("m54", "x"), text("と"), math("m21", "x")];

      expect(mergeInline3(base, ours, theirs).value).toEqual([
        math("m54", "x"),
        text("と"),
        math("m21", "x"),
        text("です"),
      ]);
    });

    it("keeps a formula the human repeated exactly as often as the human wrote it", () => {
      const base = [math("m1", "x"), text("は正")];
      const ours = [math("h0", "x"), text("と"), math("m1", "x"), text("は正")];
      const theirs = [math("n1", "x"), text("は正です")];

      expect(mergeInline3(base, ours, theirs).value).toEqual([
        math("h0", "x"),
        text("と"),
        math("m1", "x"),
        text("は正です"),
      ]);
    });

    it("leaves formula ids that the input already repeated untouched", () => {
      const base = [math("f1", "x"), text("と"), math("f1", "x")];
      const theirs = [math("f1", "x"), text("または"), math("f1", "x")];

      const merged = mergeInline3(base, base, theirs);

      expect(merged.value).toEqual(theirs);
      expect(merged.report.reidentified).toBe(0);
    });

    it("renames the AI copy when both sides rewrote the same formula under its id", () => {
      const base = [math("m1", "x")];
      const ours = [math("m1", "x^2")];
      const theirs = [math("m1", "x^3")];

      const merged = mergeInline3(base, ours, theirs);

      expect(merged.value).toEqual([math("m1", "x^2"), math("m1-2", "x^3")]);
      expect(merged.report.reidentified).toBe(1);
    });

    it("merges formula styling key by key instead of duplicating the formula", () => {
      const base = [math("m1", "x")];
      const ours = [math("m1", "x", { color: "#0000ff" })];
      const theirs = [math("m7", "x", { fontSize: 20 })];

      expect(mergeInline3(base, ours, theirs).value).toEqual([math("m1", "x", { color: "#0000ff", fontSize: 20 })]);
    });
  });

  it("orders insertions into an empty run as ours then theirs", () => {
    expect(mergeInline3([], [text("人")], [text("AI")]).value).toEqual([text("人AI")]);
    expect(mergeInline3([], [], []).value).toEqual([]);
  });

  describe("formatting (one character x one key)", () => {
    it("keeps the human bold next to the AI wording change", () => {
      const base = [text("重要な点はここです")];
      const ours = [text("重要", { marks: ["bold"] }), text("な点はここです")];
      const theirs = [text("重要な点はそこです")];

      const merged = mergeInline3(base, ours, theirs);

      expect(merged.value).toEqual([text("重要", { marks: ["bold"] }), text("な点はそこです")]);
      expect(merged.report.overlaps).toEqual([]);
    });

    it("keeps the AI formatting on text the human only reworded elsewhere", () => {
      const base = [text("重要な点はここです")];
      const ours = [text("重要な点はそこです")];
      const theirs = [text("重要", { color: "#ff0000" }), text("な点はここです")];

      expect(mergeInline3(base, ours, theirs).value).toEqual([
        text("重要", { color: "#ff0000" }),
        text("な点はそこです"),
      ]);
    });

    it("combines different keys and marks changed on the same characters", () => {
      const base = [text("重要")];
      const ours = [text("重要", { marks: ["bold"], color: "#0000ff" })];
      const theirs = [text("重要", { marks: ["italic"], fontSize: 14 })];

      const merged = mergeInline3(base, ours, theirs);

      expect(merged.value).toEqual([text("重要", { marks: ["bold", "italic"], color: "#0000ff", fontSize: 14 })]);
      expect(merged.report.overlaps).toEqual([]);
    });

    it("drops a mark each side removed even when they removed different marks", () => {
      const base = [text("重要", { marks: ["bold", "italic"] })];
      const ours = [text("重要", { marks: ["bold"] })];
      const theirs = [text("重要", { marks: ["italic"] })];

      expect(mergeInline3(base, ours, theirs).value).toEqual([text("重要")]);
    });

    it("takes the AI value when both sides set the same key differently", () => {
      const base = [text("重要です")];
      const ours = [text("重要", { color: "#0000ff" }), text("です")];
      const theirs = [text("重要", { color: "#ff0000" }), text("です")];

      const merged = mergeInline3(base, ours, theirs);

      expect(merged.value).toEqual([text("重要", { color: "#ff0000" }), text("です")]);
      expect(merged.report.overlaps).toEqual(["$"]);
    });
  });
});

describe("mergeEntity3", () => {
  const shape = { id: "s1", type: "rect", x: 0, y: 0, style: { fill: "#ffffff", stroke: "#000000" } };

  it("takes each value from the side that changed it", () => {
    const ours = { ...shape, x: 10, style: { ...shape.style, stroke: "#333333" } };
    const theirs = { ...shape, y: 20, style: { ...shape.style, fill: "#eeeeee" } };

    const merged = mergeEntity3(shape, ours, theirs);

    expect(merged.value).toEqual({ ...shape, x: 10, y: 20, style: { fill: "#eeeeee", stroke: "#333333" } });
    expect(merged.report.overlaps).toEqual([]);
  });

  it("takes the AI value where both sides changed the same value, and reports the path", () => {
    const ours = { ...shape, style: { ...shape.style, fill: "#ff0000" } };
    const theirs = { ...shape, style: { ...shape.style, fill: "#00ff00" } };

    const merged = mergeEntity3(shape, ours, theirs);

    expect(merged.value).toEqual(theirs);
    expect(merged.report.overlaps).toEqual(["$.style.fill"]);
  });

  it("removes a key one side removed and adds a key one side added", () => {
    const base: Record<string, unknown> = { ...shape, label: "A" };
    const ours: Record<string, unknown> = { ...shape };
    const theirs: Record<string, unknown> = { ...shape, label: "A", rotation: 90 };

    expect(mergeEntity3(base, ours, theirs).value).toEqual({ ...shape, rotation: 90 });
  });

  it("ignores updatedAt when comparing and keeps ours' timestamp when keys are merged", () => {
    const base = { ...shape, updatedAt: "2026-01-01T00:00:00.000Z", meta: { updatedAt: "A", note: "n" } };
    const ours = { ...shape, y: 7, updatedAt: "2026-02-02T00:00:00.000Z", meta: { updatedAt: "B", note: "n" } };
    const theirs = { ...shape, x: 5, updatedAt: "2026-03-03T00:00:00.000Z", meta: { updatedAt: "C", note: "n" } };

    const merged = mergeEntity3(base, ours, theirs);

    expect(merged.value).toEqual({
      ...shape,
      x: 5,
      y: 7,
      updatedAt: "2026-02-02T00:00:00.000Z",
      meta: { updatedAt: "B", note: "n" },
    });
    expect(merged.report.overlaps).toEqual([]);
  });

  it("returns the AI entity as it is when the human changed only timestamps", () => {
    const base = { ...shape, updatedAt: "A" };
    const ours = { ...shape, updatedAt: "B" };
    const theirs = { ...shape, x: 5, updatedAt: "C" };

    expect(mergeEntity3(base, ours, theirs).value).toEqual(theirs);
  });

  it("returns a long AI rewrite of a paragraph the human did not touch without the cap", () => {
    const original = paragraph("p1", "あいうえお".repeat(600));
    const rewritten = paragraph("p1", "かきくけこ".repeat(600));

    const merged = mergeEntity3(original, original, rewritten);

    expect(merged.report.capped).toBe(false);
    expect(merged.value).toEqual(rewritten);
  });

  it("merges keys both sides added under a key base did not have", () => {
    const base: Record<string, unknown> = { id: "doc" };
    const ours = {
      id: "doc",
      pageLayout: { overlay: { shapes: [{ id: "human", type: "rect" }] } },
      comments: [{ id: "c-human" }],
    };
    const theirs = {
      id: "doc",
      pageLayout: { overlay: { shapes: [{ id: "ai", type: "image" }] } },
      comments: [{ id: "c-ai" }],
    };

    const merged = mergeEntity3(base, ours, theirs);

    expect(merged.value).toEqual({
      id: "doc",
      pageLayout: { overlay: { shapes: [{ id: "human", type: "rect" }, { id: "ai", type: "image" }] } },
      comments: [{ id: "c-human" }, { id: "c-ai" }],
    });
    expect(merged.report.overlaps).toEqual([]);
  });

  describe("a node whose type changed", () => {
    const base = paragraph("p1", "項目");
    const edited = paragraph("p1", "項目です");
    const list = { id: "p1", type: "list", listType: "bullet", items: [{ id: "i1", type: "listItem", children: [text("項目")] }] };
    const heading = { id: "p1", type: "heading", level: 2, children: [text("項目")] };

    it("takes the AI node as it is when only the AI changed the type", () => {
      const merged = mergeEntity3<object>(base, edited, list);

      expect(merged.value).toEqual(list);
      expect(merged.report.overlaps).toEqual(["$"]);
    });

    it("takes the human node as it is when only the human changed the type", () => {
      const merged = mergeEntity3<object>(base, list, edited);

      expect(merged.value).toEqual(list);
      expect(merged.report.overlaps).toEqual(["$"]);
    });

    it("merges a changed kind like any other setting", () => {
      const line = { id: "l1", type: "line", props: { kind: "polyline", color: "#000000", points: [0, 0, 10, 10] } };
      const curved = { ...line, props: { ...line.props, kind: "curve" } };
      const recolored = { ...line, props: { ...line.props, color: "#ff0000", points: [0, 0, 20, 20] } };

      const merged = mergeEntity3<object>(line, curved, recolored);

      expect(merged.value).toEqual({ ...line, props: { kind: "curve", color: "#ff0000", points: [0, 0, 20, 20] } });
      expect(merged.report.overlaps).toEqual([]);
    });

    it("takes the AI node when both sides changed the type differently", () => {
      const merged = mergeEntity3<object>(base, heading, list);

      expect(merged.value).toEqual(list);
      expect(merged.report.overlaps).toEqual(["$"]);
    });
  });

  it("keeps a value one side edited while the other side removed its key", () => {
    const box = { id: "b1", type: "box", title: "導入", blocks: [] };
    const untitled = { id: "b1", type: "box", blocks: [] };

    const humanEdited = mergeEntity3<Record<string, unknown>>(box, { ...box, title: "はじめに" }, untitled);
    expect(humanEdited.value).toEqual({ ...box, title: "はじめに" });
    expect(humanEdited.report.editBeatsDelete).toEqual(["$.title"]);

    const aiEdited = mergeEntity3<Record<string, unknown>>(box, untitled, { ...box, title: "まとめ" });
    expect(aiEdited.value).toEqual({ ...box, title: "まとめ" });
    expect(aiEdited.report.editBeatsDelete).toEqual(["$.title"]);
  });

  it("removes a key one side removed when the other side left it unchanged or removed it too", () => {
    const box = { id: "b1", type: "box", title: "導入", label: "A", blocks: [] };
    const merged = mergeEntity3<Record<string, unknown>>(
      box,
      { id: "b1", type: "box", label: "B", blocks: [] },
      { id: "b1", type: "box", blocks: [] },
    );

    expect(merged.value).toEqual({ id: "b1", type: "box", label: "B", blocks: [] });
    expect(merged.report.editBeatsDelete).toEqual(["$.label"]);
  });

  it("keeps both inline titles added under a key base did not have", () => {
    const box = { id: "b1", type: "box", blocks: [] };
    const merged = mergeEntity3<Record<string, unknown>>(
      box,
      { ...box, title: [text("Intro")] },
      { ...box, title: [text("Summary")] },
    );

    expect(merged.value).toEqual({ ...box, title: [text("IntroSummary")] });
    expect(merged.report.overlaps).toEqual(["$.title"]);
  });

  it("takes the AI string for a plain string key both sides added differently", () => {
    const box = { id: "b1", type: "box", blocks: [] };
    const merged = mergeEntity3<Record<string, unknown>>(box, { ...box, title: "Intro" }, { ...box, title: "Summary" });

    expect(merged.value).toEqual({ ...box, title: "Summary" });
    expect(merged.report.overlaps).toEqual(["$.title"]);
  });

  it("takes the AI value for a key both sides added differently", () => {
    const merged = mergeEntity3<Record<string, unknown>>(shape, { ...shape, label: "人" }, { ...shape, label: "AI" });

    expect(merged.value).toEqual({ ...shape, label: "AI" });
    expect(merged.report.overlaps).toEqual(["$.label"]);
  });

  it("merges equal-length arrays without ids element by element when the changed indexes differ", () => {
    const base = { tags: ["a", "b", "c"], lineOverrides: [{ width: 1 }, { width: 1 }] };
    const ours = { tags: ["x", "b", "c"], lineOverrides: [{ width: 2 }, { width: 1 }] };
    const theirs = { tags: ["a", "b", "z"], lineOverrides: [{ width: 1 }, { width: 3 }] };

    const merged = mergeEntity3(base, ours, theirs);

    expect(merged.value).toEqual({ tags: ["x", "b", "z"], lineOverrides: [{ width: 2 }, { width: 3 }] });
    expect(merged.report.overlaps).toEqual([]);
  });

  it("takes the AI array whole when both sides changed an overlapping index", () => {
    const merged = mergeEntity3({ columnStartIds: ["a", "b"] }, { columnStartIds: ["b", "a"] }, { columnStartIds: ["a", "c"] });

    expect(merged.value).toEqual({ columnStartIds: ["a", "c"] });
    expect(merged.report.overlaps).toEqual(["$.columnStartIds"]);
  });

  it("treats arrays without unique ids of different lengths as single values", () => {
    const base = { tags: ["a", "b"], points: [{ id: "x" }, { id: "x" }] };
    const ours = { tags: ["a", "b", "c"], points: [{ id: "x" }] };
    const theirs = { tags: ["b"], points: [{ id: "x" }, { id: "x" }, { id: "y" }] };

    const merged = mergeEntity3(base, ours, theirs);

    expect(merged.value).toEqual(theirs);
    expect(merged.report.overlaps).toEqual(["$.tags", "$.points"]);
  });

  it("merges inline runs character by character", () => {
    const base = paragraph("p1", "今日は晴れです。明日は雨です。");
    const ours = paragraph("p1", "今日は快晴です。明日は雨です。");
    const theirs = { ...paragraph("p1", "今日は晴れです。明日は雪です。"), align: "center" as const };

    expect(mergeEntity3(base, ours, theirs).value).toEqual({
      ...paragraph("p1", "今日は快晴です。明日は雪です。"),
      align: "center",
    });
  });

  it("reports an inline overlap at the inline run's path", () => {
    const base = paragraph("p1", "犬が走る");
    const ours = paragraph("p1", "猫が走る");
    const theirs = paragraph("p1", "鳥が走る");

    expect(mergeEntity3(base, ours, theirs).report.overlaps).toEqual(["$.children"]);
  });

  describe("arrays of identified elements", () => {
    const base = [paragraph("p1", "一"), paragraph("p2", "二"), paragraph("p3", "三")];

    it("keeps edits, insertions and deletions of different elements from both sides", () => {
      const ours = [paragraph("p1", "壱"), paragraph("p2", "二"), paragraph("p4", "四"), paragraph("p3", "三")];
      const theirs = [paragraph("p1", "一"), paragraph("p3", "参")];

      const merged = mergeEntity3(base, ours, theirs);

      expect(texts(merged.value)).toEqual(["p1:壱", "p4:四", "p3:参"]);
      expect(merged.report.overlaps).toEqual([]);
      expect(merged.report.editBeatsDelete).toEqual([]);
    });

    it("orders insertions after the same element as ours (human) then theirs (AI)", () => {
      const ours = [paragraph("p1", "一"), paragraph("h1", "人"), paragraph("p2", "二"), paragraph("p3", "三")];
      const theirs = [paragraph("p1", "一"), paragraph("a1", "AI"), paragraph("p2", "二"), paragraph("p3", "三")];

      expect(texts(mergeEntity3(base, ours, theirs).value)).toEqual(["p1:一", "h1:人", "a1:AI", "p2:二", "p3:三"]);
    });

    it("keeps an element one side edited while the other side deleted it", () => {
      const ours = [paragraph("p1", "一"), paragraph("p2", "弐"), paragraph("p3", "三")];
      const theirs = [paragraph("p1", "一"), paragraph("p3", "三")];

      const merged = mergeEntity3(base, ours, theirs);

      expect(texts(merged.value)).toEqual(["p1:一", "p2:弐", "p3:三"]);
      expect(merged.report.editBeatsDelete).toEqual(["$[#p2]"]);
    });

    it("does not count a timestamp-only difference as an edit that beats a deletion", () => {
      const stamped = base.map((block) => ({ ...block, updatedAt: "A" }));
      const ours = [stamped[0], { ...stamped[1], updatedAt: "B" }, stamped[2]];
      const theirs = [stamped[0], stamped[2]];

      const merged = mergeEntity3(stamped, ours, theirs);

      expect(merged.value.map((block) => block.id)).toEqual(["p1", "p3"]);
      expect(merged.report.editBeatsDelete).toEqual([]);
    });

    it("keeps an element the AI edited while the human deleted it", () => {
      const ours = [paragraph("p1", "一"), paragraph("p3", "三")];
      const theirs = [paragraph("p1", "一"), paragraph("p2", "弐"), paragraph("p3", "三")];

      const merged = mergeEntity3(base, ours, theirs);

      expect(texts(merged.value)).toEqual(["p1:一", "p2:弐", "p3:三"]);
      expect(merged.report.editBeatsDelete).toEqual(["$[#p2]"]);
    });

    it("follows the side that reordered and keeps the other side's edits", () => {
      const ours = [paragraph("p1", "壱"), paragraph("p2", "二"), paragraph("p3", "三")];
      const theirs = [paragraph("p3", "三"), paragraph("p1", "一"), paragraph("p2", "二")];

      expect(texts(mergeEntity3(base, ours, theirs).value)).toEqual(["p3:三", "p1:壱", "p2:二"]);
    });

    it("follows the human order when only the human reordered", () => {
      const ours = [paragraph("p2", "二"), paragraph("p1", "一"), paragraph("p3", "三")];
      const theirs = [paragraph("p1", "一"), paragraph("p2", "弐"), paragraph("p3", "三")];

      expect(texts(mergeEntity3(base, ours, theirs).value)).toEqual(["p2:弐", "p1:一", "p3:三"]);
    });

    it("does not report an overlap when both sides made the same reorder", () => {
      const reordered = [paragraph("p3", "三"), paragraph("p1", "一"), paragraph("p2", "二")];

      const merged = mergeEntity3(base, reordered, [...reordered, paragraph("n1", "新")]);

      expect(texts(merged.value)).toEqual(["p3:三", "p1:一", "p2:二", "n1:新"]);
      expect(merged.report.overlaps).toEqual([]);
    });

    it("places an element kept by edit-beats-delete after its base predecessor in the new order", () => {
      const ours = [paragraph("p1", "一"), paragraph("p2", "弐"), paragraph("p3", "三")];
      const theirs = [paragraph("p3", "三"), paragraph("p1", "一")];

      expect(texts(mergeEntity3(base, ours, theirs).value)).toEqual(["p3:三", "p1:一", "p2:弐"]);
    });

    it("places a kept element without a base predecessor first in the new order", () => {
      const ours = [paragraph("p1", "壱"), paragraph("p2", "二"), paragraph("p3", "三")];
      const theirs = [paragraph("p3", "三"), paragraph("p2", "二")];

      expect(texts(mergeEntity3(base, ours, theirs).value)).toEqual(["p1:壱", "p3:三", "p2:二"]);
    });

    it("takes the AI order when both sides reordered differently", () => {
      const ours = [paragraph("p2", "二"), paragraph("p1", "一"), paragraph("p3", "三")];
      const theirs = [paragraph("p3", "三"), paragraph("p1", "一"), paragraph("p2", "二")];

      const merged = mergeEntity3(base, ours, theirs);

      expect(texts(merged.value)).toEqual(["p3:三", "p1:一", "p2:二"]);
      expect(merged.report.overlaps).toEqual(["$"]);
    });

    it("emits an element both sides inserted under the same id once", () => {
      const ours = [...base, paragraph("n1", "新")];
      const theirs = [...base, paragraph("n1", "新しい")];

      const merged = mergeEntity3(base, ours, theirs);

      // The element is merged against an empty one: its inline run keeps both texts, and the text
      // they share ("新") once.
      expect(texts(merged.value)).toEqual(["p1:一", "p2:二", "p3:三", "n1:新しい"]);
      expect(merged.report.overlaps).toEqual(["$[#n1].children"]);
    });

    it("renames a formula id the merge repeated across runs on the AI side", () => {
      const withFormula = (id: string, value: string, formula: MathInlineNode) => ({
        id,
        type: "paragraph" as const,
        children: [text(value), formula],
      });
      const merged = mergeEntity3<ParagraphNode[]>(
        [paragraph("p1", "一")],
        [withFormula("p0", "人", math("n1", "x")), paragraph("p1", "一")],
        [paragraph("p1", "一"), withFormula("p9", "AI", math("n1", "y"))],
      );

      expect(merged.value).toEqual([
        withFormula("p0", "人", math("n1", "x")),
        paragraph("p1", "一"),
        withFormula("p9", "AI", math("n1-2", "y")),
      ]);
      expect(merged.report.reidentified).toBe(1);
    });

    it("does not list ids the inputs already held in more than one place", () => {
      const problem = (lead: string, prompt: string) => ({
        id: "q1",
        type: "problem",
        lead: [paragraph("x", lead)],
        prompt: [paragraph("x", prompt)],
      });

      const merged = mergeEntity3(problem("導入", "問い"), problem("導入です", "問い"), problem("導入", "問いです"));

      expect(texts(merged.value.lead)).toEqual(["x:導入です"]);
      expect(texts(merged.value.prompt)).toEqual(["x:問いです"]);
      expect(merged.report.duplicateIds).toEqual([]);
    });

    it("lists ids that the merged result holds in more than one place", () => {
      const box = { id: "box", type: "box", blocks: [paragraph("p1", "一")] };
      const merged = mergeEntity3<Array<{ id: string }>>(
        base,
        [paragraph("p1", "壱"), paragraph("p2", "二"), paragraph("p3", "三")],
        [box, paragraph("p2", "二"), paragraph("p3", "三")],
      );

      expect(merged.value.map((element) => element.id)).toEqual(["box", "p1", "p2", "p3"]);
      expect(merged.report.duplicateIds).toEqual(["p1"]);
    });

    it("merges nested identified arrays and inline runs inside them", () => {
      const problem = (prompt: ParagraphNode[]) => ({ id: "q1", type: "problem", prompt });
      const merged = mergeEntity3(
        problem([paragraph("a", "問一"), paragraph("b", "問二")]),
        problem([paragraph("a", "問一だ"), paragraph("b", "問二")]),
        problem([paragraph("a", "問一"), paragraph("b", "設問二"), paragraph("c", "問三")]),
      );

      expect(texts(merged.value.prompt)).toEqual(["a:問一だ", "b:設問二", "c:問三"]);
    });
  });
});

