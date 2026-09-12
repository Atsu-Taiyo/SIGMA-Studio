import { afterEach, describe, expect, it, vi } from "vitest";

import type { InlineNode } from "@/types/sigma-doc";
import { diffArrays, diffInlineNodes, tokenizeInlineNodes } from "./inline-diff";

function text(value: string, extra: Partial<InlineNode> = {}): InlineNode {
  return { type: "text", text: value, ...extra } as InlineNode;
}

function math(tex: string, id: string, extra: Partial<InlineNode> = {}): InlineNode {
  return { type: "mathInline", id, tex, display: "inline", ...extra } as InlineNode;
}

describe("diffInlineNodes", () => {
  it("returns a single unchanged segment on both sides when nothing changed", () => {
    const before: InlineNode[] = [text("変更前")];
    const after: InlineNode[] = [text("変更前")];

    const result = diffInlineNodes(before, after);

    expect(result.changed).toBe(false);
    expect(result.removed).toEqual([{ changed: false, nodes: before }]);
    expect(result.added).toEqual([{ changed: false, nodes: after }]);
  });

  it("highlights only the changed Japanese word, keeping the shared word as context", () => {
    // Intl.Segmenter splits 変更前/変更後 into ["変更","前"]/["変更","後"] — only the
    // suffix differs, so the diff should isolate 前→後 instead of replacing the whole word.
    const result = diffInlineNodes([text("変更前")], [text("変更後")]);

    expect(result.changed).toBe(true);
    expect(result.removed.map((segment) => segment.nodes.map((node) => (node.type === "text" ? node.text : "")).join(""))).toEqual(["変更", "前"]);
    expect(result.removed.map((segment) => segment.changed)).toEqual([false, true]);
    expect(result.added.map((segment) => segment.nodes.map((node) => (node.type === "text" ? node.text : "")).join(""))).toEqual(["変更", "後"]);
    expect(result.added.map((segment) => segment.changed)).toEqual([false, true]);
  });

  it("treats the same formula re-emitted with a new id as unchanged (math tokens ignore id)", () => {
    const result = diffInlineNodes([math("x^2", "math_1")], [math("x^2", "math_2")]);

    expect(result.changed).toBe(false);
  });

  it("flags a formula whose tex actually changed, keeping surrounding text as context", () => {
    const result = diffInlineNodes(
      [text("式は"), math("x^2", "math_1"), text("です")],
      [text("式は"), math("x^3", "math_2"), text("です")],
    );

    expect(result.changed).toBe(true);
    const removedTex = result.removed.find((segment) => segment.nodes.some((node) => node.type === "mathInline"));
    const addedTex = result.added.find((segment) => segment.nodes.some((node) => node.type === "mathInline"));
    expect(removedTex?.changed).toBe(true);
    expect(addedTex?.changed).toBe(true);
    expect((removedTex?.nodes[0] as Extract<InlineNode, { type: "mathInline" }>).tex).toBe("x^2");
    expect((addedTex?.nodes[0] as Extract<InlineNode, { type: "mathInline" }>).tex).toBe("x^3");
  });

  it("tokenizes embedded newlines as their own tokens, independent of surrounding words", () => {
    const tokens = tokenizeInlineNodes([text("1行目\n2行目")]);
    const newlineTokens = tokens.filter((token) => token.kind === "newline");
    expect(newlineTokens).toHaveLength(1);

    const before = [text("1行目\n2行目")];
    const after = [text("1行目\n3行目")];
    const result = diffInlineNodes(before, after);
    expect(result.changed).toBe(true);
    // 共有されている "1行目" と改行はcontextとして残る。
    expect(result.removed.some((segment) => !segment.changed && segment.nodes.some((node) => node.type === "text" && node.text.includes("\n")))).toBe(true);
  });

  it("treats a styling-only change (mark added) as a change, not as identical text", () => {
    const result = diffInlineNodes([text("重要")], [text("重要", { marks: ["bold"] })]);
    expect(result.changed).toBe(true);
  });

  it("falls back to a whitespace/character-class segmentation when Intl.Segmenter is unavailable", () => {
    const original = (Intl as { Segmenter?: unknown }).Segmenter;
    delete (Intl as { Segmenter?: unknown }).Segmenter;
    try {
      const tokens = tokenizeInlineNodes([text("hello world")]);
      const words = tokens.filter((token) => token.kind === "text").map((token) => (token as { text: string }).text);
      expect(words).toContain("hello");
      expect(words).toContain("world");

      const result = diffInlineNodes([text("hello world")], [text("hello there")]);
      expect(result.changed).toBe(true);
    } finally {
      (Intl as { Segmenter?: unknown }).Segmenter = original;
    }
  });
});

describe("diffArrays", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("finds the longest common subsequence for simple arrays", () => {
    const ops = diffArrays(["a", "b", "c"], ["a", "x", "c"], (item) => item);
    expect(ops.map((op) => op.type)).toEqual(["equal", "remove", "add", "equal"]);
  });

  it("falls back to a plain remove-all/add-all when the token cap is exceeded", () => {
    const a = ["a1", "a2", "a3"];
    const b = ["b1", "b2"];
    // cap smaller than a.length*b.length(=6) forces the DP-free fallback path.
    const ops = diffArrays(a, b, (item) => item, 4);
    expect(ops).toEqual([
      { type: "remove", a: "a1" },
      { type: "remove", a: "a2" },
      { type: "remove", a: "a3" },
      { type: "add", b: "b1" },
      { type: "add", b: "b2" },
    ]);
  });

  it("bails out to one changed segment on each side when diffInlineNodes' underlying token count is huge", () => {
    // Build two long, entirely-different token streams so a.length*b.length blows past the cap.
    const words = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}${i}`);
    const ops = diffArrays(words("a", 600), words("b", 600), (item) => item, 250_000);
    expect(ops.every((op) => op.type === "remove" || op.type === "add")).toBe(true);
    expect(ops.filter((op) => op.type === "remove")).toHaveLength(600);
    expect(ops.filter((op) => op.type === "add")).toHaveLength(600);
  });
});
