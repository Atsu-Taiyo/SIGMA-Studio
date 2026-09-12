import { describe, expect, it } from "vitest";

import type { InlineNode } from "@/features/document";

import { listMarkerRunsFromInlineNodes, resolveListMarkerTypography } from "./list-marker-typography";

describe("resolveListMarkerTypography", () => {
  it("先頭 run の書体と大きさを両方採る", () => {
    expect(resolveListMarkerTypography([
      { kind: "text", hasGlyph: true, fontFamily: '"Yu Mincho", serif', fontSizePt: 18 },
      { kind: "text", hasGlyph: true, fontFamily: '"Yu Gothic", sans-serif', fontSizePt: 9 },
    ])).toEqual({ fontFamily: '"Yu Mincho", serif', fontSizePt: 18 });
  });

  it("グリフを生まない run は飛ばして次の run を見る", () => {
    expect(resolveListMarkerTypography([
      { kind: "text", hasGlyph: false, fontFamily: '"Yu Gothic", sans-serif', fontSizePt: 9 },
      { kind: "text", hasGlyph: true, fontFamily: '"Yu Mincho", serif', fontSizePt: 18 },
    ])).toEqual({ fontFamily: '"Yu Mincho", serif', fontSizePt: 18 });
  });

  it("先頭が数式なら大きさだけ採り書体は採らない", () => {
    expect(resolveListMarkerTypography([
      { kind: "math", hasGlyph: true, fontFamily: '"Yu Mincho", serif', fontSizePt: 18 },
    ])).toEqual({ fontSizePt: 18 });
  });

  it("先頭 run に指定が無ければ 2 番目の run の指定を拾わない", () => {
    expect(resolveListMarkerTypography([
      { kind: "text", hasGlyph: true },
      { kind: "text", hasGlyph: true, fontFamily: '"Yu Mincho", serif', fontSizePt: 18 },
    ])).toBeUndefined();
  });

  it("グリフを生む run が 1 つも無ければ何も返さない", () => {
    expect(resolveListMarkerTypography([{ kind: "text", hasGlyph: false }])).toBeUndefined();
    expect(resolveListMarkerTypography([])).toBeUndefined();
  });

  it("大きさだけ・書体だけの指定はその片方だけ返す", () => {
    expect(resolveListMarkerTypography([{ kind: "text", hasGlyph: true, fontSizePt: 18 }]))
      .toEqual({ fontSizePt: 18 });
    expect(resolveListMarkerTypography([{ kind: "text", hasGlyph: true, fontFamily: "serif" }]))
      .toEqual({ fontFamily: "serif" });
  });

  it("有限でない・0 以下の大きさは捨てる", () => {
    expect(resolveListMarkerTypography([{ kind: "text", hasGlyph: true, fontSizePt: 0 }])).toBeUndefined();
    expect(resolveListMarkerTypography([{ kind: "text", hasGlyph: true, fontSizePt: -4 }])).toBeUndefined();
    expect(resolveListMarkerTypography([{ kind: "text", hasGlyph: true, fontSizePt: Number.NaN }])).toBeUndefined();
    expect(resolveListMarkerTypography([{ kind: "text", hasGlyph: true, fontSizePt: Number.POSITIVE_INFINITY }]))
      .toBeUndefined();
  });

  it("空文字の書体は捨てる", () => {
    expect(resolveListMarkerTypography([{ kind: "text", hasGlyph: true, fontFamily: "" }])).toBeUndefined();
  });
});

describe("listMarkerRunsFromInlineNodes", () => {
  it("空文字のテキストノードはグリフを生まない run として写す", () => {
    const children: InlineNode[] = [
      { type: "text", text: "", fontFamily: '"Yu Gothic", sans-serif' },
      { type: "text", text: "いち", fontFamily: '"Yu Mincho", serif', fontSize: 18 },
    ];

    expect(listMarkerRunsFromInlineNodes(children)).toEqual([
      { kind: "text", hasGlyph: false, fontFamily: '"Yu Gothic", sans-serif', fontSizePt: undefined, color: undefined, bold: false, italic: false },
      { kind: "text", hasGlyph: true, fontFamily: '"Yu Mincho", serif', fontSizePt: 18, color: undefined, bold: false, italic: false },
    ]);
  });

  it("改行だけの run はグリフを生まない (編集面では hardBreak になり先頭 run が食い違うため)", () => {
    const children: InlineNode[] = [
      { type: "text", text: "\n", fontFamily: '"Yu Gothic", sans-serif' },
      { type: "text", text: "いち", fontFamily: '"Yu Mincho", serif' },
    ];

    expect(resolveListMarkerTypography(listMarkerRunsFromInlineNodes(children)))
      .toEqual({ fontFamily: '"Yu Mincho", serif' });
  });

  it("改行で始まる 1 つの run は、その run の指定を採る", () => {
    const children: InlineNode[] = [{ type: "text", text: "\nいち", fontFamily: '"Yu Mincho", serif' }];

    expect(resolveListMarkerTypography(listMarkerRunsFromInlineNodes(children)))
      .toEqual({ fontFamily: '"Yu Mincho", serif' });
  });

  it("ゼロ幅文字だけの run は飛ばす", () => {
    const children: InlineNode[] = [
      { type: "text", text: "​", fontFamily: '"Yu Gothic", sans-serif' },
      { type: "text", text: "いち", fontFamily: '"Yu Mincho", serif' },
    ];

    expect(resolveListMarkerTypography(listMarkerRunsFromInlineNodes(children)))
      .toEqual({ fontFamily: '"Yu Mincho", serif' });
  });

  it("中身の無い数式は飛ばす", () => {
    const children: InlineNode[] = [
      { type: "mathInline", id: "m_1", tex: "", display: "inline" },
      { type: "text", text: "いち", fontFamily: '"Yu Mincho", serif' },
    ];

    expect(resolveListMarkerTypography(listMarkerRunsFromInlineNodes(children)))
      .toEqual({ fontFamily: '"Yu Mincho", serif' });
  });

  it("数式ノードは math として写す", () => {
    const children: InlineNode[] = [
      { type: "mathInline", id: "m_1", tex: "x^2", display: "inline", fontFamily: "serif", fontSize: 18 },
    ];

    expect(listMarkerRunsFromInlineNodes(children)).toEqual([
      { kind: "math", hasGlyph: true, fontFamily: "serif", fontSizePt: 18, color: undefined, bold: false, italic: false },
    ]);
  });

  it("先頭 run の太字・斜体・色もマーカーへ運ぶ", () => {
    const children: InlineNode[] = [{ type: "text", text: "いち", marks: ["bold", "italic"], color: "#c0392b" }];

    expect(resolveListMarkerTypography(listMarkerRunsFromInlineNodes(children)))
      .toEqual({ color: "#c0392b", bold: true, italic: true });
  });

  it("下線と囲みは運ばない (::marker が受け付けない書式なので、付けても紙面に出ない)", () => {
    const children: InlineNode[] = [{ type: "text", text: "いち", marks: ["underline", "boxed"] }];

    expect(resolveListMarkerTypography(listMarkerRunsFromInlineNodes(children))).toBeUndefined();
  });

  it("数式 run の太字・斜体は採らない (数式では字形そのものが別物になるため)", () => {
    const children: InlineNode[] = [
      { type: "mathInline", id: "m_1", tex: "x", display: "inline", color: "#c0392b" },
    ];

    expect(resolveListMarkerTypography(listMarkerRunsFromInlineNodes(children)))
      .toEqual({ color: "#c0392b" });
  });

  it("空の項目は既定を継ぐ", () => {
    expect(resolveListMarkerTypography(listMarkerRunsFromInlineNodes([]))).toBeUndefined();
  });
});
