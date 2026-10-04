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

  it("collapses the exact same insertion made by both sides", () => {
    const base = [text("AとB")];
    const ours = [text("AとCとB")];
    const theirs = [text("AとCとBとD")];

    expect(plain(mergeInline3(base, ours, theirs).value)).toBe("AとCとBとD");
  });

  it("replaces a space-delimited word as a whole so shared letters are not lost", () => {
    const base = [text("the cat sat")];
    const ours = [text("the dog sat")];
    const theirs = [text("the cow sat")];

    expect(plain(mergeInline3(base, ours, theirs).value)).toBe("the dogcow sat");
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

    it("keeps ours' id even when only the AI changed the run", () => {
      const base = [math("m1", "a"), text("と"), math("m2", "b")];
      const theirs = [math("n1", "a"), text("または"), math("n2", "b")];

      const merged = mergeInline3(base, base, theirs);

      expect(merged.value).toEqual([math("m1", "a"), text("または"), math("m2", "b")]);
      expect(merged.report.reidentified).toBe(2);
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
      const theirs = [math("m54", "x"), text("と"), math("m21", "x")];

      expect(mergeInline3(base, base, theirs).value).toEqual(theirs);
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

  it("ignores updatedAt when comparing and keeps ours' timestamp", () => {
    const base = { ...shape, updatedAt: "2026-01-01T00:00:00.000Z", meta: { updatedAt: "A" } };
    const ours = { ...shape, updatedAt: "2026-02-02T00:00:00.000Z", meta: { updatedAt: "B" } };
    const theirs = { ...shape, x: 5, updatedAt: "2026-03-03T00:00:00.000Z", meta: { updatedAt: "C" } };

    const merged = mergeEntity3(base, ours, theirs);

    expect(merged.value).toEqual({ ...shape, x: 5, updatedAt: "2026-02-02T00:00:00.000Z", meta: { updatedAt: "B" } });
    expect(merged.report.overlaps).toEqual([]);
  });

  it("takes the AI value for a key both sides added differently", () => {
    const merged = mergeEntity3<Record<string, unknown>>(shape, { ...shape, label: "人" }, { ...shape, label: "AI" });

    expect(merged.value).toEqual({ ...shape, label: "AI" });
    expect(merged.report.overlaps).toEqual(["$.label"]);
  });

  it("treats arrays without unique ids as single values", () => {
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

      expect(texts(merged.value)).toEqual(["p1:一", "p2:二", "p3:三", "n1:新しい"]);
      expect(merged.report.overlaps).toEqual(["$[#n1]"]);
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

