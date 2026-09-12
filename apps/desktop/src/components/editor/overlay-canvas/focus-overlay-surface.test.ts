// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";

import { focusOverlaySurface } from "./focus-overlay-surface";

describe("focusOverlaySurface", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    // 選択は document を張り替えても残る。消しておかないと、前のテストが残した range を
    // 次のテストの `addRange` が無視して、判定が前のテストの DOM に引きずられる。
    document.getSelection()?.removeAllRanges();
  });

  it("blurs the body ProseMirror, clears its DOM selection, and focuses the overlay", () => {
    const bodyEditor = document.createElement("div");
    bodyEditor.className = "ProseMirror";
    bodyEditor.contentEditable = "true";
    bodyEditor.textContent = "本文";
    const overlay = document.createElement("div");
    overlay.className = "overlay-canvas-bleed-surface";
    overlay.tabIndex = -1;
    document.body.append(bodyEditor, overlay);

    bodyEditor.focus();
    const range = document.createRange();
    range.selectNodeContents(bodyEditor);
    range.collapse(false);
    const selection = document.getSelection();
    selection?.addRange(range);

    focusOverlaySurface(overlay);

    expect(document.activeElement).toBe(overlay);
    expect(selection?.rangeCount).toBe(0);
  });

  it("keeps a body range selection so a mixed body+shape selection survives", () => {
    const bodyEditor = document.createElement("div");
    bodyEditor.className = "ProseMirror text-flow-editor";
    bodyEditor.contentEditable = "true";
    bodyEditor.textContent = "本文";
    const overlay = document.createElement("div");
    overlay.className = "overlay-canvas-bleed-surface";
    overlay.tabIndex = -1;
    document.body.append(bodyEditor, overlay);

    bodyEditor.focus();
    const range = document.createRange();
    range.selectNodeContents(bodyEditor);
    const selection = document.getSelection();
    selection?.addRange(range);

    focusOverlaySurface(overlay);

    expect(document.activeElement).toBe(overlay);
    expect(selection?.rangeCount).toBe(1);
    expect(selection?.toString()).toBe("本文");
  });

  it("still clears stale DOM ranges when the overlay already has focus", () => {
    const overlay = document.createElement("div");
    overlay.className = "overlay-canvas-bleed-surface";
    overlay.tabIndex = -1;
    overlay.textContent = "図形";
    document.body.append(overlay);
    overlay.focus();
    const range = document.createRange();
    range.selectNodeContents(overlay);
    const selection = document.getSelection();
    selection?.addRange(range);

    focusOverlaySurface(overlay);

    expect(document.activeElement).toBe(overlay);
    expect(selection?.rangeCount).toBe(0);
  });
});
