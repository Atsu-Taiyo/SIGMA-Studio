import { describe, expect, it } from "vitest";

import { boxCommandToInlineNodes, parseTexBoxCommand } from "@/lib/tex-box-command";

const makeId = (prefix: string) => `${prefix}_test`;

describe("parseTexBoxCommand", () => {
  it("parses a plain shade box", () => {
    expect(parseTexBoxCommand("\\tcolorbox{重要}")).toEqual({
      command: "tcolorbox",
      variant: "shade",
      tone: undefined,
      titleTex: undefined,
      bodyTex: "重要",
    });
  });

  it("reads a tone from a bracket option", () => {
    expect(parseTexBoxCommand("\\tcolorbox[blue]{ポイント}")?.tone).toBe("blue");
  });

  it("reads a tone from a tcolorbox colback key", () => {
    expect(parseTexBoxCommand("\\tcolorbox[colback=red!5!white]{x}")?.tone).toBe("red");
  });

  it("maps frame, thick, double, and oval commands to their variants", () => {
    expect(parseTexBoxCommand("\\fbox{abc}")?.variant).toBe("frame");
    expect(parseTexBoxCommand("\\thickbox{abc}")?.variant).toBe("thick");
    expect(parseTexBoxCommand("\\doublebox{abc}")?.variant).toBe("double");
    expect(parseTexBoxCommand("\\ovalbox{abc}")?.variant).toBe("oval");
  });

  it("defaults shadebox to a grey fill", () => {
    expect(parseTexBoxCommand("\\shadebox{abc}")).toMatchObject({ variant: "shade", tone: "gray" });
  });

  it("splits an itembox into title and body", () => {
    expect(parseTexBoxCommand("\\itembox{タイトル}{本文}")).toMatchObject({
      variant: "shade",
      titleTex: "タイトル",
      bodyTex: "本文",
    });
  });

  it("treats a single-argument itembox as body only", () => {
    expect(parseTexBoxCommand("\\itembox{本文だけ}")).toMatchObject({
      titleTex: undefined,
      bodyTex: "本文だけ",
    });
  });

  it("ignores non-box commands", () => {
    expect(parseTexBoxCommand("\\frac{a}{b}")).toBeNull();
    expect(parseTexBoxCommand("\\sum_{i=1}^n")).toBeNull();
  });

  it("rejects trailing content and unclosed braces", () => {
    expect(parseTexBoxCommand("\\fbox{a}trailing")).toBeNull();
    expect(parseTexBoxCommand("\\fbox{a")).toBeNull();
  });
});

describe("boxCommandToInlineNodes", () => {
  it("wraps body text in a boxed run with the variant", () => {
    const nodes = boxCommandToInlineNodes(parseTexBoxCommand("\\tcolorbox[green]{合格}")!, makeId);
    expect(nodes).toEqual([
      { type: "text", text: "合格", marks: ["boxed"], boxedVariant: "shade", boxedTone: "green" },
    ]);
  });

  it("omits the variant attribute for plain frame boxes", () => {
    const nodes = boxCommandToInlineNodes(parseTexBoxCommand("\\fbox{枠}")!, makeId);
    expect(nodes).toEqual([{ type: "text", text: "枠", marks: ["boxed"] }]);
  });

  it("preserves thick and double frame styles on text and math", () => {
    const thickNodes = boxCommandToInlineNodes(parseTexBoxCommand("\\thickbox{太枠}")!, makeId);
    const doubleNodes = boxCommandToInlineNodes(parseTexBoxCommand("\\doublebox{$x^2$}")!, makeId);

    expect(thickNodes).toEqual([
      { type: "text", text: "太枠", marks: ["boxed"], boxedVariant: "thick" },
    ]);
    expect(doubleNodes).toEqual([
      {
        type: "mathInline",
        id: "math_test",
        tex: "x^2",
        display: "inline",
        marks: ["boxed"],
        boxedVariant: "double",
      },
    ]);
  });

  it("renders an itembox title as a bold lead inside the box", () => {
    const nodes = boxCommandToInlineNodes(parseTexBoxCommand("\\itembox{要点}{まとめ}")!, makeId);
    expect(nodes[0]).toEqual({
      type: "text",
      text: "【要点】",
      marks: ["bold", "boxed"],
      boxedVariant: "shade",
      boxedTone: "gray",
    });
    expect(nodes.at(-1)).toMatchObject({ text: "まとめ", marks: ["boxed"], boxedVariant: "shade" });
  });

  it("keeps inline math inside the box", () => {
    const nodes = boxCommandToInlineNodes(parseTexBoxCommand("\\tcolorbox{$x^2$}")!, makeId);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ type: "mathInline", tex: "x^2", marks: ["boxed"], boxedVariant: "shade" });
  });
});
