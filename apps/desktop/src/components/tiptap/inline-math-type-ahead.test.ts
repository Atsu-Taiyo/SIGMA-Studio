// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  holdInlineMathTypeAhead,
  releaseInlineMathTypeAhead,
  replayInlineMathTypeAhead,
  toInlineMathTypeAheadKey,
} from "@/components/tiptap/inline-math-type-ahead";

function key(value: string, overrides: Partial<KeyboardEventInit> = {}) {
  return toInlineMathTypeAheadKey(new KeyboardEvent("keydown", { key: value, code: "", ...overrides }));
}

function recordKeyDowns(target: EventTarget) {
  const seen: string[] = [];
  target.addEventListener("keydown", (event) => {
    const keyboard = event as KeyboardEvent;
    seen.push(`${keyboard.ctrlKey ? "Ctrl+" : ""}${keyboard.key}`);
  });
  return seen;
}

async function nextFrames(count: number) {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => window.setTimeout(resolve, 0)));
  }
}

describe("inline math type-ahead", () => {
  let insertText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    insertText = vi.fn(() => true);
    document.execCommand = insertText as unknown as typeof document.execCommand;
    document.body.innerHTML = '<div id="body" tabindex="0"></div><textarea id="field"></textarea>';
  });

  afterEach(() => {
    releaseInlineMathTypeAhead("m1");
    releaseInlineMathTypeAhead("m2");
  });

  it("waits for the field to take focus, then types the held keys into it in order", async () => {
    const field = document.getElementById("field") as HTMLTextAreaElement;
    const seen = recordKeyDowns(field);
    holdInlineMathTypeAhead("m1", [key("/", { ctrlKey: true }), key("1"), key("Tab")]);

    replayInlineMathTypeAhead("m1", field);
    await nextFrames(2);
    expect(seen).toEqual([]);

    field.focus();
    await nextFrames(4);
    // ショートカットも、数式の中で押したのと同じ keydown として届く。文字だけが文字入力になる。
    expect(seen).toEqual(["Ctrl+/", "1", "Tab"]);
    expect(insertText.mock.calls).toEqual([["insertText", false, "1"]]);
  });

  it("does not hand the opening shortcut back to the body when the field never opens", () => {
    const body = document.getElementById("body") as HTMLElement;
    body.focus();
    const seen = recordKeyDowns(body);
    holdInlineMathTypeAhead("m1", [key("/", { ctrlKey: true })]);

    releaseInlineMathTypeAhead("m1");

    expect(seen).toEqual([]);
    expect(insertText).not.toHaveBeenCalled();
  });

  it("lets replayed (untrusted) key events through while holding", () => {
    const body = document.getElementById("body") as HTMLElement;
    const seen = recordKeyDowns(body);
    holdInlineMathTypeAhead("m1");

    const event = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    body.dispatchEvent(event);

    expect(seen).toEqual(["a"]);
    expect(event.defaultPrevented).toBe(false);
  });

  it("ignores a replay request for a formula it is not holding keys for", async () => {
    const field = document.getElementById("field") as HTMLTextAreaElement;
    const seen = recordKeyDowns(field);
    holdInlineMathTypeAhead("m1", [key("x")]);
    field.focus();

    replayInlineMathTypeAhead("m2", field);
    await nextFrames(3);

    expect(seen).toEqual([]);
  });
});
