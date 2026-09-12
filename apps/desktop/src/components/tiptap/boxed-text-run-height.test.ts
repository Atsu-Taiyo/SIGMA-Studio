import { Extension, getSchema } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";

import {
  boxedRunContainerSignature,
  boxedRunExtraPaddingBottom,
  boxedRunExtraPaddingTop,
  collectBoxedRunDocTargetsForTextBlock,
  computeBoxedRunLineConnections,
  computeBoxedRunLineTargets,
  reconcileBoxedRunHeightState,
  splitBoxedRunRectsIntoLines,
  type BoxedRunHeightState,
} from "@/components/tiptap/boxed-text-run-height";
import { InlineMathExtension } from "@/components/tiptap/inline-math-extension";
import { BoxedTextExtension } from "@/components/tiptap/text-format-extensions";

describe("boxed text run height", () => {
  it("keeps adjacent boxes on the same visual line even when their tops differ", () => {
    const lines = splitBoxedRunRectsIntoLines([
      { top: 20, bottom: 44, height: 24 },
      { top: 12, bottom: 50, height: 38 },
      { top: 0, bottom: 70, height: 70 },
      { top: 86, bottom: 110, height: 24 },
    ]);

    expect(lines).toEqual([
      [
        { top: 20, bottom: 44, height: 24 },
        { top: 12, bottom: 50, height: 38 },
        { top: 0, bottom: 70, height: 70 },
      ],
      [{ top: 86, bottom: 110, height: 24 }],
    ]);
  });

  it("adds only the missing edge padding needed to align line borders", () => {
    expect(boxedRunExtraPaddingTop(20, 6)).toBe(14);
    expect(boxedRunExtraPaddingBottom(44, 58)).toBe(14);
    expect(boxedRunExtraPaddingTop(6, 20)).toBe(0);
    expect(boxedRunExtraPaddingBottom(58, 44)).toBe(0);
  });

  it("targets the tallest item on each visual line, including unboxed content", () => {
    const targets = computeBoxedRunLineTargets<string>([
      { top: 20, bottom: 44, height: 24, boxedTarget: "text-box" },
      { top: 6, bottom: 58, height: 52 },
      { top: 92, bottom: 116, height: 24, boxedTarget: "next-line-box" },
      { top: 92, bottom: 116, height: 24 },
    ]);

    expect(targets.get("text-box")).toEqual({
      extraPaddingBottom: 14,
      extraPaddingTop: 14,
      targetHeight: 52,
      ownHeight: 24,
    });
    expect(targets.get("next-line-box")).toEqual({
      extraPaddingBottom: 0,
      extraPaddingTop: 0,
      targetHeight: 24,
      ownHeight: 24,
    });
  });

  it("keeps different lines from inheriting another line's taller target", () => {
    const targets = computeBoxedRunLineTargets<string>([
      { top: 10, bottom: 34, height: 24, boxedTarget: "line-1" },
      { top: 10, bottom: 34, height: 24 },
      { top: 54, bottom: 78, height: 24, boxedTarget: "line-2" },
      { top: 42, bottom: 96, height: 54 },
    ]);

    expect(targets.get("line-1")).toEqual({
      extraPaddingBottom: 0,
      extraPaddingTop: 0,
      targetHeight: 24,
      ownHeight: 24,
    });
    expect(targets.get("line-2")).toEqual({
      extraPaddingBottom: 18,
      extraPaddingTop: 12,
      targetHeight: 54,
      ownHeight: 24,
    });
  });

  it("connects adjacent boxed text and math runs without crossing unboxed gaps", () => {
    const text = { from: 1, to: 4 };
    const math = { from: 4, to: 5 };
    const separated = { from: 7, to: 10 };
    const nextLine = { from: 10, to: 12 };
    const connections = computeBoxedRunLineConnections([
      { top: 10, bottom: 34, height: 24, boxedTarget: text },
      { top: 8, bottom: 34, height: 26, boxedTarget: math },
      { top: 10, bottom: 34, height: 24 },
      { top: 10, bottom: 34, height: 24, boxedTarget: separated },
      { top: 54, bottom: 78, height: 24, boxedTarget: nextLine },
    ]);

    expect(connections.get(text)).toEqual({ connectLeft: false, connectRight: true });
    expect(connections.get(math)).toEqual({ connectLeft: true, connectRight: false });
    expect(connections.has(separated)).toBe(false);
    expect(connections.has(nextLine)).toBe(false);
  });

  it("extracts exact adjacent document targets for boxed text followed by boxed inline math", () => {
    const schema = getSchema([StarterKit, BoxedTextExtension, InlineMathExtension]);
    const boxedText = schema.marks.boxed.create({ variant: "oval" });
    const boxedMath = schema.marks.boxed.create({ math: true, variant: "oval" });
    const paragraph = schema.nodes.paragraph.create(null, [
      schema.text("abc", [boxedText]),
      schema.nodes.mathInline.create({ id: "m1", tex: "\\frac{1}{x}" }, null, [boxedMath]),
    ]);

    expect(collectBoxedRunDocTargetsForTextBlock(paragraph, 5).map(({ from, styleKey, to }) => ({ from, styleKey, to }))).toEqual([
      { from: 6, styleKey: "0|oval|", to: 9 },
      { from: 9, styleKey: "0|oval|", to: 10 },
    ]);
  });

  it("does not connect adjacent boxed runs with different visual styles", () => {
    const text = { from: 1, styleKey: "0|frame|", to: 4 };
    const math = { from: 4, styleKey: "0|oval|", to: 5 };
    const connections = computeBoxedRunLineConnections([
      { top: 10, bottom: 34, height: 24, boxedTarget: text },
      { top: 8, bottom: 40, height: 32, boxedTarget: math },
    ]);

    expect(connections.has(text)).toBe(false);
    expect(connections.has(math)).toBe(false);
  });

  it("connects only document-adjacent boxed targets with the same double style", () => {
    const left = { from: 1, styleKey: "0|double|", to: 2 };
    const middle = { from: 2, styleKey: "0|double|", to: 3 };
    const right = { from: 3, styleKey: "0|double|", to: 8 };
    const separated = { from: 10, styleKey: "0|double|", to: 11 };
    const connections = computeBoxedRunLineConnections([
      { top: 10, bottom: 34, height: 24, boxedTarget: left },
      { top: 8, bottom: 40, height: 32, boxedTarget: middle },
      { top: 10, bottom: 34, height: 24, boxedTarget: right },
      { top: 10, bottom: 34, height: 24, boxedTarget: separated },
    ]);

    expect(connections.get(left)).toEqual({ connectLeft: false, connectRight: true });
    expect(connections.get(middle)).toEqual({ connectLeft: true, connectRight: true });
    expect(connections.get(right)).toEqual({ connectLeft: true, connectRight: false });
    expect(connections.has(separated)).toBe(false);
  });
});

/**
 * 描いた枠は「それを測ったときの文書形状が変わっていない間だけ」有効、という不変条件。
 *
 * Undo は `setContent` = 文書全体 1 本の ReplaceStep なので、写像だけでは
 * (1) 囲みを外した段落に古い矩形が残り、(2) inline の装飾範囲が文書全体へ広がる。
 * (2) は次の計測で全段落に枠を作らせるので、症状は 1 段落では止まらない。
 */
describe("reconcileBoxedRunHeightState", () => {
  const SigmaDocIdTestAttribute = Extension.create({
    name: "sigmaDocIdTestAttribute",
    addGlobalAttributes() {
      return [{ types: ["paragraph", "heading"], attributes: { sigmaDocId: { default: null } } }];
    },
  });

  const schema = getSchema([StarterKit, BoxedTextExtension, InlineMathExtension, SigmaDocIdTestAttribute]);
  const boxedMark = schema.marks.boxed.create({ variant: "oval" });

  function paragraph(id: string | null, text: string, boxed: boolean): ProseMirrorNode {
    return schema.nodes.paragraph.create(
      { sigmaDocId: id },
      schema.text(text, boxed ? [boxedMark] : undefined),
    );
  }

  function documentOf(...paragraphs: ProseMirrorNode[]): ProseMirrorNode {
    return schema.nodes.doc.create(null, paragraphs);
  }

  const frame = { left: 1, top: 2, width: 30, height: 20, variant: "oval", tone: null };

  function measuredState(containerKey: string, document: ProseMirrorNode, pos: number): BoxedRunHeightState {
    return {
      blockTargets: { [containerKey]: 24 },
      frames: { [containerKey]: [frame] },
      inlineTargets: [{
        connectLeft: false,
        connectRight: false,
        containerKey,
        extraPaddingBottom: 0,
        extraPaddingTop: 0,
        from: pos + 1,
        ownHeight: 24,
        targetHeight: 24,
        to: pos + 1 + document.nodeAt(pos)!.content.size,
      }],
      signatures: { [containerKey]: boxedRunContainerSignature(document.nodeAt(pos)!, pos) },
    };
  }

  /** Tiptap の `setContent` と同じ「文書全体 1 本の ReplaceStep」。 */
  function replaceWholeDocument(from: ProseMirrorNode, to: ProseMirrorNode) {
    const state = EditorState.create({ doc: from });
    return state.tr.replaceWith(0, from.content.size, to.content);
  }

  it("signs which boxed runs a container holds, not where they sit", () => {
    const document = documentOf(paragraph("p_a", "abc", true), paragraph("p_b", "xyz", false));

    expect(boxedRunContainerSignature(document.nodeAt(0)!, 0)).toBe("1#0|oval|");
    expect(boxedRunContainerSignature(document.nodeAt(5)!, 5)).toBe("0#");
  });

  it("keeps the signature stable when the run itself only grows", () => {
    // ここに位置を含めると、囲みの中に 1 文字打つたびにコンテナごと無効化される。
    const before = documentOf(paragraph("p_a", "abc", true));
    const after = documentOf(paragraph("p_a", "abXc", true));

    expect(boxedRunContainerSignature(after.nodeAt(0)!, 0))
      .toBe(boxedRunContainerSignature(before.nodeAt(0)!, 0));
  });

  it("changes the signature when a run is added or restyled", () => {
    const one = documentOf(paragraph("p_a", "abc", true));
    const restyled = schema.nodes.doc.create(null, [schema.nodes.paragraph.create(
      { sigmaDocId: "p_a" },
      schema.text("abc", [schema.marks.boxed.create({ variant: "double" })]),
    )]);

    expect(boxedRunContainerSignature(restyled.nodeAt(0)!, 0))
      .not.toBe(boxedRunContainerSignature(one.nodeAt(0)!, 0));
  });

  it("drops everything when an undo replaces the document and the boxed mark is gone", () => {
    const before = documentOf(paragraph("p_a", "abc", true), paragraph("p_b", "xyz", false));
    const after = documentOf(paragraph("p_a", "abc", false), paragraph("p_b", "xyz", false));

    const reconciled = reconcileBoxedRunHeightState(
      measuredState("p_a", before, 0),
      replaceWholeDocument(before, after),
    );

    expect(reconciled).toEqual({ blockTargets: {}, frames: {}, inlineTargets: [], signatures: {} });
  });

  it("never lets an inline target widen into one decoration over the whole document", () => {
    const before = documentOf(paragraph("p_a", "abc", true), paragraph("p_b", "xyz", false));
    const after = documentOf(paragraph("p_a", "abc", false), paragraph("p_b", "xyz", false));

    const mapped = reconcileBoxedRunHeightState(
      measuredState("p_a", before, 0),
      replaceWholeDocument(before, after),
    ).inlineTargets;

    expect(mapped).toEqual([]);
  });

  it("drops an untouched container too when the whole document is replaced", () => {
    // 別段落の編集でも `setContent` は文書全体 1 本の ReplaceStep で届く。写像すると生き残った
    // 側の範囲が 0..文書サイズ へ広がり、全インラインに枠計測用の属性が付いてしまう。
    const before = documentOf(paragraph("p_b", "xy", false), paragraph("p_a", "abc", true));
    const after = documentOf(paragraph("p_b", "xyz!", false), paragraph("p_a", "abc", true));

    const reconciled = reconcileBoxedRunHeightState(
      measuredState("p_a", before, 4),
      replaceWholeDocument(before, after),
    );

    expect(reconciled).toEqual({ blockTargets: {}, frames: {}, inlineTargets: [], signatures: {} });
  });

  it("keeps a container's measurements when a different paragraph is edited", () => {
    const document = documentOf(paragraph("p_a", "abc", true), paragraph("p_b", "xyz", false));
    const state = EditorState.create({ doc: document });

    const reconciled = reconcileBoxedRunHeightState(
      measuredState("p_a", document, 0),
      state.tr.insertText("!", 7),
    );

    expect(reconciled.frames.p_a).toEqual([frame]);
    expect(reconciled.blockTargets.p_a).toBe(24);
    expect(reconciled.inlineTargets).toHaveLength(1);
  });

  it("keeps and grows a container's inline target when text is typed inside its run", () => {
    const document = documentOf(paragraph("p_a", "abc", true), paragraph("p_b", "xyz", false));
    const state = EditorState.create({ doc: document });

    const reconciled = reconcileBoxedRunHeightState(
      measuredState("p_a", document, 0),
      state.tr.insertText("!", 2),
    );

    expect(reconciled.frames.p_a).toEqual([frame]);
    expect(reconciled.inlineTargets).toHaveLength(1);
    expect(reconciled.inlineTargets[0]).toMatchObject({ containerKey: "p_a", from: 1, to: 5 });
  });

  it("keeps a container when the character just outside its run is deleted", () => {
    // 隣を消しただけで無効化すると、囲みの前後で Backspace するたびに枠がセグメント border へ
    // 落ちる。写像は正しく効くので、拒否すべきは「範囲ごと差し替えられた」ときだけ。
    const withLead = schema.nodes.paragraph.create({ sigmaDocId: "p_a" }, [
      schema.text("Z"),
      schema.text("abc", [boxedMark]),
    ]);
    const document = documentOf(paragraph("p_b", "xy", false), withLead);
    const state = EditorState.create({ doc: document });
    const base = measuredState("p_a", document, 4);
    const measured: BoxedRunHeightState = {
      ...base,
      inlineTargets: [{ ...base.inlineTargets[0], from: 6, to: 9 }],
    };

    const reconciled = reconcileBoxedRunHeightState(measured, state.tr.delete(5, 6));

    expect(reconciled.frames.p_a).toEqual([frame]);
    expect(reconciled.inlineTargets[0]).toMatchObject({ from: 5, to: 8 });
  });

  it("keeps a container when the paragraph below is joined into it", () => {
    const document = documentOf(paragraph("p_a", "abc", true), paragraph("p_b", "xyz", false));
    const state = EditorState.create({ doc: document });

    const reconciled = reconcileBoxedRunHeightState(
      measuredState("p_a", document, 0),
      state.tr.join(5),
    );

    expect(reconciled.frames.p_a).toEqual([frame]);
    expect(reconciled.inlineTargets[0]).toMatchObject({ from: 1, to: 4 });
  });

  it("drops a container's measurements when its boxed mark is removed in place", () => {
    const document = documentOf(paragraph("p_a", "abc", true), paragraph("p_b", "xyz", false));
    const state = EditorState.create({ doc: document });

    const reconciled = reconcileBoxedRunHeightState(
      measuredState("p_a", document, 0),
      state.tr.removeMark(1, 4, schema.marks.boxed),
    );

    expect(reconciled).toEqual({ blockTargets: {}, frames: {}, inlineTargets: [], signatures: {} });
  });

  it("follows a position-keyed container through an edit above it", () => {
    const document = documentOf(paragraph(null, "xy", false), paragraph(null, "abc", true));
    const state = EditorState.create({ doc: document });

    const reconciled = reconcileBoxedRunHeightState(
      measuredState("pos:4", document, 4),
      state.tr.insertText("!", 2),
    );

    expect(Object.keys(reconciled.frames)).toEqual(["pos:5"]);
    expect(reconciled.inlineTargets[0]).toMatchObject({ containerKey: "pos:5", from: 6, to: 9 });
  });

  it("never hands back an inherited value for a block whose id shadows Object.prototype", () => {
    // `sigmaDocId` は永続データ側で任意の文字列。素のオブジェクトを索引にすると
    // `frames["constructor"]` が関数を返し、装飾パスが描画中に落ちて画面が真っ白になる。
    const before = documentOf(paragraph("constructor", "abc", true));
    const after = documentOf(paragraph("constructor", "abc", false));

    const reconciled = reconcileBoxedRunHeightState(
      measuredState("constructor", before, 0),
      replaceWholeDocument(before, after),
    );

    expect(reconciled.frames.constructor).toBeUndefined();
    expect(reconciled.blockTargets.constructor).toBeUndefined();
    expect(reconciled.signatures.constructor).toBeUndefined();
  });

  it("returns the same state object when nothing was measured (no document walk)", () => {
    const document = documentOf(paragraph("p_a", "abc", false));
    const state = EditorState.create({ doc: document });
    const empty: BoxedRunHeightState = { blockTargets: {}, frames: {}, inlineTargets: [], signatures: {} };

    expect(reconcileBoxedRunHeightState(empty, state.tr.insertText("!", 2))).toBe(empty);
  });
});
