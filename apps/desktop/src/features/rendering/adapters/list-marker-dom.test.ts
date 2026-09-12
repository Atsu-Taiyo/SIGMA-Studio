import { describe, expect, it } from "vitest";

import type { InlineNode } from "@/features/document";

import {
  LIST_MARKER_TYPOGRAPHY_ATTRIBUTE,
  listMarkerTypographyDomSpec,
  listMarkerTypographyVars,
} from "./list-marker-dom";

describe("listMarkerTypographyVars", () => {
  it("書体と大きさをカスタムプロパティへ写す (大きさの単位は pt)", () => {
    expect(listMarkerTypographyVars({ fontFamily: '"Yu Mincho", serif', fontSizePt: 18 })).toEqual({
      "--sigma-doc-list-marker-font-family": '"Yu Mincho", serif',
      "--sigma-doc-list-marker-font-size": "18pt",
    });
  });

  it("片方だけの指定は片方だけ出す", () => {
    expect(listMarkerTypographyVars({ fontSizePt: 9 }))
      .toEqual({ "--sigma-doc-list-marker-font-size": "9pt" });
    expect(listMarkerTypographyVars({ fontFamily: "serif" }))
      .toEqual({ "--sigma-doc-list-marker-font-family": "serif" });
  });

  it("指定が無ければ何も出さない", () => {
    expect(listMarkerTypographyVars(undefined)).toBeUndefined();
    expect(listMarkerTypographyVars({})).toBeUndefined();
  });

  it("宣言を閉じられる書体名は捨てる (style 属性への注入口を新設しない)", () => {
    for (const fontFamily of [
      "serif; position: fixed",
      "serif} body {display:none",
      "serif{display:none",
      "serif</style><img src=x onerror=alert(1)>",
      "serif/* ",
      "serif*/",
      "serif\nposition: fixed",
      "serif\rposition: fixed",
    ]) {
      expect(listMarkerTypographyVars({ fontFamily, fontSizePt: 18 }))
        .toEqual({ "--sigma-doc-list-marker-font-size": "18pt" });
    }
  });

  it("捨てた結果 何も残らなければ undefined を返す", () => {
    expect(listMarkerTypographyVars({ fontFamily: "serif; position: fixed" })).toBeUndefined();
  });

  it("有限でない・0 以下の大きさは捨てる", () => {
    expect(listMarkerTypographyVars({ fontSizePt: 0 })).toBeUndefined();
    expect(listMarkerTypographyVars({ fontSizePt: -4 })).toBeUndefined();
    expect(listMarkerTypographyVars({ fontSizePt: Number.NaN })).toBeUndefined();
    expect(listMarkerTypographyVars({ fontSizePt: Number.POSITIVE_INFINITY })).toBeUndefined();
  });

  it("属性名は CSS 側のセレクタと同じ 1 つだけ", () => {
    expect(LIST_MARKER_TYPOGRAPHY_ATTRIBUTE).toBe("data-list-marker-typography");
  });
});

describe("listMarkerTypographyDomSpec", () => {
  it("属性とカスタムプロパティを必ず一緒に出す", () => {
    const children: InlineNode[] = [{ type: "text", text: "いち", fontFamily: "serif", fontSize: 18 }];

    expect(listMarkerTypographyDomSpec(children)).toEqual({
      attrs: { "data-list-marker-typography": "" },
      style: {
        "--sigma-doc-list-marker-font-family": "serif",
        "--sigma-doc-list-marker-font-size": "18pt",
      },
    });
  });

  it("先頭 run に指定が無ければ属性も出さない", () => {
    expect(listMarkerTypographyDomSpec([{ type: "text", text: "いち" }])).toBeUndefined();
    expect(listMarkerTypographyDomSpec([])).toBeUndefined();
  });
});
