import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";

import { InlineMathExtension } from "@/components/tiptap/inline-math-extension";
import { AI_EDIT_LOCK_MAX_ANIMATED_CHARS, collectAiEditLockSpans } from "./edit-lock-adapter";

const schema = getSchema([StarterKit.configure({ undoRedo: false }), InlineMathExtension]);

describe("collectAiEditLockSpans", () => {
  it("splits plain text into one span per character", () => {
    const paragraph = schema.nodes.paragraph.create(null, schema.text("ab"));

    const { charSpans, atomSpans } = collectAiEditLockSpans(paragraph, 0);

    expect(atomSpans).toEqual([]);
    expect(charSpans).toEqual([
      { from: 0, to: 1, charIndex: 0 },
      { from: 1, to: 2, charIndex: 1 },
    ]);
  });

  it("treats a math atom as a single non-splittable span between the surrounding characters", () => {
    const mathNode = schema.nodes.mathInline.create({ id: "m1", tex: "x^2" });
    const paragraph = schema.nodes.paragraph.create(null, [schema.text("a"), mathNode, schema.text("b")]);

    const { charSpans, atomSpans } = collectAiEditLockSpans(paragraph, 0);

    // "a" at content pos 0, the atom at content pos 1 (nodeSize 1), "b" at
    // content pos 2.
    expect(atomSpans).toEqual([{ from: 1, to: 2 }]);
    expect(charSpans.map((span) => [span.from, span.to])).toEqual([[0, 1], [2, 3]]);
    // charIndex keeps advancing across the atom so the trailing text's stagger
    // still reflects its true position in the block.
    expect(charSpans[0].charIndex).toBe(0);
    expect(charSpans[1].charIndex).toBe(2);
  });

  it("caps per-character spans and merges the remainder into one trailing span", () => {
    const longText = "x".repeat(AI_EDIT_LOCK_MAX_ANIMATED_CHARS + 100);
    const paragraph = schema.nodes.paragraph.create(null, schema.text(longText));

    const { charSpans } = collectAiEditLockSpans(paragraph, 0);

    const individual = charSpans.filter((span) => span.charIndex < AI_EDIT_LOCK_MAX_ANIMATED_CHARS);
    const overflow = charSpans.filter((span) => span.charIndex === AI_EDIT_LOCK_MAX_ANIMATED_CHARS);

    expect(individual).toHaveLength(AI_EDIT_LOCK_MAX_ANIMATED_CHARS);
    expect(overflow).toHaveLength(1);
    expect(overflow[0]).toEqual({
      from: AI_EDIT_LOCK_MAX_ANIMATED_CHARS,
      to: longText.length,
      charIndex: AI_EDIT_LOCK_MAX_ANIMATED_CHARS,
    });
  });

  it("returns no spans for an empty block", () => {
    const paragraph = schema.nodes.paragraph.create(null);
    expect(collectAiEditLockSpans(paragraph, 0)).toEqual({ charSpans: [], atomSpans: [] });
  });

  it("shimmers only the selected character offsets", () => {
    const paragraph = schema.nodes.paragraph.create(null, schema.text("abcd"));

    expect(collectAiEditLockSpans(paragraph, 0, [
      { kind: "text", blockId: "p1", from: 1, to: 3 },
    ])).toEqual({
      charSpans: [
        { from: 1, to: 2, charIndex: 0 },
        { from: 2, to: 3, charIndex: 1 },
      ],
      atomSpans: [],
    });
  });

  it("shimmers only the explicitly selected inline math atom", () => {
    const mathNode = schema.nodes.mathInline.create({ id: "m1", tex: "x^2" });
    const paragraph = schema.nodes.paragraph.create(null, [schema.text("a"), mathNode, schema.text("b")]);

    expect(collectAiEditLockSpans(paragraph, 0, [
      { kind: "inlineMath", blockId: "p1", mathInlineId: "m1" },
    ])).toEqual({
      charSpans: [],
      atomSpans: [{ from: 1, to: 2 }],
    });
  });
});
