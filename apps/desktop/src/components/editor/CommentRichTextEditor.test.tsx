// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommentRichTextEditor } from "@/components/editor/CommentRichTextEditor";
import type { InlineNode } from "@/features/document";
import { NATIVE_HISTORY_COMMAND_EVENT } from "@/components/tiptap/native-history-guard";
import { setAppLocale } from "@/lib/i18n/react";

/**
 * コメント欄は投稿するまで SigmaDoc に 1 文字も入らないローカル下書きなので、自前の
 * PM 履歴を持つ (ネイティブ undo の受け皿)。**その履歴に「外から入れた内容」を載せない**
 * ことがここの主題。
 *
 * 載せてしまうと、投稿でコンポーザがクリアされたあとに undo すると**投稿済みの本文が
 * 復活し、`onUpdate` がそれをストアへ書き戻す**。返信コンポーザは投稿後もマウントされた
 * ままなので (`CommentThreadsPanel` の返信欄)、これは実際に踏める経路。
 */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setAppLocale("ja");
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function textOf(): string {
  return container.querySelector(".ProseMirror")?.textContent ?? "";
}

/** ネイティブ undo (右クリック > 取り消す / 3 本指スワイプ) と同じ入口を叩く。 */
function dispatchNativeUndo(): void {
  const dom = container.querySelector(".ProseMirror");
  expect(dom).not.toBeNull();
  act(() => {
    dom?.dispatchEvent(new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "historyUndo",
    }));
  });
}

function render(value: InlineNode[], onChange: (next: InlineNode[]) => void): void {
  act(() => {
    root.render(<CommentRichTextEditor value={value} onChange={onChange} />);
  });
}

describe("CommentRichTextEditor", () => {
  it("does not resurrect a posted reply when the composer is cleared", () => {
    const onChange = vi.fn();
    const draft: InlineNode[] = [{ type: "text", text: "投稿した返信" }];

    render(draft, onChange);
    expect(textOf()).toContain("投稿した返信");

    // 投稿 → `setCommentReplyDraft(threadId, null)` で下書きがクリアされる。
    // コンポーザは開いたままなので、外部同期の setContent が空文書を入れる。
    render([], onChange);
    expect(textOf()).not.toContain("投稿した返信");

    onChange.mockClear();
    dispatchNativeUndo();

    expect(textOf()).not.toContain("投稿した返信");
    // 復活したものが `onUpdate` 経由でストアへ書き戻されないこと。
    expect(onChange).not.toHaveBeenCalled();
  });

  it("routes a native undo to its own editor, not to the document", () => {
    // ここが SigmaDoc へ振り向けると、コメントを打ち間違えて取り消したときに
    // コメントはそのままで無関係な本文編集が巻き戻る。
    const events: Event[] = [];
    const listener = (event: Event) => events.push(event);
    window.addEventListener(NATIVE_HISTORY_COMMAND_EVENT, listener);

    render([{ type: "text", text: "下書き" }], vi.fn());
    const dom = container.querySelector(".ProseMirror");
    const event = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "historyUndo",
    });
    act(() => {
      dom?.dispatchEvent(event);
    });

    // ネイティブ undo は止まっている。
    expect(event.defaultPrevented).toBe(true);
    // しかし文書 undo は要求していない。
    expect(events).toEqual([]);
    window.removeEventListener(NATIVE_HISTORY_COMMAND_EVENT, listener);
  });
});
