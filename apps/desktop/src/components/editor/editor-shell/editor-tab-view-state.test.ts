import { afterEach, describe, expect, it, vi } from "vitest";

import type { SigmaDocument } from "@/features/document";
import { createEmptyEditorDocument } from "@/lib/blank-document";

import {
  captureEditorTabViewState,
  resolveEditorTabViewState,
  scheduleEditorTabViewRestore,
} from "./editor-tab-view-state";

function makeDocument(): SigmaDocument {
  return {
    ...structuredClone(createEmptyEditorDocument()),
    docId: "doc_tab_view",
    metadata: { title: "タブビュー" },
    content: [
      { type: "paragraph", id: "p_first", children: [{ type: "text", text: "先頭" }] },
      { type: "paragraph", id: "p_middle", children: [{ type: "text", text: "中ほど" }] },
    ],
  };
}

/** テスト用: 既定 affinity の文字キャレット。 */
function caretAddress(blockId: string, offset: number) {
  return { affinity: "after" as const, blockId, kind: "text" as const, offset };
}

/** テスト用: 1 点だけを指す選択。 */
function caretBookmark(blockId: string, offset: number, headOffset = offset) {
  return {
    anchor: caretAddress(blockId, offset),
    head: caretAddress(blockId, headOffset),
    preferredX: null,
  };
}

describe("captureEditorTabViewState", () => {
  it("records selection and scroller offsets", () => {
    expect(captureEditorTabViewState({
      selectedId: "p_middle",
      textSelection: caretBookmark("p_middle", 2),
      scroller: { scrollTop: 420, scrollLeft: 12 },
    })).toEqual({
      selectedId: "p_middle",
      textSelection: caretBookmark("p_middle", 2),
      scrollTop: 420,
      scrollLeft: 12,
    });
  });

  it("falls back to zero scroll when the scroller is missing", () => {
    expect(captureEditorTabViewState({
      selectedId: null,
      textSelection: null,
      scroller: null,
    })).toEqual({
      selectedId: null,
      textSelection: null,
      scrollTop: 0,
      scrollLeft: 0,
    });
  });
});

describe("resolveEditorTabViewState", () => {
  it("returns a top-of-document restore when nothing was saved", () => {
    expect(resolveEditorTabViewState(makeDocument(), null)).toEqual({
      selectedId: undefined,
      textSelection: null,
      scrollTop: 0,
      scrollLeft: 0,
    });
  });

  it("keeps a saved block selection and caret when the blocks still exist", () => {
    expect(resolveEditorTabViewState(makeDocument(), {
      selectedId: "p_middle",
      textSelection: caretBookmark("p_middle", 1, 3),
      scrollTop: 880,
      scrollLeft: 0,
    })).toEqual({
      selectedId: "p_middle",
      textSelection: caretBookmark("p_middle", 1, 3),
      scrollTop: 880,
      scrollLeft: 0,
    });
  });

  it("falls back to the caret block when the selected id disappeared", () => {
    expect(resolveEditorTabViewState(makeDocument(), {
      selectedId: "p_gone",
      textSelection: caretBookmark("p_middle", 0),
      scrollTop: 200,
      scrollLeft: 0,
    })).toEqual({
      selectedId: "p_middle",
      textSelection: caretBookmark("p_middle", 0),
      scrollTop: 200,
      scrollLeft: 0,
    });
  });

  it("drops a caret that points at missing blocks", () => {
    expect(resolveEditorTabViewState(makeDocument(), {
      selectedId: "p_gone",
      textSelection: caretBookmark("p_gone", 0),
      scrollTop: 200,
      scrollLeft: 0,
    })).toEqual({
      selectedId: undefined,
      textSelection: null,
      scrollTop: 200,
      scrollLeft: 0,
    });
  });
});

describe("scheduleEditorTabViewRestore", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("applies scroll and restores the caret after the canvas remounts", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "setTimeout"] });
    const animationFrames: FrameRequestCallback[] = [];
    vi.stubGlobal("window", {
      requestAnimationFrame: (callback: FrameRequestCallback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      },
      setTimeout: globalThis.setTimeout.bind(globalThis),
    });

    const scroller = { scrollTop: 0, scrollLeft: 0 } as HTMLElement;
    const restoreTextSelection = vi.fn();
    const selection = caretBookmark("p_middle", 2);

    scheduleEditorTabViewRestore({
      getScroller: () => scroller,
      scrollTop: 640,
      scrollLeft: 8,
      textSelection: selection,
      restoreTextSelection,
    });

    // Drain the first double-rAF.
    expect(animationFrames).toHaveLength(1);
    animationFrames.shift()?.(0);
    expect(animationFrames).toHaveLength(1);
    animationFrames.shift()?.(0);

    expect(scroller.scrollTop).toBe(640);
    expect(scroller.scrollLeft).toBe(8);
    expect(restoreTextSelection).toHaveBeenCalledWith(selection);

    // 復元は 1 回だけ。宛先を 1 つに決めるルーターでは、未マウントの面は登録された瞬間に
    // 予約が消化されるので、遅延リトライで押し返す必要が無い。
    scroller.scrollTop = 10;
    vi.advanceTimersByTime(200);
    expect(restoreTextSelection).toHaveBeenCalledTimes(1);

    // 代わりに、遅れて起きた配送の `view.focus()` がスクロールを動かしても次のフレームで
    // 保存位置を当て直す。
    expect(animationFrames).toHaveLength(1);
    animationFrames.shift()?.(0);
    expect(scroller.scrollTop).toBe(640);
    expect(restoreTextSelection).toHaveBeenCalledTimes(1);
  });
});
