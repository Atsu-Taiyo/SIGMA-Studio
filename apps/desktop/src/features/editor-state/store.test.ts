import { describe, expect, it, vi } from "vitest";

import { createEditorStore } from "./store";

describe("editor store", () => {
  it("does not notify listeners when a value is set to what it already is", () => {
    const store = createEditorStore({ selectedId: "p_first" });
    const listener = vi.fn();
    store.subscribe(listener);

    store.getState().setSelectedId("p_first");
    store.getState().setSaveState("idle");
    store.getState().setZoom(100);
    store.getState().setActiveCommentThreadId(null);
    expect(listener).not.toHaveBeenCalled();

    store.getState().setSelectedId("p_second");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps unrelated slices referentially stable so their selectors do not re-render", () => {
    const store = createEditorStore({ selectedId: "p_first" });
    const draftsBefore = store.getState().commentReplyDrafts;

    store.getState().setSaveState("saving");
    store.getState().setStatusMessage("保存中");
    store.getState().setZoom(125);

    expect(store.getState().commentReplyDrafts).toBe(draftsBefore);
    expect(store.getState().selectedId).toBe("p_first");
  });

  it("accepts the updater form so migrated call sites keep working", () => {
    const store = createEditorStore({ selectedId: null, zoom: 100 });

    store.getState().setZoom((current) => current + 25);
    expect(store.getState().zoom).toBe(125);

    store.getState().setOutlineOpen((current) => !current);
    expect(store.getState().outlineOpen).toBe(false);
  });

  it("adds, replaces and removes one comment reply draft without touching the others", () => {
    const store = createEditorStore({ selectedId: null });
    const draft = [{ type: "text", text: "返信" }] as never;

    store.getState().setCommentReplyDraft("thread_1", draft);
    const afterFirst = store.getState().commentReplyDrafts;
    expect(afterFirst).toEqual({ thread_1: draft });

    store.getState().setCommentReplyDraft("thread_1", draft);
    expect(store.getState().commentReplyDrafts).toBe(afterFirst);

    store.getState().setCommentReplyDraft("thread_2", draft);
    expect(Object.keys(store.getState().commentReplyDrafts)).toEqual(["thread_1", "thread_2"]);

    store.getState().setCommentReplyDraft("thread_1", null);
    expect(Object.keys(store.getState().commentReplyDrafts)).toEqual(["thread_2"]);

    const unchanged = store.getState().commentReplyDrafts;
    store.getState().setCommentReplyDraft("thread_1", null);
    expect(store.getState().commentReplyDrafts).toBe(unchanged);
  });

  it("ignores a block candidate that only got rebuilt, but not a changed text-range quote", () => {
    // 段落の候補は引用文が段落本文まるごとなので、1 文字打つだけで作り直される。場所が同じなら
    // state を動かさない (動かすと画面全体が再描画される)。引用はコメント作成時に取り直す。
    const store = createEditorStore({ selectedId: null });
    const listener = vi.fn();
    store.getState().setCommentAnchorCandidate({ type: "block", blockId: "p_first", quote: "本文" });
    store.subscribe(listener);

    store.getState().setCommentAnchorCandidate({ type: "block", blockId: "p_first", quote: "本文あ" });
    expect(listener).not.toHaveBeenCalled();

    store.getState().setCommentAnchorCandidate({ type: "block", blockId: "p_second", quote: "本文" });
    expect(listener).toHaveBeenCalledTimes(1);

    // テキスト選択の候補は引用が選択範囲そのもの。取り直す経路が無いので引用の違いは別物として扱う。
    const range = {
      type: "textRange" as const,
      start: { blockId: "p_first", offset: 0 },
      end: { blockId: "p_first", offset: 2 },
      quote: "本文",
    };
    store.getState().setCommentAnchorCandidate(range);
    expect(listener).toHaveBeenCalledTimes(2);
    store.getState().setCommentAnchorCandidate({ ...range, quote: "別文" });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("keeps every action identity stable for the lifetime of the store", () => {
    // 移行先の呼び出し側 (EditorShell) は 40 箇所以上の hooks deps にこれらのアクションを
    // 並べている。ストアの作りを変えて識別子が毎回変わるようになると、effect が毎描画で
    // 張り直され、このリポジトリが一度潰した「アイドル 30Hz ループ」級の事故に戻る。
    const store = createEditorStore({ selectedId: null });
    const before = { ...store.getState() };

    store.getState().setSelectedId("p_first");
    store.getState().setSaveState("saving");
    store.getState().setStatusMessage("保存中");
    store.getState().setZoom(125);
    store.getState().setActiveCommentThreadId("thread_1");
    store.getState().setCommentReplyDraft("thread_1", [] as never);

    const after = store.getState();
    for (const [key, value] of Object.entries(before)) {
      if (typeof value !== "function") {
        continue;
      }
      expect(after[key as keyof typeof after], `${key} の識別子が変わった`).toBe(value);
    }
    expect(Object.values(before).filter((value) => typeof value === "function").length).toBeGreaterThan(10);
  });

  it("clears every reply draft in one call and stays quiet when there is nothing to clear", () => {
    const store = createEditorStore({ selectedId: null });
    const listener = vi.fn();
    store.subscribe(listener);

    store.getState().clearCommentReplyDrafts();
    expect(listener).not.toHaveBeenCalled();

    store.getState().setCommentReplyDraft("thread_1", [] as never);
    store.getState().clearCommentReplyDrafts();
    expect(store.getState().commentReplyDrafts).toEqual({});
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("gives every editor its own store so two open documents cannot leak into each other", () => {
    const first = createEditorStore({ selectedId: "p_first" });
    const second = createEditorStore({ selectedId: null });

    first.getState().setSaveState("saving");
    first.getState().setZoom(150);
    expect(second.getState().saveState).toBe("idle");
    expect(second.getState().zoom).toBe(100);
  });
});
