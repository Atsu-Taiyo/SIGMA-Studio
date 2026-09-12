// @vitest-environment happy-dom

import { Editor, type Extensions } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  NATIVE_HISTORY_COMMAND_EVENT,
  NativeHistoryGuardExtension,
  type NativeHistoryCommandDetail,
  type NativeHistoryGuardOptions,
} from "@/components/tiptap/native-history-guard";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";

/**
 * ネイティブ undo が本文 DOM に届かないことを固定する。
 *
 * WI-1 でメニュー経由の `webContents.undo()` は消えたが、右クリックメニュー・3 本指スワイプ・
 * 支援技術・将来の main プロセスコードなど入口は他にも残る。どこから来ても
 * `beforeinput` の `historyUndo` / `historyRedo` で止まることを見る。
 */

const editors: Editor[] = [];

afterEach(() => {
  while (editors.length > 0) {
    editors.pop()?.destroy();
  }
});

/**
 * 共通エンジンの guard を **差し替える** (2 つ目を積まない)。
 * `PluginKey` が重複するとエディタ生成時に落ちるので、上書きはこの形が唯一の route。
 */
function withHistoryGuard(
  onHistoryCommand: NativeHistoryGuardOptions["onHistoryCommand"],
): Extensions {
  return createRichTextEngineExtensions().map((extension) => (extension.name === "nativeHistoryGuard"
    ? NativeHistoryGuardExtension.configure({ onHistoryCommand })
    : extension));
}

function createEditor(extensions = createRichTextEngineExtensions()): Editor {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions,
    content: "<p>あ</p>",
  });
  editors.push(editor);
  return editor;
}

function dispatchBeforeInput(editor: Editor, inputType: string): InputEvent {
  const event = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType });
  editor.view.dom.dispatchEvent(event);
  return event;
}

/**
 * PM 自身の合成状態を立てる。
 *
 * `InputEvent.isComposing` では測れない — あれは Blink が合成中に生成した input イベントに
 * しか立たず、OS 由来の `historyUndo` には立たないので、そこを見るガードは実機で効かない。
 */
function startComposition(editor: Editor): void {
  editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  expect(editor.view.composing).toBe(true);
}

function captureHistoryCommands(): { detail: NativeHistoryCommandDetail[]; stop: () => void } {
  const detail: NativeHistoryCommandDetail[] = [];
  const listener = (event: Event) => {
    detail.push((event as CustomEvent<NativeHistoryCommandDetail>).detail);
  };
  window.addEventListener(NATIVE_HISTORY_COMMAND_EVENT, listener);
  return { detail, stop: () => window.removeEventListener(NATIVE_HISTORY_COMMAND_EVENT, listener) };
}

describe("NativeHistoryGuardExtension", () => {
  it("stops a native undo and asks the shell to undo instead", () => {
    const editor = createEditor();
    const captured = captureHistoryCommands();

    const event = dispatchBeforeInput(editor, "historyUndo");

    expect(event.defaultPrevented).toBe(true);
    expect(captured.detail).toEqual([{ direction: "undo" }]);
    captured.stop();
  });

  it("stops a native redo and asks the shell to redo instead", () => {
    const editor = createEditor();
    const captured = captureHistoryCommands();

    const event = dispatchBeforeInput(editor, "historyRedo");

    expect(event.defaultPrevented).toBe(true);
    expect(captured.detail).toEqual([{ direction: "redo" }]);
    captured.stop();
  });

  it("does not mistake a prototype key for a history command", () => {
    // `inputType` はイベント側から来る文字列。対応表をオブジェクト添字で引くと
    // `"constructor"` で prototype の値が truthy に返り、打鍵が握り潰される。
    const editor = createEditor();
    const captured = captureHistoryCommands();

    const event = dispatchBeforeInput(editor, "constructor");

    expect(event.defaultPrevented).toBe(false);
    expect(captured.detail).toEqual([]);
    captured.stop();
  });

  it("leaves ordinary input untouched", () => {
    const editor = createEditor();
    const captured = captureHistoryCommands();

    const event = dispatchBeforeInput(editor, "insertText");

    expect(event.defaultPrevented).toBe(false);
    expect(captured.detail).toEqual([]);
    captured.stop();
  });

  it("still blocks the native history command during an IME composition", () => {
    // 合成中に素通しすると `UndoStep::Unapply()` が PM 所有 DOM を裏で書き換える —
    // この拡張が存在する理由そのものの穴が「合成中だけ」開く。止めるのは無条件。
    const editor = createEditor();
    startComposition(editor);

    const event = dispatchBeforeInput(editor, "historyUndo");

    expect(event.defaultPrevented).toBe(true);
  });

  it("does not touch the document while an IME composition is unresolved", () => {
    // 合成中に文書を差し替えると合成セッションごと壊れる。**止めるが、何もしない**。
    const editor = createEditor();
    startComposition(editor);
    const captured = captureHistoryCommands();

    dispatchBeforeInput(editor, "historyUndo");

    expect(captured.detail).toEqual([]);
    captured.stop();
  });

  it("lets a surface route history to its own editor instead of the shell", () => {
    // 箱タイトルだけは PM 履歴が生きているので、そちらへ振り向ける。
    const onHistoryCommand = vi.fn(() => true);
    const editor = createEditor(withHistoryGuard(onHistoryCommand));
    const captured = captureHistoryCommands();

    const event = dispatchBeforeInput(editor, "historyUndo");

    expect(event.defaultPrevented).toBe(true);
    expect(onHistoryCommand).toHaveBeenCalledWith("undo", editor);
    // 差し替えたので既定の window イベントは飛ばない。
    expect(captured.detail).toEqual([]);
    captured.stop();
  });

  it("blocks the native history command even when the surface declines to route it", () => {
    // 戻す先が無い (例: `editor.commands.undo()` が false) ときでもネイティブ undo は
    // 走らせない。走らせたら PM 所有の DOM を外から書き換えられ、そこが直したい穴そのもの。
    const editor = createEditor(withHistoryGuard(() => false));

    const event = dispatchBeforeInput(editor, "historyUndo");

    expect(event.defaultPrevented).toBe(true);
  });
});
