// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BoxBlockBodyExtension,
  BoxBlockExtension,
  BoxBlockTitleExtension,
} from "@/components/tiptap/sigma-doc-container-extensions";
import { SigmaDocTextAttrs } from "@/components/tiptap/sigma-doc-text-attributes";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import { applyEditorDocumentProjection } from "@/components/tiptap/document-projection";
import { createTextFormatStateDetail } from "@/components/tiptap/text-format-controller";
import {
  EDITOR_TEXT_SLICE_MIME,
  extractVisibleEditorClipboardHtml,
  createEditorClipboardHtml,
  createTextFlowClipboardPayload,
  takeBodyTextCut,
} from "@/lib/editor-clipboard";
import type { TextFlowBlock } from "@/features/text-editing";
import { replaceTopLevelTextFlowBlocks, textCaretAddress } from "@/features/text-editing";

import {
  applyTextRunSpanFormat,
  applyTextRunSpanFormatForEvent,
  beginTextRunSpanComposition,
  clearTextRunSpan,
  validateTextRunSpanTransaction,
  refreshTextRunSpanSurfaces,
  clearTextRunSpanOnOutsidePointerDown,
  copyActiveTextRunSpan,
  getActiveTextRunSpan,
  getTextRunSpanCompositionHistoryGroup,
  getTextRunSpanToggleMarkStates,
  getTextRunSpanFontSize,
  handleTextRunSpanKeyDown,
  handleTextRunSpanTextInput,
  selectEntireTextRun,
  type TextRunEditorHandle,
} from "./text-run-span";
import { registerCaretSurface } from "./caret-router";
import { cutTextFlowSelection } from "./clipboard-transactions";
import { peekBodyCutHistoryGroup } from "./clipboard-history-group";

interface TestUnit {
  editor: Editor;
  handle: TextRunEditorHandle;
  onChange: ReturnType<typeof vi.fn>;
  markCrossEditorSync: ReturnType<typeof vi.fn>;
  applyCrossEditorSync: ReturnType<typeof vi.fn>;
  unregister: () => void;
}

function paragraphNode(id: string, text: string, breakBefore = false) {
  return {
    type: "paragraph",
    attrs: {
      sigmaDocId: id,
      sigmaDocType: "paragraph",
      ...(breakBefore ? { pagination: { break: true } } : {}),
    },
    content: text ? [{ type: "text", text }] : [],
  };
}

function createUnit(
  unitId: string,
  order: number,
  paragraphs: Array<{ breakBefore?: boolean; id: string; text: string }>,
): TestUnit {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: createRichTextEngineExtensions({
      blockExtensions: [
        SigmaDocTextAttrs,
        BoxBlockExtension,
        BoxBlockTitleExtension,
        BoxBlockBodyExtension,
      ],
    }),
    content: {
      type: "doc",
      content: paragraphs.map((paragraph) => paragraphNode(
        paragraph.id,
        paragraph.text,
        paragraph.breakBefore,
      )),
    },
  });
  const blocks: TextFlowBlock[] = paragraphs.map((paragraph) => ({
    type: "paragraph",
    id: paragraph.id,
    children: paragraph.text ? [{ type: "text", text: paragraph.text }] : [],
    ...(paragraph.breakBefore ? { pagination: { break: true } } : {}),
  }));
  const onChange = vi.fn();
  const markCrossEditorSync = vi.fn();
  const applyCrossEditorSync = vi.fn();
  const handle: TextRunEditorHandle = {
    editor,
    groupId: "test-group",
    unitId,
    order,
    preserveEmpty: false,
    scopeId: "document",
    getBlocks: () => blocks,
    markCrossEditorSync,
    applyCrossEditorSync,
    onChange,
  };
  const unregister = registerCaretSurface({
    editor,
    boxIds: [],
    fragmentBlockIdFor: () => null,
    order: [order],
    surface: { kind: "unit", unitId },
    ownsBlock: (blockId) => {
      let owns = false;
      editor.state.doc.descendants(node => { if (node.attrs.sigmaDocId === blockId) owns = true; });
      return owns;
    },
    addressAt: position => {
      const resolved = editor.state.doc.resolve(position);
      for (let depth = resolved.depth; depth > 0; depth--) {
        const id: unknown = resolved.node(depth).attrs.sigmaDocId;
        if (typeof id === "string") return textCaretAddress(id, position - resolved.start(depth));
      }
      return null;
    },
    posFor: address => {
      let position: number | null = null;
      editor.state.doc.descendants((node, pos) => {
        if (node.attrs.sigmaDocId === address.blockId) position = pos + 1 + address.offset;
      });
      return position;
    },
    localYFor: () => null,
    caretLineAdvance: () => null,
    focusCaretAtLocalY: () => false,
    focusCaretAtEdge: () => false,
    focusCaretAfterBlock: () => false,
    adjacentTextblockAddress: () => null,
    docEdgeAddress: () => null,
    ensureCaretVisible: () => {},
    applyCaret: () => false,
    textRun: handle,
  });
  editor.on("transaction", ({ transaction }) => validateTextRunSpanTransaction(editor, transaction));
  refreshTextRunSpanSurfaces();
  return { editor, handle, onChange, markCrossEditorSync, applyCrossEditorSync, unregister };
}

function docText(editor: Editor): string {
  return editor.state.doc.textContent;
}

const cleanups: Array<() => void> = [];

function createSpanPair(): { first: TestUnit; second: TestUnit } {
  const first = createUnit("unit-a", 0, [
    { id: "p1", text: "前半一" },
    { id: "p2", text: "前半二" },
  ]);
  const second = createUnit("unit-b", 1, [
    { id: "p3", text: "後半一" },
    { id: "p4", text: "後半二" },
  ]);
  cleanups.push(() => {
    first.unregister();
    second.unregister();
    first.editor.destroy();
    second.editor.destroy();
  });
  // 全選択で 2 ユニット跨ぎの span を張る (公開 API 経由)。
  expect(selectEntireTextRun(first.editor)).toBe(true);
  expect(getActiveTextRunSpan()).not.toBeNull();
  return { first, second };
}

afterEach(() => {
  clearTextRunSpan();
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe("handleTextRunSpanTextInput", () => {
  it("serializes a spanning cut before the event listeners finish and deletes only in the next task", async () => {
    vi.useFakeTimers();
    try {
      const { first, second } = createSpanPair();
      const firstDoc = first.editor.getJSON();
      const secondDoc = second.editor.getJSON();
      const dataTransfer = new DataTransfer();
      const event = new ClipboardEvent("cut", { clipboardData: dataTransfer, cancelable: true });
      peekBodyCutHistoryGroup();

      expect(cutTextFlowSelection(first.editor.view, event, first.handle.getBlocks())).toBe(true);

      expect(event.defaultPrevented).toBe(true);
      expect(dataTransfer.getData("text/plain")).toBe("前半一\n前半二\n後半一\n後半二");
      const cut = takeBodyTextCut(event);
      expect(cut?.historyGroup).toBeTruthy();
      expect(cut?.text).toBe(dataTransfer.getData("text/plain"));
      expect(first.onChange).not.toHaveBeenCalled();
      expect(second.onChange).not.toHaveBeenCalled();
      expect(first.editor.getJSON()).toEqual(firstDoc);
      expect(second.editor.getJSON()).toEqual(secondDoc);
      await Promise.resolve();
      expect(first.onChange).not.toHaveBeenCalled();
      expect(getActiveTextRunSpan()).not.toBeNull();

      vi.runOnlyPendingTimers();

      expect(first.onChange).toHaveBeenCalledTimes(1);
      expect(first.onChange.mock.calls[0][0]).toEqual(["p1", "p2", "p3", "p4"]);
      expect(first.onChange.mock.calls[0][3]).toMatchObject({ historyGroup: cut?.historyGroup, crossEditor: true });
      expect(second.onChange).not.toHaveBeenCalled();
      expect(getActiveTextRunSpan()).toBeNull();
      expect(peekBodyCutHistoryGroup()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keydown を経ないテキスト挿入は span 全体をそのテキストで置換する", () => {
    const { first, second } = createSpanPair();

    expect(handleTextRunSpanTextInput(first.editor.view.dom, "😀")).toBe(true);

    // scope が同じなので書き込みは先頭ユニットの onChange 1 本に束ねられる。
    expect(first.onChange).toHaveBeenCalledTimes(1);
    const [previousIds, nextBlocks, , context] = first.onChange.mock.calls[0];
    expect(previousIds).toEqual(["p1", "p2", "p3", "p4"]);
    expect(nextBlocks).toHaveLength(1);
    expect(nextBlocks[0].children).toEqual([{ type: "text", text: "😀" }]);
    // ユニット先頭からの挿入は旧先頭ブロックの id を引き継ぐ (チャンクアンカー保持 =
    // エディタの作り直しを防ぎ、次の打鍵の onChange が既存 id を指せる)。
    expect(nextBlocks[0].id).toBe("p1");
    expect(context?.crossEditor).toBe(true);
    expect(second.onChange).not.toHaveBeenCalled();
    // キャレットの乗るユニットは受動同期を待たず即時同期される。
    expect(first.applyCrossEditorSync).toHaveBeenCalledTimes(1);
    expect(first.applyCrossEditorSync.mock.calls[0][0]).toBe(nextBlocks);
    expect(first.applyCrossEditorSync.mock.calls[0][1]?.head.blockId).toBe("p1");
    expect(getActiveTextRunSpan()).toBeNull();
  });

  it("グループ外エディタの入力は飲み込まない", () => {
    createSpanPair();
    expect(handleTextRunSpanTextInput(document.createElement("div"), "a")).toBe(false);
  });

  it("空テキストはイベントだけ飲み込み span を保つ", () => {
    const { first } = createSpanPair();
    expect(handleTextRunSpanTextInput(first.editor.view.dom, "")).toBe(true);
    expect(getActiveTextRunSpan()).not.toBeNull();
  });

  it("手動改ページを跨ぐ Backspace は各ユニットを独立更新し owner id を複製しない", () => {
    const first = createUnit("unit-a", 0, [
      { id: "p_before", text: "前の段落テキストです。" },
    ]);
    const second = createUnit("unit-b", 1, [
      { id: "p_break", text: "改ページ後の段落テキストです。", breakBefore: true },
      { id: "p_after", text: "後ろの段落テキストです。" },
    ]);
    cleanups.push(() => {
      first.unregister();
      second.unregister();
      first.editor.destroy();
      second.editor.destroy();
    });

    first.editor.commands.setTextSelection({
      from: 1 + "前の".length,
      to: first.editor.state.doc.content.size - 1,
    });
    const shiftRight = () => handleTextRunSpanKeyDown(
      new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true }),
      first.editor.view.dom,
    );
    expect(shiftRight()).toBe(true);
    expect(shiftRight()).toBe(true);
    expect(shiftRight()).toBe(true);
    expect(getActiveTextRunSpan()).not.toBeNull();

    expect(handleTextRunSpanKeyDown(
      new KeyboardEvent("keydown", { key: "Backspace" }),
      first.editor.view.dom,
    )).toBe(true);

    expect(first.onChange).toHaveBeenCalledTimes(1);
    expect(second.onChange).toHaveBeenCalledTimes(1);
    const [firstPreviousIds, firstNextBlocks] = first.onChange.mock.calls[0];
    const [secondPreviousIds, secondNextBlocks] = second.onChange.mock.calls[0];
    expect(firstPreviousIds).toEqual(["p_before"]);
    expect(firstNextBlocks).toMatchObject([{
      id: "p_before",
      children: [{ type: "text", text: "前の" }],
    }]);
    expect(secondPreviousIds).toEqual(["p_break", "p_after"]);
    expect(secondNextBlocks[0]).toMatchObject({
      id: "p_break",
      children: [{ type: "text", text: "ージ後の段落テキストです。" }],
      pagination: { break: true },
    });
    expect(secondNextBlocks[1]).toMatchObject({
      id: "p_after",
      children: [{ type: "text", text: "後ろの段落テキストです。" }],
    });
    expect(secondNextBlocks.map((block: TextFlowBlock) => block.id)).toEqual(["p_break", "p_after"]);
    expect(new Set([
      ...firstNextBlocks.map((block: TextFlowBlock) => block.id),
      ...secondNextBlocks.map((block: TextFlowBlock) => block.id),
    ]).size).toBe(3);

    let savedBlocks: TextFlowBlock[] = [
      { type: "paragraph", id: "p_before", children: [{ type: "text", text: "前の段落テキストです。" }] },
      {
        type: "paragraph",
        id: "p_break",
        children: [{ type: "text", text: "改ページ後の段落テキストです。" }],
        pagination: { break: true },
      },
      { type: "paragraph", id: "p_after", children: [{ type: "text", text: "後ろの段落テキストです。" }] },
    ];
    for (const unit of [first, second]) {
      for (const [previousIds, nextBlocks] of unit.onChange.mock.calls) {
        savedBlocks = replaceTopLevelTextFlowBlocks(savedBlocks, previousIds, nextBlocks) as TextFlowBlock[];
      }
    }
    expect(savedBlocks).toMatchObject([
      { id: "p_before", children: [{ type: "text", text: "前の" }] },
      {
        id: "p_break",
        children: [{ type: "text", text: "ージ後の段落テキストです。" }],
        pagination: { break: true },
      },
      { id: "p_after", children: [{ type: "text", text: "後ろの段落テキストです。" }] },
    ]);
  });

  it("選択範囲のインラインマークを引き継いで置換する (単一エディタの marksAcross と同じ規則)", () => {
    const first = createUnit("unit-a", 0, [
      { id: "p1", text: "前半一" },
      { id: "p2", text: "前半二" },
    ]);
    const second = createUnit("unit-b", 1, [{ id: "p3", text: "後半一" }]);
    cleanups.push(() => {
      first.unregister();
      second.unregister();
      first.editor.destroy();
      second.editor.destroy();
    });
    // span 先頭の断面が太字になるよう、先頭ユニットを太字にしておく。
    first.editor.chain()
      .setTextSelection({ from: 0, to: first.editor.state.doc.content.size })
      .setMark("bold")
      .run();

    // アンカーを段落途中 (太字テキストの中) に置き、Shift+→ でユニット境界を跨いで span を張る。
    // (全選択 span は先頭が doc 端 = ブロック境界なので、単一エディタの Cmd+A と同じく
    // marksAcross は null になり、マーク継承はそもそも起きない。)
    const lastSelectable = first.editor.state.doc.content.size - 1;
    first.editor.commands.setTextSelection({ from: 2, to: lastSelectable });
    const handled = handleTextRunSpanKeyDown(
      new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true }),
      first.editor.view.dom,
    );
    expect(handled).toBe(true);
    expect(getActiveTextRunSpan()).not.toBeNull();

    expect(handleTextRunSpanTextInput(first.editor.view.dom, "あ")).toBe(true);

    expect(first.onChange).toHaveBeenCalledTimes(1);
    const [, nextBlocks] = first.onChange.mock.calls[0];
    expect(nextBlocks).toHaveLength(1);
    expect(nextBlocks[0].id).toBe("p1");
    // 打った「あ」が選択範囲先頭のマーク (太字) を継ぐ。境界結合される後続ユニットの
    // 残余 (非太字) はそのまま。
    expect(nextBlocks[0].children).toEqual([
      { type: "text", text: "前", marks: ["bold"] },
      { type: "text", text: "あ", marks: ["bold"] },
      { type: "text", text: "後半一" },
    ]);
  });
});

describe("getTextRunSpanFontSize", () => {
  function createFontSizeSpan(texts: string[]) {
    const units = texts.map((text, order) => {
      const unit = createUnit(`unit-${order}`, order, [{ id: `p${order}`, text }]);
      const element = unit.editor.view.dom.parentElement!;
      document.body.append(element);
      unit.editor.view.dom.style.fontSize = "16px";
      cleanups.push(() => { unit.unregister(); unit.editor.destroy(); element.remove(); });
      if (text) {
        unit.editor.chain().setTextSelection({ from: 0, to: unit.editor.state.doc.content.size }).setFontSize(13).run();
      }
      return unit;
    });
    expect(selectEntireTextRun(units[0].editor)).toBe(true);
    return units;
  }

  it.each([
    { texts: ["本文", ""] },
    { texts: ["", "本文"] },
    { texts: ["前半", "", "後半"] },
  ])("ignores empty-paragraph-only surfaces in $texts", ({ texts }) => {
    const units = createFontSizeSpan(texts);
    for (const unit of units) {
      expect(getTextRunSpanFontSize(unit.editor)).toEqual({ fontSize: 13, fontSizeMixed: false });
    }
  });

  it("still measures paragraph sizes when every selected surface is empty", () => {
    const [first, second] = createFontSizeSpan(["", ""]);
    expect(getTextRunSpanFontSize(first.editor)).toEqual({ fontSize: 12, fontSizeMixed: false });
    second.editor.view.dom.style.fontSize = "20px";
    expect(getTextRunSpanFontSize(first.editor)).toEqual({ fontSize: 12, fontSizeMixed: true });
  });

  it("keeps different text sizes mixed across an empty surface", () => {
    const [first, , last] = createFontSizeSpan(["前半", "", "後半"]);
    last.editor.chain().setTextSelection({ from: 0, to: last.editor.state.doc.content.size }).setFontSize(12).run();
    expect(getTextRunSpanFontSize(first.editor)).toEqual({ fontSize: 13, fontSizeMixed: true });
  });

  it("does not overwrite the focused editor's size when no surface can be measured", () => {
    const { first } = createSpanPair();
    const spy = vi.spyOn(window, "getComputedStyle").mockReturnValue({ fontSize: "" } as CSSStyleDeclaration);
    expect(getTextRunSpanFontSize(first.editor)).toBeNull();
    spy.mockRestore();
  });
  it("reports the first size and mixed state across separately mounted text surfaces", () => {
    const { first, second } = createSpanPair();
    first.editor.chain().setTextSelection({ from: 0, to: first.editor.state.doc.content.size }).setFontSize(10.5).run();
    second.editor.chain().setTextSelection({ from: 0, to: second.editor.state.doc.content.size }).setFontSize(12).run();
    expect(getTextRunSpanFontSize(second.editor)).toEqual({ fontSize: 10.5, fontSizeMixed: true });
    second.editor.chain().setTextSelection({ from: 0, to: second.editor.state.doc.content.size }).setFontSize(10.5).run();
    expect(getTextRunSpanFontSize(first.editor)).toEqual({ fontSize: 10.5, fontSizeMixed: false });
    clearTextRunSpan();
    expect(getTextRunSpanFontSize(first.editor)).toBeNull();
  });
});

describe("getTextRunSpanToggleMarkStates", () => {
  function createToggleSpan(paragraphsByUnit: string[][]): TestUnit[] {
    const units = paragraphsByUnit.map((texts, order) => {
      const unit = createUnit(`unit-${order}`, order, texts.map((text, index) => ({
        id: `p${order}-${index}`,
        text,
      })));
      cleanups.push(() => { unit.unregister(); unit.editor.destroy(); });
      return unit;
    });
    expect(selectEntireTextRun(units[0].editor)).toBe(true);
    return units;
  }

  describe.each(["bold", "italic", "underline", "boxed"] as const)("%s", (command) => {
    it.each([
      { paragraphs: [["前半", "後半"], [""]] },
      { paragraphs: [[""], ["前半", "後半"]] },
      { paragraphs: [["前半"], [""], ["後半"]] },
      { paragraphs: [["", "前半", ""], ["", "後半", ""]] },
    ])("空段落を除いて表示と3回のトグルが揃う: $paragraphs", ({ paragraphs }) => {
      const units = createToggleSpan(paragraphs);
      for (const unit of units) {
        expect(getTextRunSpanToggleMarkStates(unit.editor)?.[command]).toBe(false);
      }

      for (const pressed of [true, false, true]) {
        expect(applyTextRunSpanFormat({ command })).toBe(true);
        let textCount = 0;
        for (const unit of units) {
          expect(getTextRunSpanToggleMarkStates(unit.editor)?.[command]).toBe(pressed);
          unit.editor.state.doc.descendants((node) => {
            if (node.isText) {
              textCount += 1;
              expect(node.marks.some(mark => mark.type.name === command)).toBe(pressed);
            }
          });
        }
        expect(textCount).toBeGreaterThan(0);
      }
    });

    it("全部の面が空段落だけなら適用前後とも押下状態は false", () => {
      const units = createToggleSpan([[""], ["", ""]]);
      for (let click = 0; click <= 3; click += 1) {
        for (const unit of units) {
          expect(getTextRunSpanToggleMarkStates(unit.editor)?.[command]).toBe(false);
        }
        if (click < 3) expect(applyTextRunSpanFormat({ command })).toBe(true);
      }
    });
  });

  it("トグル表示は span 全体で判定する (片側だけ太字なら OFF = 押すと追加、と向きが揃う)", () => {
    const { first, second } = createSpanPair();
    first.editor.chain()
      .setTextSelection({ from: 0, to: first.editor.state.doc.content.size })
      .setMark("bold")
      .run();

    // 焦点エディタ単体の isActive は太字 ON でも、span 全体では OFF (applyTextRunSpanFormat
    // は「全範囲が付いているときだけ外す」ので、押すと全体へ追加される側)。
    expect(getTextRunSpanToggleMarkStates(first.editor)?.bold).toBe(false);
    expect(getTextRunSpanToggleMarkStates(second.editor)?.bold).toBe(false);

    second.editor.chain()
      .setTextSelection({ from: 0, to: second.editor.state.doc.content.size })
      .setMark("bold")
      .run();
    expect(getTextRunSpanToggleMarkStates(first.editor)?.bold).toBe(true);
    expect(getTextRunSpanToggleMarkStates(first.editor)?.italic).toBe(false);

    // span が無ければ通常の焦点エディタ判定に任せる (null)。
    clearTextRunSpan();
    expect(getTextRunSpanToggleMarkStates(first.editor)).toBeNull();
  });
});

describe("beginTextRunSpanComposition", () => {
  it("合成エディタの doc / 選択に触れず、他ユニットの担当分だけを削除して span を解除する", () => {
    const { first, second } = createSpanPair();
    const selectionBefore = {
      from: first.editor.state.selection.from,
      to: first.editor.state.selection.to,
    };

    beginTextRunSpanComposition(first.editor.view.dom);

    // 焦点 (合成) エディタは無傷: IME がネイティブ選択を合成テキストで置換する。
    expect(docText(first.editor)).toBe("前半一前半二");
    expect(first.onChange).not.toHaveBeenCalled();
    expect(first.markCrossEditorSync).not.toHaveBeenCalled();
    expect(first.editor.state.selection.from).toBe(selectionBefore.from);
    expect(first.editor.state.selection.to).toBe(selectionBefore.to);

    // もう一方のユニットは担当分 (全域) が削除される。
    expect(second.onChange).toHaveBeenCalledTimes(1);
    const [previousIds, nextBlocks, focusBlockId, context] = second.onChange.mock.calls[0];
    expect(previousIds).toEqual(["p3", "p4"]);
    expect(nextBlocks).toEqual([]);
    expect(focusBlockId).toBeUndefined();
    expect(context?.crossEditor).toBe(true);
    // キャレット bookmark は付けない (復元が IME 中の焦点を奪わないように)。
    expect(context?.selection).toBeUndefined();
    expect(second.markCrossEditorSync).toHaveBeenCalledWith(null);

    expect(getActiveTextRunSpan()).toBeNull();
  });

  it("span のグループ外での合成開始は何もしない", () => {
    const { first, second } = createSpanPair();
    beginTextRunSpanComposition(document.createElement("div"));
    expect(getActiveTextRunSpan()).not.toBeNull();
    expect(first.onChange).not.toHaveBeenCalled();
    expect(second.onChange).not.toHaveBeenCalled();
  });

  it("合成挿入は他ユニット削除と同じ historyGroup に載る (undo 1 回で全体が戻る)", async () => {
    const { first, second } = createSpanPair();

    beginTextRunSpanComposition(first.editor.view.dom);

    const [, , , deletionContext] = second.onChange.mock.calls[0];
    expect(deletionContext?.historyGroup).toBeTruthy();
    // 焦点エディタの onUpdate はこの鍵で合成 transaction を同じ undo グループへ載せる。
    expect(getTextRunSpanCompositionHistoryGroup(first.editor)).toBe(deletionContext?.historyGroup);
    expect(getTextRunSpanCompositionHistoryGroup(second.editor)).toBeNull();

    // 合成が終わると鍵は破棄される (以後の打鍵は通常のグループ分け)。
    first.editor.view.dom.dispatchEvent(new Event("compositionend"));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(getTextRunSpanCompositionHistoryGroup(first.editor)).toBeNull();
  });

  it("compositionend 後に境界の段落断片を合成段落へ結合し、打鍵と同じ最終文書にする", async () => {
    const first = createUnit("unit-a", 0, [
      { id: "p1", text: "前半一" },
      { id: "p2", text: "前半二" },
    ]);
    const second = createUnit("unit-b", 1, [
      { id: "p3", text: "後半一" },
      { id: "p4", text: "後半二" },
    ]);
    cleanups.push(() => {
      first.unregister();
      second.unregister();
      first.editor.destroy();
      second.editor.destroy();
    });

    // アンカーを p1 の途中 (「前」の後) に置き、Shift+→ ×2 で隣ユニットの p3 途中まで
    // 跨ぐ span を張る (前方ドラッグ + IME の形)。
    first.editor.commands.setTextSelection({
      from: 2,
      to: first.editor.state.doc.content.size - 1,
    });
    const shiftRight = () => handleTextRunSpanKeyDown(
      new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true }),
      first.editor.view.dom,
    );
    expect(shiftRight()).toBe(true);
    expect(shiftRight()).toBe(true);
    expect(getActiveTextRunSpan()).not.toBeNull();

    beginTextRunSpanComposition(first.editor.view.dom);

    // 他ユニットは担当分 (p3 の「後」) だけが消え、残余断片が残る。
    const [deletionPreviousIds, deletionBlocks, , deletionContext] = second.onChange.mock.calls[0];
    expect(deletionPreviousIds).toEqual(["p3", "p4"]);
    expect(deletionBlocks.map((block: TextFlowBlock) => block.id)).toEqual(["p3", "p4"]);

    // IME が焦点エディタのネイティブ選択を合成テキストで置換したことを再現する。
    const { state, view } = first.editor;
    view.dispatch(state.tr.insertText("あい", 2, state.doc.content.size));
    expect(docText(first.editor)).toBe("前あい");

    first.editor.view.dom.dispatchEvent(new Event("compositionend"));
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    // 焦点ユニット: 合成段落 (p1) へ終端の残余断片 (p3 の「半一」) が結合される。
    expect(first.onChange).toHaveBeenCalledTimes(1);
    const [joinPreviousIds, joinBlocks, joinFocusId, joinContext] = first.onChange.mock.calls[0];
    expect(joinPreviousIds).toEqual(["p1"]);
    expect(joinBlocks).toHaveLength(1);
    expect(joinBlocks[0].id).toBe("p1");
    expect(joinBlocks[0].children).toEqual([
      { type: "text", text: "前あい" },
      { type: "text", text: "半一" },
    ]);
    expect(joinFocusId).toBe("p1");
    // キャレットは合成テキスト末尾 (結合した断片の手前)。
    expect(joinContext?.selection?.head).toEqual({
      affinity: "after",
      blockId: "p1",
      kind: "text",
      offset: 3,
    });
    expect(joinContext?.crossEditor).toBe(true);
    // 削除・結合とも同じ undo グループ (Cmd+Z 1 回で IME 置換全体が戻る)。
    expect(joinContext?.historyGroup).toBe(deletionContext?.historyGroup);

    // 残余断片を持っていたユニットからは断片が取り除かれる。
    expect(second.onChange).toHaveBeenCalledTimes(2);
    const [removePreviousIds, removeBlocks, , removeContext] = second.onChange.mock.calls[1];
    expect(removePreviousIds).toEqual(["p3", "p4"]);
    expect(removeBlocks.map((block: TextFlowBlock) => block.id)).toEqual(["p4"]);
    expect(removeContext?.historyGroup).toBe(deletionContext?.historyGroup);

    // キャレットの乗る焦点ユニットは受動同期を待たず即時同期される。
    expect(first.applyCrossEditorSync).toHaveBeenCalledTimes(1);
    expect(first.applyCrossEditorSync.mock.calls[0][0]).toBe(joinBlocks);
  });

  it("Cmd+A (両端ともブロック境界) の合成では境界結合は走らない", async () => {
    const { first, second } = createSpanPair();

    beginTextRunSpanComposition(first.editor.view.dom);
    first.editor.view.dom.dispatchEvent(new Event("compositionend"));
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    // 削除 1 回だけで、結合の追加書き込みは無い。
    expect(first.onChange).not.toHaveBeenCalled();
    expect(second.onChange).toHaveBeenCalledTimes(1);
  });
});

describe("clearTextRunSpanOnOutsidePointerDown", () => {
  it("余白への pointerdown は span を消し、フォーカスの残るユニットも含めて状態選択を畳む", () => {
    const { first, second } = createSpanPair();
    // pointerdown の時点では DOM フォーカスがまだ焦点エディタに残っている (blur は後)。
    vi.spyOn(first.editor.view, "hasFocus").mockReturnValue(true);
    expect(first.editor.state.selection.empty).toBe(false);
    expect(second.editor.state.selection.empty).toBe(false);

    clearTextRunSpanOnOutsidePointerDown();

    expect(getActiveTextRunSpan()).toBeNull();
    expect(first.editor.state.selection.empty).toBe(true);
    expect(second.editor.state.selection.empty).toBe(true);
  });

  it("span が無ければ何もしない", () => {
    const first = createUnit("unit-a", 0, [{ id: "p1", text: "本文" }]);
    cleanups.push(() => {
      first.unregister();
      first.editor.destroy();
    });
    first.editor.commands.setTextSelection({ from: 1, to: 3 });

    clearTextRunSpanOnOutsidePointerDown();

    // 単一エディタのネイティブ選択はブラウザ既定 (余白クリック) に任せ、状態には触れない。
    expect(first.editor.state.selection.empty).toBe(false);
  });
});

describe("applyTextRunSpanFormat", () => {
  function firstTextMarks(editor: Editor): string[] {
    let marks: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.isText && marks.length === 0) {
        marks = node.marks.map((mark) => mark.type.name);
        return false;
      }
      return true;
    });
    return marks;
  }

  it("全ユニットの担当範囲へマークを配り、span と各エディタの選択を保つ", () => {
    const { first, second } = createSpanPair();

    expect(applyTextRunSpanFormat({ command: "bold" })).toBe(true);

    expect(firstTextMarks(first.editor)).toContain("bold");
    expect(firstTextMarks(second.editor)).toContain("bold");
    expect(getActiveTextRunSpan()).not.toBeNull();
    // 復元された選択は担当範囲の本文全域を覆う (AllSelection → TextSelection の丸めで
    // 端の block 境界 1 つ分だけ数値は動きうる)。
    const { selection, doc } = first.editor.state;
    expect(selection.empty).toBe(false);
    expect(selection.from).toBeLessThanOrEqual(1);
    expect(selection.to).toBeGreaterThanOrEqual(doc.content.size - 1);
    // 各エディタの変更はそれぞれの onUpdate 経路 (ここでは spy 無し) を通るため、
    // レジストリの onChange は呼ばれない。
    expect(first.onChange).not.toHaveBeenCalled();
    expect(second.onChange).not.toHaveBeenCalled();
  });

  it("keeps every unit selected across repeated sizes and unrelated surface mounts", async () => {
    const { first, second } = createSpanPair();
    for (const size of [13, 14, 15]) {
      expect(applyTextRunSpanFormat({ command: "fontSize", value: String(size) })).toBe(true);
      // Reflow can mount another surface (including a new page's running region).
      const extra = createUnit("extra", 5, [{ id: "extra", text: "新しい面" }]);
      extra.unregister();
      extra.editor.destroy();
      await Promise.resolve();
      expect(getActiveTextRunSpan()).not.toBeNull();
      for (const unit of [first, second]) {
        expect(unit.editor.state.selection.empty).toBe(false);
        expect(unit.editor.view.dom.hasAttribute("data-text-run-span")).toBe(true);
        unit.editor.state.doc.descendants(node => {
          if (node.isText) expect(node.marks.find(mark => mark.type.name === "styledText")?.attrs.fontSize).toBe(size);
        });
      }
    }
    applyTextRunSpanFormat({ command: "bold" });
    expect(firstTextMarks(first.editor)).toContain("bold");
    expect(firstTextMarks(second.editor)).toContain("bold");
  });

  it("rebinds an endpoint to its replacement surface, then clears when that endpoint really disappears", async () => {
    const { first, second } = createSpanPair();
    first.unregister();
    first.editor.destroy();
    const replacement = createUnit("unit-a", 0, [{ id: "p1", text: "前半一" }, { id: "p2", text: "前半二" }]);
    cleanups.push(() => { replacement.unregister(); replacement.editor.destroy(); });
    await Promise.resolve();
    expect(getActiveTextRunSpan()).not.toBeNull();
    expect(replacement.editor.state.selection.empty).toBe(false);
    applyTextRunSpanFormat({ command: "bold" });
    expect(firstTextMarks(replacement.editor)).toContain("bold");
    expect(firstTextMarks(second.editor)).toContain("bold");
    replacement.unregister();
    await Promise.resolve();
    expect(getActiveTextRunSpan()).toBeNull();
  });

  it("publishes updated span state once even when a toolbar menu owns focus", () => {
    const { first, second } = createSpanPair();
    const publish = vi.fn((editor: Editor) => getTextRunSpanFontSize(editor));
    const event = new Event("format");
    applyTextRunSpanFormatForEvent(event, { command: "fontSize", value: "18" }, publish);
    applyTextRunSpanFormatForEvent(event, { command: "fontSize", value: "18" }, publish);
    expect(first.editor.isFocused).toBe(false);
    expect(second.editor.isFocused).toBe(false);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.results[0].value).toEqual({ fontSize: 18, fontSizeMixed: false });
  });

  it("publishes color, background and font from the selected start with an unselected preceding unit", () => {
    const { first } = createSpanPair();
    const preceding = createUnit("preceding", -1, [{ id: "outside", text: "選択外" }]);
    cleanups.push(() => { preceding.unregister(); preceding.editor.destroy(); });
    const publish = vi.fn((editor: Editor) => createTextFormatStateDetail(editor, "document", undefined, { state: editor.state }));
    for (const [command, value] of [["color", "#ff0000"], ["backgroundColor", "#ffff00"], ["fontFamily", "serif"], ["color", "#0000ff"], ["fontFamily", "monospace"]]) {
      applyTextRunSpanFormatForEvent(new Event("format"), { command, value }, publish);
      expect(publish.mock.lastCall?.[0]).toBe(first.editor);
      const state = publish.mock.results.at(-1)!.value;
      expect(state[command as "color" | "backgroundColor" | "fontFamily"]).toBe(value);
      expect(preceding.editor.getAttributes("styledText")[command]).toBeFalsy();
    }
  });

  it("returns focus to the held span on Enter without changing its range or scrolling", () => {
    const { first, second } = createSpanPair();
    document.body.append(first.editor.view.dom.parentElement!, second.editor.view.dom.parentElement!);
    const input = document.createElement("input");
    document.body.append(input);
    cleanups.push(() => { input.remove(); first.editor.view.dom.parentElement?.remove(); second.editor.view.dom.parentElement?.remove(); });
    input.focus();
    const selected = structuredClone(getActiveTextRunSpan());
    const focus = vi.spyOn(first.editor.view, "focus");
    const scroll = vi.spyOn(first.editor.view, "dispatch");
    applyTextRunSpanFormatForEvent(new Event("format"), { command: "fontSize", value: "18", restoreFocus: true });
    expect(document.activeElement).toBe(first.editor.view.dom);
    expect(getActiveTextRunSpan()).toEqual(selected);
    expect(first.editor.state.selection.empty).toBe(false);
    expect(second.editor.state.selection.empty).toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(scroll.mock.calls.some(([transaction]) => transaction.scrolledIntoView)).toBe(false);
    input.focus();
    const doc = first.editor.state.doc;
    applyTextRunSpanFormatForEvent(new Event("format"), { command: "fontSize", value: "18", restoreFocus: true, focusOnly: true });
    expect(first.editor.state.doc).toBe(doc);
    expect(document.activeElement).toBe(first.editor.view.dom);
  });

  it("does not revive a span after structural formatting or an explicit history clear", async () => {
    const { first } = createSpanPair();
    const event = new Event("format");
    applyTextRunSpanFormatForEvent(event, { command: "blockStyle", value: "h1" });
    await Promise.resolve();
    expect(getActiveTextRunSpan()).toBeNull();
    expect(applyTextRunSpanFormatForEvent(event, { command: "blockStyle", value: "h1" })).toBe(true);
    selectEntireTextRun(first.editor);
    refreshTextRunSpanSurfaces();
    clearTextRunSpan();
    await Promise.resolve();
    expect(getActiveTextRunSpan()).toBeNull();
  });

  it("clears after a text edit without reviving when the text is restored in the same task", async () => {
    const { second } = createSpanPair();
    const original = second.editor.getJSON();
    second.editor.view.dispatch(second.editor.state.tr.insertText("追加", 1));
    expect(getActiveTextRunSpan()).toBeNull();
    second.editor.commands.setContent(original, { emitUpdate: false });
    await Promise.resolve();
    expect(getActiveTextRunSpan()).toBeNull();
  });

  function partialSpan(backward: boolean) {
    const first = createUnit("unit-a", 0, [{ id: "p1", text: "abcdefgh" }]);
    const middle = createUnit("unit-middle", 1, [{ id: "middle", text: "途中" }]);
    const last = createUnit("unit-b", 2, [{ id: "p2", text: "ijklmnop" }]);
    cleanups.push(() => [first, middle, last].forEach(unit => { unit.unregister(); unit.editor.destroy(); }));
    const origin = backward ? last : first;
    origin.editor.commands.setTextSelection(backward ? 5 : 2);
    const event = new KeyboardEvent("keydown", { key: backward ? "ArrowUp" : "ArrowDown", shiftKey: true, ctrlKey: true, metaKey: true });
    expect(handleTextRunSpanKeyDown(event, origin.editor.view.dom)).toBe(true);
    expect(getActiveTextRunSpan()).not.toBeNull();
    return { first, middle, last };
  }

  it.each([false, true])("clears insertion projections before the selected text (backward=%s)", async backward => {
    const { first } = partialSpan(backward);
    applyEditorDocumentProjection(first.editor, { type: "doc", content: [paragraphNode("p1", "XXabcdefgh")] });
    expect(getActiveTextRunSpan()).toBeNull();
    await Promise.resolve();
    expect(getActiveTextRunSpan()).toBeNull();
  });

  it.each([false, true])("keeps the original characters through whole/partial mark dispatches and projections (backward=%s)", async backward => {
    const { first, middle, last } = partialSpan(backward);
    await Promise.resolve();
    const selected = () => [first, middle, last].map(({ editor }) => editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to));
    const before = selected();
    for (const projection of [false, true]) {
      for (const partial of [false, true]) {
        for (const unit of [first, middle, last]) {
          const { editor } = unit;
          const from = partial ? 2 : 1;
          const to = partial ? 3 : editor.state.doc.content.size - 1;
          const mark = partial ? editor.schema.marks.styledText.create({ fontSize: 18 }) : editor.schema.marks.bold.create();
          const transaction = editor.state.tr.addMark(from, to, mark);
          if (projection) {
            // Remove marks first so the projection actually has a mark-only diff.
            editor.view.dispatch(editor.state.tr.removeMark(from, to, mark.type));
            applyEditorDocumentProjection(editor, transaction.doc.toJSON());
          } else editor.view.dispatch(transaction);
          await Promise.resolve();
          expect(getActiveTextRunSpan()).not.toBeNull();
          expect(selected()).toEqual(before);
        }
      }
    }
  });

  it("clears when an intermediate unit changes or disappears", async () => {
    const { middle } = partialSpan(false);
    middle.editor.view.dispatch(middle.editor.state.tr.insertText("変", 1));
    expect(getActiveTextRunSpan()).toBeNull();
    selectEntireTextRun(middle.editor);
    middle.unregister();
    await Promise.resolve();
    expect(getActiveTextRunSpan()).toBeNull();
  });

  it.each([false, true])("rebinds a block to another unit only if its entire content is unchanged (changed=%s)", async changed => {
    const { first } = createSpanPair();
    first.unregister();
    const replacement = createUnit("moved-unit", 0, [
      { id: "p1", text: changed ? "XX前半一" : "前半一" }, { id: "p2", text: "前半二" },
    ]);
    cleanups.push(() => { replacement.unregister(); replacement.editor.destroy(); });
    await Promise.resolve();
    if (changed) expect(getActiveTextRunSpan()).toBeNull();
    else expect(getActiveTextRunSpan()?.anchor).toEqual({ unitId: "moved-unit", pos: 1 });
  });

  it("does not rebind a span into another canvas reusing the same group and block IDs", async () => {
    const { first, second } = createSpanPair();
    const previousCanvas = document.createElement("div");
    const nextCanvas = document.createElement("div");
    previousCanvas.className = nextCanvas.className = "page-canvas";
    document.body.append(previousCanvas, nextCanvas);
    previousCanvas.append(first.editor.view.dom.parentElement!, second.editor.view.dom.parentElement!);
    selectEntireTextRun(first.editor);
    first.unregister(); second.unregister();
    const nextFirst = createUnit("next-a", 0, [{ id: "p1", text: "前半一" }, { id: "p2", text: "前半二" }]);
    const nextSecond = createUnit("next-b", 1, [{ id: "p3", text: "後半一" }, { id: "p4", text: "後半二" }]);
    nextCanvas.append(nextFirst.editor.view.dom.parentElement!, nextSecond.editor.view.dom.parentElement!);
    cleanups.push(() => {
      nextFirst.unregister(); nextSecond.unregister(); nextFirst.editor.destroy(); nextSecond.editor.destroy();
      previousCanvas.remove(); nextCanvas.remove();
    });
    await Promise.resolve();
    expect(getActiveTextRunSpan()).toBeNull();
  });

  it("トグルの向きは span 全体で 1 回だけ判定する (片側だけ太字なら全体を太字にする)", () => {
    const { first, second } = createSpanPair();
    // 先に片側だけ太字にしておく。
    first.editor.chain().setTextSelection({ from: 0, to: first.editor.state.doc.content.size }).setMark("bold").run();
    expect(firstTextMarks(first.editor)).toContain("bold");
    expect(firstTextMarks(second.editor)).not.toContain("bold");

    applyTextRunSpanFormat({ command: "bold" });

    expect(firstTextMarks(first.editor)).toContain("bold");
    expect(firstTextMarks(second.editor)).toContain("bold");

    // 全域が太字になった状態でもう一度 → 全域から外れる。
    applyTextRunSpanFormat({ command: "bold" });
    expect(firstTextMarks(first.editor)).not.toContain("bold");
    expect(firstTextMarks(second.editor)).not.toContain("bold");
  });

  it("FORMAT_TEXT_EVENT 経由は同じイベントにつき 1 回だけ適用する", () => {
    const { first, second } = createSpanPair();
    const event = new Event("sigma-studio:format-text");

    // 全ユニットのリスナーが同じイベントで呼ぶ状況を再現。
    expect(applyTextRunSpanFormatForEvent(event, { command: "bold" })).toBe(true);
    expect(applyTextRunSpanFormatForEvent(event, { command: "bold" })).toBe(true);

    // 2 回目が適用されていれば toggle が戻ってマークが消えているはず。
    expect(firstTextMarks(first.editor)).toContain("bold");
    expect(firstTextMarks(second.editor)).toContain("bold");
  });
});

describe("copyActiveTextRunSpan", () => {
  function createDataTransferStub(): { dataTransfer: DataTransfer; data: Map<string, string> } {
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => {
        data.set(type, value);
      },
      getData: (type: string) => data.get(type) ?? "",
    } as unknown as DataTransfer;
    return { dataTransfer, data };
  }

  it("text/html に可視 HTML、private MIME に元 id 付きの結合 slice を書く", () => {
    createSpanPair();
    const { dataTransfer, data } = createDataTransferStub();

    expect(copyActiveTextRunSpan(dataTransfer)).toBe(true);

    const html = data.get("text/html") ?? "";
    // payload div の中に本文の可視 HTML が入る (空 div だと外部アプリへの貼り付けが空になる)。
    expect(html).toContain("前半一");
    expect(html).toContain("後半二");
    expect(extractVisibleEditorClipboardHtml(html)).toContain("前半一");

    const sliceData = JSON.parse(data.get(EDITOR_TEXT_SLICE_MIME) ?? "null") as {
      slice: { content: Array<{ attrs?: { sigmaDocId?: string } }> };
      text: string;
    };
    expect(sliceData.slice.content.map((node) => node.attrs?.sigmaDocId)).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
    ]);
    expect(sliceData.text).toContain("前半一");
  });
});

describe("extractVisibleEditorClipboardHtml", () => {
  it("payload div は中身の可視 HTML を取り出し、素の HTML はそのまま返す", () => {
    const payloadHtml = createEditorClipboardHtml(
      createTextFlowClipboardPayload([{ type: "paragraph", id: "p1", children: [] }]),
      "<p>中身</p>",
    );
    expect(extractVisibleEditorClipboardHtml(payloadHtml)).toBe("<p>中身</p>");
    expect(extractVisibleEditorClipboardHtml("<p>素のHTML</p>")).toBe("<p>素のHTML</p>");
    expect(extractVisibleEditorClipboardHtml("")).toBe("");
  });
});
