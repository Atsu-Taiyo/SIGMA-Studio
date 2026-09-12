import { describe, expect, it } from "vitest";

import { resolveEffectiveFontFamily } from "./effective-font";

const DOCUMENT_FONT = "Hiragino Sans, sans-serif";
const BOX_BODY_FONT = "Hiragino Mincho ProN, serif";
const BOX_TITLE_FONT = "Yu Gothic, sans-serif";

function resolve(input: Partial<Parameters<typeof resolveEffectiveFontFamily>[0]>) {
  return resolveEffectiveFontFamily({
    markFontFamilies: [null],
    inBoxTitle: false,
    documentFontFamily: DOCUMENT_FONT,
    ...input,
  });
}

describe("resolveEffectiveFontFamily", () => {
  it("uses the mark when the run carries one", () => {
    expect(resolve({ markFontFamilies: ["Times New Roman, serif"] }))
      .toEqual({ kind: "resolved", fontFamily: "Times New Roman, serif", source: "mark" });
  });

  it("falls back to the document default where no mark is set", () => {
    // 段落レベルのフォントは SigmaDoc に存在しないので、「段落の実効フォント」は箱か文書既定。
    expect(resolve({ markFontFamilies: [null] }))
      .toEqual({ kind: "resolved", fontFamily: DOCUMENT_FONT, source: "document" });
  });

  it("falls back to the box body font inside a frame", () => {
    expect(resolve({ markFontFamilies: [null], boxBodyFontFamily: BOX_BODY_FONT }))
      .toEqual({ kind: "resolved", fontFamily: BOX_BODY_FONT, source: "boxBody" });
  });

  it("falls back to the box title font inside a frame title", () => {
    expect(resolve({
      markFontFamilies: [null],
      inBoxTitle: true,
      boxBodyFontFamily: BOX_BODY_FONT,
      boxTitleFontFamily: BOX_TITLE_FONT,
    })).toEqual({ kind: "resolved", fontFamily: BOX_TITLE_FONT, source: "boxTitle" });
  });

  it("does not lend the body font to a title the frame styles no font for", () => {
    // タイトルと本文は別々のカスタムプロパティで描かれ、片方だけ指定された枠のタイトルは
    // 本文の書体ではなく文書既定を継ぐ。
    expect(resolve({ markFontFamilies: [null], inBoxTitle: true, boxBodyFontFamily: BOX_BODY_FONT }))
      .toEqual({ kind: "resolved", fontFamily: DOCUMENT_FONT, source: "document" });
  });

  it("reports a selection that spans two different fonts as mixed", () => {
    expect(resolve({ markFontFamilies: ["Times New Roman, serif", "Courier New, monospace"] }))
      .toEqual({ kind: "mixed" });
  });

  it("does not call a run mixed when an unmarked run resolves to the same font", () => {
    // 「未指定」と「文書既定と同じ値のマーク」は同じ見た目なので、混在にしてはいけない。
    expect(resolve({ markFontFamilies: [null, DOCUMENT_FONT] }))
      .toEqual({ kind: "resolved", fontFamily: DOCUMENT_FONT, source: "document" });
  });

  it("compares against the box font when deciding whether a boxed selection is mixed", () => {
    expect(resolve({ markFontFamilies: [null, BOX_BODY_FONT], boxBodyFontFamily: BOX_BODY_FONT }))
      .toEqual({ kind: "resolved", fontFamily: BOX_BODY_FONT, source: "boxBody" });
    expect(resolve({ markFontFamilies: [null, DOCUMENT_FONT], boxBodyFontFamily: BOX_BODY_FONT }))
      .toEqual({ kind: "mixed" });
  });

  it("treats an empty run list as the surrounding default rather than mixed", () => {
    // 空段落や改行直後はテキストノードが 1 つも無い。そこで空欄を出すと入力予定のフォントが隠れる。
    expect(resolve({ markFontFamilies: [] }))
      .toEqual({ kind: "resolved", fontFamily: DOCUMENT_FONT, source: "document" });
  });

  it("keeps the mark source when every run carries the same explicit font", () => {
    expect(resolve({ markFontFamilies: ["Courier New, monospace", "Courier New, monospace"] }))
      .toEqual({ kind: "resolved", fontFamily: "Courier New, monospace", source: "mark" });
  });

  it("ignores blank mark values the same way an unset mark is ignored", () => {
    expect(resolve({ markFontFamilies: ["   "] }))
      .toEqual({ kind: "resolved", fontFamily: DOCUMENT_FONT, source: "document" });
  });
});
