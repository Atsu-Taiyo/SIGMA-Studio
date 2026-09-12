// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginLayoutColumnResize } from "./layout-column-resize";

afterEach(() => document.body.replaceChildren());

function session() {
  const grid = document.createElement("div");
  grid.className = "layout-section-independent-columns";
  grid.style.gridTemplateColumns = "2fr 1fr";
  grid.innerHTML = '<div class="layout-section-independent-column"></div><div class="layout-section-independent-column"></div><button></button>';
  document.body.append(grid);
  const rect = (left: number, width: number) => ({ left, top: 0, right: left + width, bottom: 100, width, height: 100 }) as DOMRect;
  grid.getBoundingClientRect = () => rect(0, 640);
  Object.defineProperty(grid, "offsetWidth", { value: 320 }); // 200% editor zoom
  grid.children[0].getBoundingClientRect = () => rect(0, 400);
  grid.children[1].getBoundingClientRect = () => rect(440, 200);
  const handle = grid.lastElementChild as HTMLButtonElement;
  let captured = false;
  handle.setPointerCapture = () => { captured = true; };
  handle.hasPointerCapture = () => captured;
  handle.releasePointerCapture = () => { captured = false; };
  const commit = vi.fn();
  const cancel = beginLayoutColumnResize({ button: 0, pointerId: 1, clientX: 420, preventDefault() {}, stopPropagation() {} }, handle, 0, commit);
  const move = () => handle.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 460 }));
  return { grid, handle, commit, cancel, move };
}

describe("shared column resize lifetime", () => {
  it("commits layout pixels once and removes the pointer session", () => {
    const { grid, handle, commit, move } = session();
    move();
    expect(grid.style.gridTemplateColumns).toBe("220px 80px");
    handle.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    handle.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    expect(commit).toHaveBeenCalledExactlyOnceWith(220, 80);
    expect(grid.style.gridTemplateColumns).toBe("2fr 1fr");
    expect(handle.hasPointerCapture(1)).toBe(false);
    move();
    expect(grid.style.gridTemplateColumns).toBe("2fr 1fr");
  });
  it("cancels without committing on pointer cancellation", () => {
    const { grid, handle, commit, move } = session();
    move();
    handle.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }));
    expect(grid.style.gridTemplateColumns).toBe("2fr 1fr");
    expect(commit).not.toHaveBeenCalled();
    expect(handle.hasPointerCapture(1)).toBe(false);
  });
  it("unmount cleanup restores the preview and releases the Escape listener", () => {
    const { grid, handle, commit, move, cancel } = session();
    move();
    cancel();
    const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
    expect(handle.hasPointerCapture(1)).toBe(false);
    expect(grid.style.gridTemplateColumns).toBe("2fr 1fr");
    expect(commit).not.toHaveBeenCalled();
  });
});
