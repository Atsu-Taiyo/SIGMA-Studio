// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPointerPasteClientPoint, trackPointerForPaste } from "./pointer-paste";

const cleanups: Array<() => void> = [];

function pointer(type: "pointermove" | "pointerdown", x: number, y: number, pointerType = "mouse", trusted = true) {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  Object.defineProperty(event, "isTrusted", { value: trusted });
  document.body.dispatchEvent(event);
}

function mountSurface(html: string): HTMLElement {
  document.body.innerHTML = html;
  const target = document.querySelector<HTMLElement>("[data-under-pointer]")!;
  document.elementFromPoint = vi.fn(() => target);
  return target;
}

function track() {
  const stop = trackPointerForPaste();
  cleanups.push(stop);
  return stop;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("the pointer position kept for shape paste", () => {
  it("is unknown until the pointer has moved", () => {
    mountSurface('<section class="page-mode"><div data-under-pointer></div></section>');
    track();

    expect(getPointerPasteClientPoint()).toBeNull();
  });

  it("returns the last point while it is over the editing area", () => {
    mountSurface('<section class="page-mode"><div data-under-pointer></div></section>');
    track();

    pointer("pointermove", 100, 200);
    pointer("pointermove", 140, 260);

    expect(getPointerPasteClientPoint()).toEqual({ x: 140, y: 260 });
  });

  it("keeps the real pointer position when a delayed body-caret handoff replays an older press", () => {
    mountSurface('<section class="page-mode"><div data-under-pointer></div></section>');
    track();
    pointer("pointerdown", 100, 200);
    pointer("pointermove", 300, 400);
    pointer("pointerdown", 100, 200, "mouse", false);
    expect(getPointerPasteClientPoint()).toEqual({ x: 300, y: 400 });
  });

  it("is null over the menu bar, a dialog or anything else that is not the editing area", () => {
    mountSurface('<div class="editor-menubar"><button data-under-pointer></button></div>');
    track();
    pointer("pointermove", 30, 10);

    expect(getPointerPasteClientPoint()).toBeNull();
  });

  it("looks at what is under the point when pasting, so a dialog opened afterwards wins", () => {
    mountSurface('<section class="page-mode"><div data-under-pointer></div></section>');
    track();
    pointer("pointermove", 100, 200);
    expect(getPointerPasteClientPoint()).toEqual({ x: 100, y: 200 });

    document.body.innerHTML = '<div role="dialog"><span data-under-pointer></span></div>';
    const dialogTarget = document.querySelector<HTMLElement>("[data-under-pointer]")!;
    document.elementFromPoint = vi.fn(() => dialogTarget);

    expect(getPointerPasteClientPoint()).toBeNull();
  });

  it("forgets the point when the pointer leaves the window", () => {
    mountSurface('<section class="page-mode"><div data-under-pointer></div></section>');
    track();
    pointer("pointermove", 100, 200);

    document.documentElement.dispatchEvent(new Event("pointerleave"));

    expect(getPointerPasteClientPoint()).toBeNull();
  });

  it("does not treat a touch as a pointer resting on the page", () => {
    mountSurface('<section class="page-mode"><div data-under-pointer></div></section>');
    track();
    pointer("pointermove", 100, 200);
    pointer("pointerdown", 300, 400, "touch");

    expect(getPointerPasteClientPoint()).toBeNull();
  });

  it("stops listening when the last user releases it", () => {
    mountSurface('<section class="page-mode"><div data-under-pointer></div></section>');
    const first = trackPointerForPaste();
    const second = trackPointerForPaste();
    pointer("pointermove", 100, 200);

    first();
    expect(getPointerPasteClientPoint()).toEqual({ x: 100, y: 200 });
    second();
    pointer("pointermove", 500, 600);
    expect(getPointerPasteClientPoint()).toBeNull();
  });
});
