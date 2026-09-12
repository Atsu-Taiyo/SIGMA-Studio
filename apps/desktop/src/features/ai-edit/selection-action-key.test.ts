import { describe, expect, it } from "vitest";

import type { PageCanvasSelectionSource } from "@/components/editor/page-canvas/editor-extension";
import type { AiEditReference } from "@/lib/ai/ai-edit-reference";

import { getSelectionActionKey } from "./selection-action-key";

const reference = (summary: string) => ({ kind: "block", summary } as unknown as AiEditReference);

describe("getSelectionActionKey", () => {
  it("keys a block target by where it is, not by what it currently says", () => {
    // 本文を 1 文字打つたびに参照の中身 (要約テキスト) は変わる。これを鍵にすると、
    // 選択ポップオーバーの state が毎打鍵で入れ替わり紙面全体が再描画される。
    const source: PageCanvasSelectionSource = { kind: "block", targetId: "p_first" };

    expect(getSelectionActionKey(source, reference("本文"))).toBe(getSelectionActionKey(source, reference("本文あ")));
    expect(getSelectionActionKey({ kind: "block", targetId: "p_second" }, reference("本文")))
      .not.toBe(getSelectionActionKey(source, reference("本文")));
  });

  it("keys an inline math target by the math node and its current TeX", () => {
    // 数式は「中身そのもの」が参照。TeX を鍵から外すと、式を直した直後に古い式が AI へ渡る。
    const source: PageCanvasSelectionSource = { kind: "inlineMath", targetId: "p1", mathInlineId: "m1", tex: "x" };

    expect(getSelectionActionKey({ ...source, tex: "x^2" }, reference("x^2")))
      .not.toBe(getSelectionActionKey(source, reference("x")));
    expect(getSelectionActionKey({ ...source }, reference("別の要約")))
      .toBe(getSelectionActionKey(source, reference("x")));
    expect(getSelectionActionKey({ ...source, mathInlineId: "m2" }, reference("x")))
      .not.toBe(getSelectionActionKey(source, reference("x")));
  });

  it("keys an overlay selection by the selected shapes", () => {
    const source = { kind: "overlaySelection", targetId: null, selection: { selectedShapeIds: ["s1", "s2"] } } as unknown as PageCanvasSelectionSource;
    const other = { kind: "overlaySelection", targetId: null, selection: { selectedShapeIds: ["s1"] } } as unknown as PageCanvasSelectionSource;

    expect(getSelectionActionKey(source, reference("図形"))).toBe(getSelectionActionKey(source, reference("図形 2")));
    expect(getSelectionActionKey(other, reference("図形"))).not.toBe(getSelectionActionKey(source, reference("図形")));
  });

  it("still keys a text selection by the reference itself", () => {
    // テキスト選択は「選んだ文字列そのもの」が参照の中身。打鍵で選択は壊れるので churn せず、
    // 逆にここを位置だけにすると引用が古いまま AI へ渡りうる。
    const source: PageCanvasSelectionSource = {
      kind: "textRange",
      targetId: "p1",
      selectedText: "本文",
      mathTex: [],
    };

    expect(getSelectionActionKey(source, reference("本文"))).not.toBe(getSelectionActionKey(source, reference("別の本文")));
  });
});
