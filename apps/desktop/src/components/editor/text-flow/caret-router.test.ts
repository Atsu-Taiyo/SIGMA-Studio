// @vitest-environment happy-dom

import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import { SigmaDocTextAttrs } from "@/components/tiptap/sigma-doc-text-attributes";

import {
  cancelCaretKeeperWindow,
  deliverCaret,
  finishCaretKeeperWindow,
  moveCaretHorizontally,
  moveCaretVertically,
  flushPendingCaret,
  getCaretSurface,
  getCaretSurfaces,
  getCaretSurfacesForBox,
  getFocusedCaretSurfaceUnitIds,
  getTextRunSurfaces,
  registerCaretSurface,
  requestCaret,
  requestCaretKeeperReanchor,
  setFragmentTables,
  startCaretKeeperWindow,
  subscribeCaretKeeperTarget,
  subscribeCaretSurfaceMount,
  subscribeCaretSurfaceUnregister,
  updateCaretSurfaceFacets,
  type CaretSurfaceFacets,
} from "./caret-router";
import type { CaretSurfaceId } from "./caret-router";
import type { TextRunEditorHandle } from "./text-run-span";
import type { TextFlowSelectionBookmark } from "@/features/text-editing";

const cleanups: Array<() => void> = [];

afterEach(() => {
  cancelCaretKeeperWindow();
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
  setFragmentTables({}, {});
  // 保留を持ち越さない (面が 1 つも無い状態で消化すると何も起きない)。
  flushPendingCaret();
  vi.restoreAllMocks();
});

function mockAnimationFrames(): () => number {
  let nextId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = nextId;
    nextId += 1;
    callbacks.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    callbacks.delete(id);
  });
  return () => {
    const scheduled = [...callbacks.entries()];
    callbacks.clear();
    scheduled.forEach(([, callback]) => callback(performance.now()));
    return scheduled.length;
  };
}

function createEditor(text: string): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: createRichTextEngineExtensions({ blockExtensions: [SigmaDocTextAttrs] }),
    content: {
      type: "doc",
      content: [{
        type: "paragraph",
        attrs: { sigmaDocId: "p_1", sigmaDocType: "paragraph" },
        content: [{ type: "text", text }],
      }],
    },
  });
  cleanups.push(() => {
    if (!editor.isDestroyed) {
      editor.destroy();
    }
  });
  return editor;
}

function facets(options: Partial<CaretSurfaceFacets> & { unitId: string }): CaretSurfaceFacets {
  const { unitId, ...rest } = options;
  return {
    boxIds: [],
    fragmentBlockIdFor: () => null,
    order: [0],
    surface: { kind: "unit", unitId },
    ownsBlock: () => false,
    addressAt: () => null,
    posFor: () => null,
    localYFor: () => null,
    caretLineAdvance: () => null,
    focusCaretAtLocalY: () => false,
    focusCaretAtEdge: () => false,
    focusCaretAfterBlock: () => false,
    adjacentTextblockAddress: () => null,
    docEdgeAddress: () => null,
    ensureCaretVisible: () => {},
    applyCaret: () => true,
    textRun: null,
    ...rest,
  };
}

function textRunFacet(editor: Editor, unitId: string, order: number): TextRunEditorHandle {
  return {
    editor,
    groupId: "group",
    unitId,
    order,
    preserveEmpty: false,
    scopeId: unitId,
    getBlocks: () => [],
    markCrossEditorSync: () => {},
    applyCrossEditorSync: () => {},
    onChange: () => {},
  };
}

function register(editor: Editor, options: Partial<CaretSurfaceFacets> & { unitId: string }) {
  const dispose = registerCaretSurface({ editor, ...facets(options) });
  cleanups.push(dispose);
  return dispose;
}

describe("キャレット面の registry", () => {
  it("ファセットの書き換えでは登録が解除されない", () => {
    const editor = createEditor("本文");
    const unregistered = vi.fn();
    cleanups.push(subscribeCaretSurfaceUnregister(unregistered));
    register(editor, { unitId: "u1" });

    updateCaretSurfaceFacets(editor, { order: [3], boxIds: ["box_1"] });

    // 打鍵で担当ブロック列が変わるたびに解除が走ると、その後始末が跨ぎ選択を消す。
    expect(unregistered).not.toHaveBeenCalled();
    expect(getCaretSurface(editor)?.order).toEqual([3]);
    expect(getCaretSurface(editor)?.boxIds).toEqual(["box_1"]);
    expect(getCaretSurface(editor)?.surface).toMatchObject({ unitId: "u1" });
  });

  it("面が実際に外れたときだけ後始末を知らせる", () => {
    const editor = createEditor("本文");
    const unregistered = vi.fn();
    cleanups.push(subscribeCaretSurfaceUnregister(unregistered));
    const dispose = registerCaretSurface({ editor, ...facets({ unitId: "u1" }) });

    dispose();

    expect(unregistered).toHaveBeenCalledTimes(1);
    expect(unregistered.mock.calls[0][0]).toMatchObject({ surface: { unitId: "u1" } });
    expect(getCaretSurface(editor)).toBeNull();

    // 二度目の解除は通知しない (React の StrictMode で cleanup が 2 回走っても安全)。
    dispose();
    expect(unregistered).toHaveBeenCalledTimes(1);
  });

  it("破棄済みのエディタは候補にならない", () => {
    const alive = createEditor("生きている");
    const dead = createEditor("壊れる");
    register(alive, { unitId: "u1" });
    register(dead, { unitId: "u2", boxIds: ["box_1"] });
    dead.destroy();

    expect(getCaretSurfaces().map((handle) => handle.surface)).toEqual([{ kind: "unit", unitId: "u1" }]);
    expect(getCaretSurfacesForBox("box_1")).toEqual([]);
  });

  it("同じ箱を見せている面をすべて返す", () => {
    const source = createEditor("正本");
    const replica = createEditor("複製");
    const other = createEditor("無関係");
    register(source, { unitId: "u1", boxIds: ["box_1"], fragmentBlockIdFor: () => "box_1" });
    register(replica, {
      unitId: "u1",
      boxIds: ["box_1"],
      fragmentBlockIdFor: () => "box_1",
      order: [0, 1],
      surface: { kind: "fragmentReplica", blockId: "box_1", fragmentIndex: 1 },
    });
    register(other, { unitId: "u2" });

    expect(getCaretSurfacesForBox("box_1").map((handle) => handle.order)).toEqual([[0], [0, 1]]);
  });

  it("跨ぎ選択の面はグループで絞り、文書順に並べる", () => {
    const first = createEditor("一");
    const second = createEditor("二");
    register(second, { unitId: "u2", order: [1], textRun: textRunFacet(second, "u2", 1) });
    register(first, { unitId: "u1", order: [0], textRun: textRunFacet(first, "u1", 0) });

    expect(getTextRunSurfaces("group").map((handle) => handle.unitId)).toEqual(["u1", "u2"]);
    expect(getTextRunSurfaces("other")).toEqual([]);
  });

  it("フォーカス中のユニット id を registry から返せる", () => {
    const editor = createEditor("本文");
    register(editor, { unitId: "u1", textRun: textRunFacet(editor, "u1", 0) });

    expect(getFocusedCaretSurfaceUnitIds()).toEqual(new Set());

    vi.spyOn(editor, "isFocused", "get").mockReturnValue(true);

    // 再チャンクの安全弁。ここが空になると、開いて最初の 1 打鍵でユニットが再マウントする。
    expect(getFocusedCaretSurfaceUnitIds()).toEqual(new Set(["u1"]));
  });

  it("focused な面の解除時に現在の選択を後継面へ再配送する", () => {
    const source = createEditor("本文");
    const sourceDispose = registerCaretSurface({
      editor: source,
      ...facets({
        unitId: "u1",
        ownsBlock: (blockId) => blockId === "p_1",
        addressAt: (position) => ({
          affinity: "after",
          blockId: "p_1",
          kind: "text",
          offset: position,
        }),
      }),
    });
    vi.spyOn(source, "isFocused", "get").mockReturnValue(true);
    source.commands.setTextSelection(3);
    const currentPosition = source.state.selection.head;

    sourceDispose();

    const successor = createEditor("本文");
    const applyCaret = vi.fn(() => true);
    register(successor, {
      unitId: "u2",
      ownsBlock: (blockId) => blockId === "p_1",
      applyCaret,
    });

    expect(applyCaret).toHaveBeenCalledTimes(1);
    expect(applyCaret).toHaveBeenCalledWith({
      anchor: expect.objectContaining({ blockId: "p_1", offset: currentPosition }),
      head: expect.objectContaining({ blockId: "p_1", offset: currentPosition }),
      preferredX: null,
    });
  });

  it("DOM focus が先に BODY へ落ちても直近の surface の選択を後継面へ再配送する", () => {
    const source = createEditor("本文");
    const sourceDispose = registerCaretSurface({
      editor: source,
      ...facets({
        unitId: "u1",
        ownsBlock: (blockId) => blockId === "p_1",
        addressAt: (position) => ({
          affinity: "after",
          blockId: "p_1",
          kind: "text",
          offset: position,
        }),
      }),
    });
    document.body.append(source.view.dom);
    source.view.dom.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    vi.spyOn(source, "isFocused", "get").mockReturnValue(false);
    source.commands.setTextSelection(3);

    sourceDispose();

    const successor = createEditor("本文");
    const applyCaret = vi.fn(() => true);
    register(successor, {
      unitId: "u2",
      ownsBlock: (blockId) => blockId === "p_1",
      applyCaret,
    });

    expect(applyCaret).toHaveBeenCalledTimes(1);
    expect(applyCaret).toHaveBeenCalledWith({
      anchor: expect.objectContaining({ blockId: "p_1" }),
      head: expect.objectContaining({ blockId: "p_1" }),
      preferredX: null,
    });
  });

  it("focused surface の解除前にある pending を古い選択で上書きしない", () => {
    const source = createEditor("本文");
    const sourceDispose = registerCaretSurface({
      editor: source,
      ...facets({
        unitId: "u1",
        ownsBlock: (blockId) => blockId === "p_1",
        addressAt: (position) => ({
          affinity: "after",
          blockId: "p_1",
          kind: "text",
          offset: position,
        }),
      }),
    });
    vi.spyOn(source, "isFocused", "get").mockReturnValue(true);
    source.commands.setTextSelection(3);
    const intendedSelection = {
      anchor: { affinity: "after" as const, blockId: "p_1", kind: "text" as const, offset: 1 },
      head: { affinity: "after" as const, blockId: "p_1", kind: "text" as const, offset: 1 },
      preferredX: null,
    };
    requestCaret(intendedSelection);

    sourceDispose();

    const successor = createEditor("本文");
    const applyCaret = vi.fn(() => true);
    register(successor, {
      unitId: "u2",
      ownsBlock: (blockId) => blockId === "p_1",
      applyCaret,
    });

    expect(applyCaret).toHaveBeenCalledTimes(1);
    expect(applyCaret).toHaveBeenCalledWith(intendedSelection);
  });

  it("別の UI へ明示的に focus した後は stale な surface を再アームしない", () => {
    const source = createEditor("本文");
    const sourceDispose = registerCaretSurface({
      editor: source,
      ...facets({
        unitId: "u1",
        ownsBlock: (blockId) => blockId === "p_1",
        addressAt: (position) => ({
          affinity: "after",
          blockId: "p_1",
          kind: "text",
          offset: position,
        }),
      }),
    });
    document.body.append(source.view.dom);
    source.view.dom.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    const button = document.createElement("button");
    document.body.append(button);
    button.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    vi.spyOn(source, "isFocused", "get").mockReturnValue(false);

    sourceDispose();

    const successor = createEditor("本文");
    const applyCaret = vi.fn(() => true);
    register(successor, {
      unitId: "u2",
      ownsBlock: (blockId) => blockId === "p_1",
      applyCaret,
    });

    expect(applyCaret).not.toHaveBeenCalled();
    button.remove();
  });
});


// --- 配送 -------------------------------------------------------------------

/**
 * 高さ 300 のブロックが 3 面に分かれている紙面。正本が 0〜120、複製 1 が 120〜240、
 * 複製 2 が 240〜300 を見せている。
 */
function installFragmentTable(): void {
  setFragmentTables(
    { box_1: { visibleHeight: 120, totalHeight: 300 } },
    {
      box_1: [
        { fragmentIndex: 1, sourceOffsetY: 120, height: 120 },
        { fragmentIndex: 2, sourceOffsetY: 240, height: 60 },
      ],
    },
  );
}

interface FragmentSurface {
  applyCaret: ReturnType<typeof vi.fn>;
  editor: Editor;
  localYFor: ReturnType<typeof vi.fn>;
}

function registerFragmentSurface(
  surface: CaretSurfaceId,
  localY: number | null,
): FragmentSurface {
  const editor = createEditor("箱の中");
  const applyCaret = vi.fn(() => true);
  const localYFor = vi.fn(() => localY);
  const dispose = registerCaretSurface({
    editor,
    boxIds: ["box_1"],
    fragmentBlockIdFor: () => "box_1",
    order: surface.kind === "fragmentReplica" ? [0, surface.fragmentIndex ?? 0] : [0],
    surface,
    ownsBlock: (blockId) => blockId === "box_p",
    addressAt: () => null,
    posFor: () => null,
    localYFor,
    caretLineAdvance: () => null,
    focusCaretAtLocalY: () => false,
    focusCaretAtEdge: () => false,
    focusCaretAfterBlock: () => false,
    adjacentTextblockAddress: () => null,
    docEdgeAddress: () => null,
    ensureCaretVisible: () => {},
    applyCaret,
    textRun: null,
  });
  cleanups.push(dispose);
  return { applyCaret, editor, localYFor };
}

const caretInBox = {
  anchor: { affinity: "after" as const, blockId: "box_p", kind: "text" as const, offset: 0 },
  head: { affinity: "after" as const, blockId: "box_p", kind: "text" as const, offset: 0 },
  preferredX: null,
};

describe("キャレットの配送", () => {
  it("未 mount の keeper 配送先を優先 hydrate 用に通知する", () => {
    const targets: string[] = [];
    cleanups.push(subscribeCaretKeeperTarget((blockId) => targets.push(blockId)));
    startCaretKeeperWindow();

    expect(deliverCaret({
      ...caretInBox,
      anchor: { ...caretInBox.anchor, blockId: "not_mounted" },
      head: { ...caretInBox.head, blockId: "not_mounted" },
    })).toBe(false);

    expect(targets).toEqual(["not_mounted"]);
  });

  it("整定中の再アンカーを frame ごとに 1 回へ畳む", () => {
    const runNextFrame = mockAnimationFrames();
    const editor = createEditor("本文");
    const ensureCaretVisible = vi.fn();
    register(editor, {
      unitId: "u1",
      ownsBlock: (blockId) => blockId === "p_1",
      ensureCaretVisible,
    });
    startCaretKeeperWindow();
    expect(deliverCaret({
      ...caretInBox,
      anchor: { ...caretInBox.anchor, blockId: "p_1" },
      head: { ...caretInBox.head, blockId: "p_1" },
    })).toBe(true);

    requestCaretKeeperReanchor();
    requestCaretKeeperReanchor();
    runNextFrame();

    expect(ensureCaretVisible).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["wheel", () => window.dispatchEvent(new WheelEvent("wheel"))],
    ["touch", () => window.dispatchEvent(new Event("touchstart"))],
    ["click", () => window.dispatchEvent(new Event("pointerdown"))],
    ["navigation key", () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown" }))],
  ])("手動 %s 後は再アンカーしない", (_label, navigate) => {
    const runNextFrame = mockAnimationFrames();
    const editor = createEditor("本文");
    const ensureCaretVisible = vi.fn();
    register(editor, {
      unitId: "u1",
      ownsBlock: (blockId) => blockId === "p_1",
      ensureCaretVisible,
    });
    startCaretKeeperWindow();
    expect(deliverCaret({
      ...caretInBox,
      anchor: { ...caretInBox.anchor, blockId: "p_1" },
      head: { ...caretInBox.head, blockId: "p_1" },
    })).toBe(true);
    requestCaretKeeperReanchor();

    navigate();
    runNextFrame();

    expect(ensureCaretVisible).not.toHaveBeenCalled();
  });

  it("整定中に DOM focus が BODY へ落ちたら現在選択を読み直して再配送する", () => {
    const runNextFrame = mockAnimationFrames();
    const editor = createEditor("本文");
    const applyCaret = vi.fn(() => {
      if (applyCaret.mock.calls.length >= 2) {
        editor.view.dom.focus();
      }
      return true;
    });
    const ensureCaretVisible = vi.fn();
    register(editor, {
      unitId: "u1",
      ownsBlock: (blockId) => blockId === "p_1",
      addressAt: (position) => ({
        affinity: "after",
        blockId: "p_1",
        kind: "text",
        offset: position,
      }),
      applyCaret,
      ensureCaretVisible,
    });
    document.body.append(editor.view.dom);
    startCaretKeeperWindow();
    const selection = {
      ...caretInBox,
      anchor: { ...caretInBox.anchor, blockId: "p_1" },
      head: { ...caretInBox.head, blockId: "p_1" },
    };
    expect(deliverCaret(selection)).toBe(true);
    editor.commands.setTextSelection(3);
    const currentPosition = editor.state.selection.head;

    editor.view.dom.dispatchEvent(new FocusEvent("focusout", {
      bubbles: true,
      relatedTarget: null,
    }));
    expect(applyCaret).toHaveBeenCalledTimes(1);

    runNextFrame();

    expect(applyCaret).toHaveBeenCalledTimes(2);
    expect(applyCaret).toHaveBeenLastCalledWith({
      anchor: expect.objectContaining({ blockId: "p_1", offset: currentPosition }),
      head: expect.objectContaining({ blockId: "p_1", offset: currentPosition }),
      preferredX: null,
    });
    expect(ensureCaretVisible).toHaveBeenCalledTimes(1);

    finishCaretKeeperWindow();
    runNextFrame();
    runNextFrame();
    editor.view.dom.dispatchEvent(new FocusEvent("focusout", {
      bubbles: true,
      relatedTarget: null,
    }));
    expect(applyCaret).toHaveBeenCalledTimes(2);
    // 次の test へ unregister 再アームを持ち越さない。
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    outside.remove();
  });

  it("整定中でも別 UI が意図的に focus されたら再配送しない", () => {
    const runNextFrame = mockAnimationFrames();
    const editor = createEditor("本文");
    const applyCaret = vi.fn(() => true);
    register(editor, {
      unitId: "u1",
      ownsBlock: (blockId) => blockId === "p_1",
      addressAt: () => caretInBox.head,
      applyCaret,
    });
    document.body.append(editor.view.dom);
    const button = document.createElement("button");
    document.body.append(button);
    startCaretKeeperWindow();
    expect(deliverCaret({
      ...caretInBox,
      anchor: { ...caretInBox.anchor, blockId: "p_1" },
      head: { ...caretInBox.head, blockId: "p_1" },
    })).toBe(true);

    editor.view.dom.dispatchEvent(new FocusEvent("focusout", {
      bubbles: true,
      relatedTarget: button,
    }));

    runNextFrame();
    expect(applyCaret).toHaveBeenCalledTimes(1);
    button.remove();
  });

  it("window blur 中は再配送枠を消費せず、復帰後に現在状態を検査する", () => {
    const runNextFrame = mockAnimationFrames();
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const editor = createEditor("本文");
    const applyCaret = vi.fn(() => true);
    register(editor, {
      unitId: "u1",
      ownsBlock: (blockId) => blockId === "p_1",
      addressAt: (position) => ({
        affinity: "after",
        blockId: "p_1",
        kind: "text",
        offset: position,
      }),
      applyCaret,
    });
    document.body.append(editor.view.dom);
    startCaretKeeperWindow();
    expect(deliverCaret({
      ...caretInBox,
      anchor: { ...caretInBox.anchor, blockId: "p_1" },
      head: { ...caretInBox.head, blockId: "p_1" },
    })).toBe(true);

    editor.view.dom.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    runNextFrame();
    expect(applyCaret).toHaveBeenCalledTimes(1);

    hasFocus.mockReturnValue(true);
    window.dispatchEvent(new Event("focus"));
    runNextFrame();
    expect(applyCaret).toHaveBeenCalledTimes(2);
  });

  it("外部 control への focus で keeper 世代の pending だけを取り消す", () => {
    const runNextFrame = mockAnimationFrames();
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const editor = createEditor("本文");
    const applyCaret = vi.fn(() => applyCaret.mock.calls.length === 1);
    const dispose = registerCaretSurface({
      editor,
      ...facets({
        unitId: "u1",
        ownsBlock: (blockId) => blockId === "p_1",
        addressAt: (position) => ({
          affinity: "after",
          blockId: "p_1",
          kind: "text",
          offset: position,
        }),
        applyCaret,
      }),
    });
    document.body.append(editor.view.dom);
    startCaretKeeperWindow();
    expect(deliverCaret({
      ...caretInBox,
      anchor: { ...caretInBox.anchor, blockId: "p_1" },
      head: { ...caretInBox.head, blockId: "p_1" },
    })).toBe(true);

    editor.view.dom.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    runNextFrame();
    expect(applyCaret).toHaveBeenCalledTimes(2);

    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    dispose();

    const successor = createEditor("本文");
    const successorApplyCaret = vi.fn(() => true);
    register(successor, {
      unitId: "u2",
      ownsBlock: (blockId) => blockId === "p_1",
      applyCaret: successorApplyCaret,
    });

    expect(successorApplyCaret).not.toHaveBeenCalled();
    button.remove();
  });

  it("宛先は断片の表が決めた 1 面だけ", () => {
    installFragmentTable();
    // 縦位置 200 はブロックの [120, 240) = 複製 1 の帯。
    const source = registerFragmentSurface({ kind: "unit", unitId: "u1" }, 200);
    const replica1 = registerFragmentSurface(
      { kind: "fragmentReplica", blockId: "box_1", fragmentIndex: 1 },
      200,
    );
    const replica2 = registerFragmentSurface(
      { kind: "fragmentReplica", blockId: "box_1", fragmentIndex: 2 },
      200,
    );

    expect(deliverCaret(caretInBox)).toBe(true);

    expect(replica1.applyCaret).toHaveBeenCalledTimes(1);
    expect(source.applyCaret).not.toHaveBeenCalled();
    expect(replica2.applyCaret).not.toHaveBeenCalled();
  });

  it("断片が何個あっても縦位置を測るのは 1 面だけ", () => {
    installFragmentTable();
    const source = registerFragmentSurface({ kind: "unit", unitId: "u1" }, 60);
    const replica1 = registerFragmentSurface(
      { kind: "fragmentReplica", blockId: "box_1", fragmentIndex: 1 },
      60,
    );
    const replica2 = registerFragmentSurface(
      { kind: "fragmentReplica", blockId: "box_1", fragmentIndex: 2 },
      60,
    );

    deliverCaret(caretInBox);

    const measured = source.localYFor.mock.calls.length
      + replica1.localYFor.mock.calls.length
      + replica2.localYFor.mock.calls.length;
    // 面ごとに `doc.descendants` を走らせると、100 ページの箱で走査が 100 回になる。
    expect(measured).toBe(1);
    expect(source.applyCaret).toHaveBeenCalledTimes(1);
  });

  it("未マウントの宛先はマウントを頼んで保留する", () => {
    installFragmentTable();
    const requested: CaretSurfaceId[] = [];
    cleanups.push(subscribeCaretSurfaceMount((surface) => requested.push(surface)));
    const source = registerFragmentSurface({ kind: "unit", unitId: "u1" }, 260);

    expect(deliverCaret(caretInBox)).toBe(false);
    expect(source.applyCaret).not.toHaveBeenCalled();
    expect(requested).toEqual([{ kind: "fragmentReplica", blockId: "box_1", fragmentIndex: 2 }]);

    // 頼まれた面が現れた瞬間に消化する (タイマーで待たない)。
    const replica2 = registerFragmentSurface(
      { kind: "fragmentReplica", blockId: "box_1", fragmentIndex: 2 },
      260,
    );
    expect(replica2.applyCaret).toHaveBeenCalledTimes(1);
  });

  it("保留は新しい要求で上書きされる", () => {
    installFragmentTable();
    const source = registerFragmentSurface({ kind: "unit", unitId: "u1" }, 60);

    requestCaret({
      ...caretInBox,
      head: { ...caretInBox.head, offset: 1 },
    });
    requestCaret(caretInBox);
    flushPendingCaret();

    expect(source.applyCaret).toHaveBeenCalledTimes(1);
    expect(source.applyCaret).toHaveBeenCalledWith(caretInBox);
  });

  it("宛先が断片の表から消えたら保留を捨てる", () => {
    installFragmentTable();
    const source = registerFragmentSurface({ kind: "unit", unitId: "u1" }, 260);
    deliverCaret(caretInBox);

    // 再ページ割りでこのブロックが跨がなくなった。
    setFragmentTables({}, {});
    flushPendingCaret();

    expect(source.applyCaret).not.toHaveBeenCalled();
  });

  it("IME 合成中は配送しない", () => {
    installFragmentTable();
    const source = registerFragmentSurface({ kind: "unit", unitId: "u1" }, 60);
    const composing = vi.spyOn(source.editor.view, "composing", "get").mockReturnValue(true);

    expect(deliverCaret(caretInBox)).toBe(false);
    expect(source.applyCaret).not.toHaveBeenCalled();

    composing.mockReturnValue(false);
    source.editor.view.dom.dispatchEvent(new Event("compositionend"));

    expect(source.applyCaret).toHaveBeenCalledTimes(1);
  });

  it("1 ユニットに分割ブロックが 2 つあっても、キャレットのある方の表で決める", () => {
    // P5 は [0,120)+複製、P30 は [0,40)+複製。P30 の 60px 目は P30 の複製 1。
    setFragmentTables(
      {
        block_5: { visibleHeight: 120, totalHeight: 300 },
        block_30: { visibleHeight: 40, totalHeight: 200 },
      },
      {
        block_5: [{ fragmentIndex: 1, sourceOffsetY: 120, height: 180 }],
        block_30: [{ fragmentIndex: 1, sourceOffsetY: 40, height: 160 }],
      },
    );
    const unit = createEditor("ユニット");
    const replica30 = createEditor("複製");
    const unitApply = vi.fn(() => true);
    const replicaApply = vi.fn(() => true);
    cleanups.push(registerCaretSurface({
      editor: unit,
      ...facets({
        unitId: "u1",
        boxIds: ["block_5", "block_30"],
        // 面ごとに 1 つへ潰すと、P30 のキャレットを P5 の表で読んでしまう。
        fragmentBlockIdFor: (blockId) => (blockId === "leaf_30" ? "block_30" : "block_5"),
        localYFor: (_address, containerBlockId) => (containerBlockId === "block_30" ? 60 : 0),
        applyCaret: unitApply,
        ownsBlock: () => true,
      }),
    }));
    cleanups.push(registerCaretSurface({
      editor: replica30,
      ...facets({
        unitId: "u1",
        boxIds: ["block_30"],
        surface: { kind: "fragmentReplica", blockId: "block_30", fragmentIndex: 1 },
        fragmentBlockIdFor: () => "block_30",
        localYFor: () => 60,
        applyCaret: replicaApply,
        ownsBlock: () => true,
      }),
    }));

    expect(deliverCaret({
      anchor: { affinity: "after", blockId: "leaf_30", kind: "text", offset: 0 },
      head: { affinity: "after", blockId: "leaf_30", kind: "text", offset: 0 },
      preferredX: null,
    })).toBe(true);

    expect(replicaApply).toHaveBeenCalledTimes(1);
    expect(unitApply).not.toHaveBeenCalled();
  });

  it("断片 0 は測った面ではなく正本へ配る", () => {
    installFragmentTable();
    // 正本より先に複製が登録される (再チャンク中に起こりうる)。
    const replica1 = registerFragmentSurface(
      { kind: "fragmentReplica", blockId: "box_1", fragmentIndex: 1 },
      60,
    );
    const source = registerFragmentSurface({ kind: "unit", unitId: "u1" }, 60);

    expect(deliverCaret(caretInBox)).toBe(true);
    expect(source.applyCaret).toHaveBeenCalledTimes(1);
    expect(replica1.applyCaret).not.toHaveBeenCalled();
  });

  it("表が更新されても、待っている断片が残っていれば保留を捨てない", () => {
    installFragmentTable();
    const source = registerFragmentSurface({ kind: "unit", unitId: "u1" }, 260);
    expect(deliverCaret(caretInBox)).toBe(false);

    // 同じブロックの表が更新されただけ。キャレットの葉ブロック id は表の鍵ではないので、
    // それで判定すると必ず捨ててしまう。
    installFragmentTable();

    const replica2 = registerFragmentSurface(
      { kind: "fragmentReplica", blockId: "box_1", fragmentIndex: 2 },
      260,
    );
    expect(replica2.applyCaret).toHaveBeenCalledTimes(1);
    expect(source.applyCaret).not.toHaveBeenCalled();
  });

  it("同じブロックを持つ面が複数あれば文書順を持つ本文面を選ぶ", () => {
    const body = createEditor("本文");
    const dialog = createEditor("素材ダイアログ");
    const bodyApply = vi.fn(() => true);
    const dialogApply = vi.fn(() => true);
    cleanups.push(registerCaretSurface({
      editor: dialog,
      ...facets({ unitId: "dialog", order: [], applyCaret: dialogApply, ownsBlock: () => true }),
    }));
    cleanups.push(registerCaretSurface({
      editor: body,
      ...facets({ unitId: "u1", order: [0], applyCaret: bodyApply, ownsBlock: () => true }),
    }));

    expect(deliverCaret(caretInBox)).toBe(true);
    expect(bodyApply).toHaveBeenCalledTimes(1);
    expect(dialogApply).not.toHaveBeenCalled();
  });

  it("焦点のある面が対象ならそちらを選ぶ", () => {
    const body = createEditor("本文");
    const dialog = createEditor("素材ダイアログ");
    const bodyApply = vi.fn(() => true);
    const dialogApply = vi.fn(() => true);
    vi.spyOn(dialog, "isFocused", "get").mockReturnValue(true);
    cleanups.push(registerCaretSurface({
      editor: body,
      ...facets({ unitId: "u1", order: [0], applyCaret: bodyApply, ownsBlock: () => true }),
    }));
    cleanups.push(registerCaretSurface({
      editor: dialog,
      ...facets({ unitId: "dialog", order: [], applyCaret: dialogApply, ownsBlock: () => true }),
    }));

    expect(deliverCaret(caretInBox)).toBe(true);
    expect(dialogApply).toHaveBeenCalledTimes(1);
    expect(bodyApply).not.toHaveBeenCalled();
  });
});


// --- 上下移動 ---------------------------------------------------------------

interface MoveSurface {
  editor: Editor;
  focusCaretAfterBlock: ReturnType<typeof vi.fn>;
  focusCaretAtEdge: ReturnType<typeof vi.fn>;
  focusCaretAtLocalY: ReturnType<typeof vi.fn>;
}

/**
 * 上下移動用の面。`localY` と行高は fixture が持つ (DOM の採寸を happy-dom に頼らない)。
 */
function registerMoveSurface(options: {
  surface: CaretSurfaceId;
  localY: number | null;
  lineHeight?: number | null;
  order?: readonly number[];
  containerBlockId?: string | null;
  ownsBlock?: (blockId: string) => boolean;
}): MoveSurface {
  const editor = createEditor("箱の中の行");
  const focusCaretAtLocalY = vi.fn(() => true);
  const focusCaretAtEdge = vi.fn(() => true);
  const focusCaretAfterBlock = vi.fn(() => true);
  const containerBlockId = options.containerBlockId === undefined
    ? "box_1"
    : options.containerBlockId;
  cleanups.push(registerCaretSurface({
    editor,
    ...facets({
      unitId: options.surface.unitId ?? "u1",
      surface: options.surface,
      order: options.order ?? [0],
      boxIds: containerBlockId ? [containerBlockId] : [],
      fragmentBlockIdFor: () => containerBlockId,
      addressAt: () => caretInBox.head,
      localYFor: () => options.localY,
      caretLineAdvance: () => options.lineHeight === undefined ? 20 : options.lineHeight,
      ownsBlock: options.ownsBlock ?? (() => true),
      focusCaretAtLocalY,
      focusCaretAtEdge,
      focusCaretAfterBlock,
    }),
  }));
  return { editor, focusCaretAfterBlock, focusCaretAtEdge, focusCaretAtLocalY };
}

describe("moveCaretVertically", () => {
  it("同じ断片内の移動には介入しない", () => {
    installFragmentTable();
    const source = registerMoveSurface({ surface: { kind: "unit", unitId: "u1" }, localY: 20 });

    // 折り返し・双方向テキスト・数式ノードビューの中まで自前で持たない。
    expect(moveCaretVertically(source.editor.view.dom, "down", 100)).toBe(false);
    expect(source.focusCaretAtLocalY).not.toHaveBeenCalled();
  });

  it("正本の最終行から下は断片 1 へ配送する", () => {
    installFragmentTable();
    const source = registerMoveSurface({ surface: { kind: "unit", unitId: "u1" }, localY: 110 });
    const replica1 = registerMoveSurface({
      surface: { kind: "fragmentReplica", blockId: "box_1", fragmentIndex: 1 },
      localY: 110,
      order: [0, 1],
    });

    expect(moveCaretVertically(source.editor.view.dom, "down", 42)).toBe(true);
    expect(replica1.focusCaretAtLocalY).toHaveBeenCalledWith({
      containerBlockId: "box_1",
      localY: 130,
      preferredX: 42,
    });
    expect(source.focusCaretAtLocalY).not.toHaveBeenCalled();
  });

  it("断片 1 の先頭行から上は正本へ配送する", () => {
    installFragmentTable();
    const source = registerMoveSurface({ surface: { kind: "unit", unitId: "u1" }, localY: 130 });
    const replica1 = registerMoveSurface({
      surface: { kind: "fragmentReplica", blockId: "box_1", fragmentIndex: 1 },
      localY: 130,
      order: [0, 1],
    });

    expect(moveCaretVertically(replica1.editor.view.dom, "up", 42)).toBe(true);
    expect(source.focusCaretAtLocalY).toHaveBeenCalledWith({
      containerBlockId: "box_1",
      localY: 110,
      preferredX: 42,
    });
  });

  it("往復して同じ縦位置に戻る（境界からずれた開始位置でも）", () => {
    installFragmentTable();
    // 117 -> 137 (断片 1) -> 117 (正本)。境界 120 に揃っていない開始位置。
    const source = registerMoveSurface({ surface: { kind: "unit", unitId: "u1" }, localY: 117 });
    const replica1 = registerMoveSurface({
      surface: { kind: "fragmentReplica", blockId: "box_1", fragmentIndex: 1 },
      localY: 137,
      order: [0, 1],
    });

    expect(moveCaretVertically(source.editor.view.dom, "down", 42)).toBe(true);
    expect(replica1.focusCaretAtLocalY).toHaveBeenCalledWith(
      expect.objectContaining({ localY: 137 }),
    );
    expect(moveCaretVertically(replica1.editor.view.dom, "up", 42)).toBe(true);
    expect(source.focusCaretAtLocalY).toHaveBeenCalledWith(
      expect.objectContaining({ localY: 117 }),
    );
  });

  it("行高より薄い断片を挟んでも 1 行ぶんの移動量が削られない", () => {
    // 正本 [0,200)、断片 1 は 10px だけ、断片 2 が [210,310)。
    setFragmentTables(
      { box_1: { visibleHeight: 200, totalHeight: 310 } },
      {
        box_1: [
          { fragmentIndex: 1, sourceOffsetY: 200, height: 10 },
          { fragmentIndex: 2, sourceOffsetY: 210, height: 100 },
        ],
      },
    );
    const source = registerMoveSurface({ surface: { kind: "unit", unitId: "u1" }, localY: 190 });
    const replica2 = registerMoveSurface({
      surface: { kind: "fragmentReplica", blockId: "box_1", fragmentIndex: 2 },
      localY: 190,
      order: [0, 2],
    });

    expect(moveCaretVertically(source.editor.view.dom, "down", 42)).toBe(true);
    // 210 (= 190 + 20)。薄い断片で削ると 200 に潰れ、↑ で 180 へ流れていく。
    expect(replica2.focusCaretAtLocalY).toHaveBeenCalledWith(
      expect.objectContaining({ localY: 210 }),
    );
  });

  it("preferredX をそのまま行き先の面へ渡す", () => {
    installFragmentTable();
    const source = registerMoveSurface({ surface: { kind: "unit", unitId: "u1" }, localY: 110 });
    const replica1 = registerMoveSurface({
      surface: { kind: "fragmentReplica", blockId: "box_1", fragmentIndex: 1 },
      localY: 110,
      order: [0, 1],
    });

    moveCaretVertically(source.editor.view.dom, "down", 321.5);
    expect(replica1.focusCaretAtLocalY).toHaveBeenCalledWith(
      expect.objectContaining({ preferredX: 321.5 }),
    );
  });

  it("ブロックの外へ出る下移動は正本の「箱の次のブロック」へ渡す", () => {
    installFragmentTable();
    const source = registerMoveSurface({ surface: { kind: "unit", unitId: "u1" }, localY: 295 });
    const replica2 = registerMoveSurface({
      surface: { kind: "fragmentReplica", blockId: "box_1", fragmentIndex: 2 },
      localY: 295,
      order: [0, 2],
    });

    expect(moveCaretVertically(replica2.editor.view.dom, "down", 42)).toBe(true);
    // 箱の後ろの本文は**正本の doc**にある。別のユニットへ飛ばしてはいけない。
    expect(source.focusCaretAfterBlock).toHaveBeenCalledWith("box_1", "down", 42);
  });

  it("順番を持たない面 (素材ダイアログ・ヘッダ/フッタ) は行き先にならない", () => {
    setFragmentTables({}, {});
    const body = registerMoveSurface({
      surface: { kind: "unit", unitId: "u1" },
      localY: null,
      containerBlockId: null,
      order: [0],
    });
    const dialog = registerMoveSurface({
      surface: { kind: "richText", blockId: "material" },
      localY: null,
      containerBlockId: null,
      order: [],
    });

    // 本文の端まで来ても、順番を持たない面へは移らない (ネイティブに任せる)。
    vi.spyOn(body.editor.view, "endOfTextblock").mockReturnValue(true);
    expect(moveCaretVertically(body.editor.view.dom, "down", 42)).toBe(false);
    expect(dialog.focusCaretAtEdge).not.toHaveBeenCalled();

    // 素材ダイアログの中からの上下移動も本文へ漏れない。
    vi.spyOn(dialog.editor.view, "endOfTextblock").mockReturnValue(true);
    expect(moveCaretVertically(dialog.editor.view.dom, "up", 42)).toBe(false);
    expect(body.focusCaretAtEdge).not.toHaveBeenCalled();
  });

  it("ユニットの端では文書順で隣のユニットの端の行へ移る", () => {
    setFragmentTables({}, {});
    const first = registerMoveSurface({
      surface: { kind: "unit", unitId: "u1" },
      localY: null,
      containerBlockId: null,
      order: [0],
    });
    const second = registerMoveSurface({
      surface: { kind: "unit", unitId: "u2" },
      localY: null,
      containerBlockId: null,
      order: [1],
    });
    vi.spyOn(first.editor.view, "endOfTextblock").mockReturnValue(true);

    expect(moveCaretVertically(first.editor.view.dom, "down", 42)).toBe(true);
    expect(second.focusCaretAtEdge).toHaveBeenCalledWith("top", 42);
  });

  it("破棄済みの面からは動かさない", () => {
    installFragmentTable();
    const source = registerMoveSurface({ surface: { kind: "unit", unitId: "u1" }, localY: 110 });
    const dom = source.editor.view.dom;
    source.editor.destroy();

    expect(moveCaretVertically(dom, "down", 42)).toBe(false);
  });
});

describe("moveCaretVertically と複製の逆流", () => {
  it("複製は隣の面の候補にならない (箱より後ろの本文の末尾から箱の頭へ逆戻りしない)", () => {
    installFragmentTable();
    // キャレットは箱の**外**の本文 (ユニットの末尾)。
    const source = registerMoveSurface({
      surface: { kind: "unit", unitId: "u1" },
      localY: null,
      containerBlockId: null,
      ownsBlock: (blockId) => blockId !== "next_unit_p",
    });
    const replica = registerMoveSurface({
      surface: { kind: "fragmentReplica", blockId: "box_1", fragmentIndex: 1 },
      localY: null,
      order: [0, 1],
    });
    vi.spyOn(source.editor.view, "endOfTextblock").mockReturnValue(true);

    // 隣のユニットが無ければ何もしない (複製へ跳ぶくらいならネイティブに任せる)。
    expect(moveCaretVertically(source.editor.view.dom, "down", 42)).toBe(false);
    expect(replica.focusCaretAtEdge).not.toHaveBeenCalled();
  });

  it("隣のユニットの端が分割ブロックの中なら、その帯を見せている複製の端へ移る", () => {
    installFragmentTable();
    // ユニット 1 は末尾が箱 box_1 で、その末尾の縦位置は複製 2 の帯 (240..300)。
    const previous = registerMoveSurface({
      surface: { kind: "unit", unitId: "u1" },
      localY: 295,
      order: [0],
    });
    updateCaretSurfaceFacets(previous.editor, {
      docEdgeAddress: (edge) => (edge === "end" ? caretInBox.head : null),
    });
    const replica2 = registerMoveSurface({
      surface: { kind: "fragmentReplica", blockId: "box_1", fragmentIndex: 2 },
      localY: 295,
      order: [0, 2],
    });
    const current = registerMoveSurface({
      surface: { kind: "unit", unitId: "u2" },
      localY: null,
      containerBlockId: null,
      order: [1],
      ownsBlock: () => false,
    });
    vi.spyOn(current.editor.view, "endOfTextblock").mockReturnValue(true);

    expect(moveCaretVertically(current.editor.view.dom, "up", 42)).toBe(true);
    expect(replica2.focusCaretAtEdge).toHaveBeenCalledWith("bottom", 42);
    expect(previous.focusCaretAtEdge).not.toHaveBeenCalled();
  });

  it.each([20, null])("複製の最終行から下は次行の計測が %s でもブロックの外へ出る", (lineHeight) => {
    installFragmentTable();
    const source = registerMoveSurface({ surface: { kind: "unit", unitId: "u1" }, localY: 280 });
    const replica2 = registerMoveSurface({
      surface: { kind: "fragmentReplica", blockId: "box_1", fragmentIndex: 2 },
      // 最終行: 1 行 (20px) 進めても totalHeight 300 の中に収まり "same" になる縦位置。
      localY: 285,
      lineHeight,
      order: [0, 2],
    });
    // 複製の doc は箱しか持たない: ブロックの端の行で、doc に次のテキストブロックが無い。
    vi.spyOn(replica2.editor.view, "endOfTextblock").mockReturnValue(true);

    expect(moveCaretVertically(replica2.editor.view.dom, "down", 42)).toBe(true);
    expect(source.focusCaretAfterBlock).toHaveBeenCalledWith("box_1", "down", 42);
  });
});

describe("moveCaretHorizontally", () => {
  it("行の途中には介入しない", () => {
    installFragmentTable();
    const source = registerMoveSurface({ surface: { kind: "unit", unitId: "u1" }, localY: 60 });
    vi.spyOn(source.editor.view, "endOfTextblock").mockReturnValue(false);

    expect(moveCaretHorizontally(source.editor.view.dom, "forward")).toBe(false);
  });

  it("隣のテキストブロックが別の面の断片なら、その面へ配る", () => {
    installFragmentTable();
    const source = registerMoveSurface({ surface: { kind: "unit", unitId: "u1" }, localY: 150 });
    const replica1 = registerFragmentSurface(
      { kind: "fragmentReplica", blockId: "box_1", fragmentIndex: 1 },
      150,
    );
    // 正本のキャレットは箱の直前の本文の末尾。隣 = 箱の中の位置 (縦位置 150 = 複製 1 の帯)。
    updateCaretSurfaceFacets(source.editor, {
      adjacentTextblockAddress: () => caretInBox.head,
    });
    vi.spyOn(source.editor.view, "endOfTextblock").mockReturnValue(true);

    expect(moveCaretHorizontally(source.editor.view.dom, "forward")).toBe(true);
    expect(replica1.applyCaret).toHaveBeenCalledTimes(1);
  });

  it("複製の doc の端からは正本の「箱の次のブロック」へ出る (横位置は選ばない)", () => {
    installFragmentTable();
    const source = registerMoveSurface({ surface: { kind: "unit", unitId: "u1" }, localY: 295 });
    const replica2 = registerMoveSurface({
      surface: { kind: "fragmentReplica", blockId: "box_1", fragmentIndex: 2 },
      localY: 295,
      order: [0, 2],
    });
    vi.spyOn(replica2.editor.view, "endOfTextblock").mockReturnValue(true);

    expect(moveCaretHorizontally(replica2.editor.view.dom, "forward")).toBe(true);
    expect(source.focusCaretAfterBlock).toHaveBeenCalledWith("box_1", "down", null);
  });

  it("ユニットの doc の端からは文書順で隣のユニットの端の位置へ渡す", () => {
    setFragmentTables({}, {});
    const nextUnitCaret = {
      affinity: "after" as const,
      blockId: "next_unit_p",
      kind: "text" as const,
      offset: 0,
    };
    const first = registerMoveSurface({
      surface: { kind: "unit", unitId: "u1" },
      localY: null,
      containerBlockId: null,
      order: [0],
      ownsBlock: () => false,
    });
    const second = registerMoveSurface({
      surface: { kind: "unit", unitId: "u2" },
      localY: null,
      containerBlockId: null,
      order: [1],
      ownsBlock: (blockId) => blockId === "next_unit_p",
    });
    const applied: TextFlowSelectionBookmark[] = [];
    updateCaretSurfaceFacets(second.editor, {
      docEdgeAddress: (edge) => (edge === "start" ? nextUnitCaret : null),
      applyCaret: (selection) => {
        applied.push(selection);
        return true;
      },
    });
    vi.spyOn(first.editor.view, "endOfTextblock").mockReturnValue(true);

    expect(moveCaretHorizontally(first.editor.view.dom, "forward")).toBe(true);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ head: nextUnitCaret });
  });
});
