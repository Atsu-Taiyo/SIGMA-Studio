// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { guardCaretAgainstForeignScroll } from "./caret-scroll";

function mountCanvas(): { canvas: HTMLElement; surface: HTMLElement } {
  const canvas = document.createElement("div");
  canvas.className = "editor-canvas";
  const surface = document.createElement("div");
  canvas.append(surface);
  document.body.append(canvas);
  return { canvas, surface };
}

describe("guardCaretAgainstForeignScroll", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("キャレットを移した直後の、利用者の操作ではないスクロールで見せ直す", () => {
    const { canvas, surface } = mountCanvas();
    const ensure = vi.fn();
    guardCaretAgainstForeignScroll(surface, ensure);
    canvas.dispatchEvent(new Event("scroll"));
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it("ホイール・ポインタ・キー操作の後は利用者のスクロールとして邪魔しない", () => {
    for (const cancel of [
      () => window.dispatchEvent(new Event("wheel")),
      () => window.dispatchEvent(new Event("pointerdown")),
      () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown" })),
    ]) {
      const { canvas, surface } = mountCanvas();
      const ensure = vi.fn();
      guardCaretAgainstForeignScroll(surface, ensure);
      cancel();
      canvas.dispatchEvent(new Event("scroll"));
      expect(ensure).not.toHaveBeenCalled();
      document.body.replaceChildren();
    }
  });

  it("短い間だけ見張り、新しい見張りは前の見張りを外す", () => {
    vi.useFakeTimers();
    const { canvas, surface } = mountCanvas();
    const first = vi.fn();
    const second = vi.fn();
    guardCaretAgainstForeignScroll(surface, first);
    guardCaretAgainstForeignScroll(surface, second);
    canvas.dispatchEvent(new Event("scroll"));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    canvas.dispatchEvent(new Event("scroll"));
    expect(second).toHaveBeenCalledTimes(1);
  });
});
