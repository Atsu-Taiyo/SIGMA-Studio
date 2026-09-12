import { describe, expect, it } from "vitest";

import { hashSigmaNode } from "./sigma-doc-block-hash";

describe("hashSigmaNode", () => {
  it("objects with different key order hash equal", () => {
    const first = { type: "mathInline", id: "math_1", tex: "x^2", display: "inline" };
    const second = { id: "math_1", type: "mathInline", display: "inline", tex: "x^2" };

    expect(hashSigmaNode(first)).toBe(hashSigmaNode(second));
  });

  it("array reordering changes hash", () => {
    const first = {
      type: "paragraph",
      id: "paragraph_1",
      children: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    };
    const second = {
      type: "paragraph",
      id: "paragraph_1",
      children: [
        { type: "text", text: "second" },
        { type: "text", text: "first" },
      ],
    };

    expect(hashSigmaNode(first)).not.toBe(hashSigmaNode(second));
  });

  it("undefined fields are treated as absent", () => {
    expect(hashSigmaNode({ a: 1 })).toBe(hashSigmaNode({ a: 1, b: undefined }));
  });

  it("regression: 2026-07-16 mathInline key-order incident", () => {
    const beforeRoundTrip = {
      type: "mathInline",
      id: "math_2026_07_16",
      tex: "\\frac{1}{2}",
      display: "inline",
      semanticRole: "fraction",
    };
    const afterRoundTrip = {
      id: "math_2026_07_16",
      type: "mathInline",
      semanticRole: "fraction",
      display: "inline",
      tex: "\\frac{1}{2}",
    };

    expect(hashSigmaNode(beforeRoundTrip)).toBe(hashSigmaNode(afterRoundTrip));
  });

  it("nested structures canonicalize recursively", () => {
    const first = {
      type: "problem",
      id: "problem_1",
      prompt: [{
        type: "list",
        id: "list_1",
        ordered: true,
        items: [{
          id: "item_1",
          children: [
            { type: "text", text: "条件" },
            { type: "mathInline", id: "math_nested", tex: "x>0", display: "inline" },
          ],
        }],
      }],
    };
    const second = {
      id: "problem_1",
      prompt: [{
        ordered: true,
        items: [{
          children: [
            { text: "条件", type: "text" },
            { display: "inline", tex: "x>0", type: "mathInline", id: "math_nested" },
          ],
          id: "item_1",
        }],
        id: "list_1",
        type: "list",
      }],
      type: "problem",
    };

    expect(hashSigmaNode(first)).toBe(hashSigmaNode(second));
  });
});
