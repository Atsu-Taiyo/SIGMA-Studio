// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adjustLayoutColumnsWithKey,
  attachLayoutColumnResizeHandle,
  beginLayoutColumnResize,
  formatLayoutColumnShare,
  resolveLayoutColumnResizePreview,
} from "./layout-column-resize";

afterEach(() => document.body.replaceChildren());

function session(options: { start?: number } = {}) {
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
  const start = options.start ?? 420;
  const cancel = beginLayoutColumnResize(
    { button: 0, pointerId: 1, clientX: start, preventDefault() {}, stopPropagation() {} },
    handle,
    0,
    commit,
    { labels: { merge: "列を結合" } },
  );
  const move = (clientX = 460) => handle.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX }));
  const up = () => handle.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
  return { grid, handle, commit, cancel, move, up };
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

describe("column resize rules", () => {
  // 段組全体 300px (最小幅 30px)、2 列は 200 / 100。
  const base = { leftWidth: 200, rightWidth: 100, minWidth: 30, snapPx: 4 };

  it("snaps to an even split near the middle", () => {
    expect(resolveLayoutColumnResizePreview({ ...base, delta: -48 })).toEqual({ left: 150, right: 150, state: "equal" });
    expect(resolveLayoutColumnResizePreview({ ...base, delta: -40 })).toEqual({ left: 160, right: 140, state: "resize" });
  });

  it("stops at the minimum width, then announces the merge past half of it", () => {
    expect(resolveLayoutColumnResizePreview({ ...base, delta: 80 })).toEqual({ left: 270, right: 30, state: "resize" });
    expect(resolveLayoutColumnResizePreview({ ...base, delta: 90 })).toEqual({ left: 270, right: 30, state: "merge", collapsing: "right" });
    expect(resolveLayoutColumnResizePreview({ ...base, delta: -190 })).toEqual({ left: 30, right: 270, state: "merge", collapsing: "left" });
  });

  it("lets a column that is already narrower than the minimum keep its width", () => {
    const narrow = { ...base, leftWidth: 280, rightWidth: 20 };
    expect(resolveLayoutColumnResizePreview({ ...narrow, delta: 2 })).toEqual({ left: 280, right: 20, state: "resize" });
    expect(resolveLayoutColumnResizePreview({ ...narrow, delta: 12 })).toMatchObject({ state: "merge", collapsing: "right" });
  });

  it("shows each column's share of the whole section", () => {
    expect(formatLayoutColumnShare(200, 100, 300)).toBe("67% : 33%");
  });
});

describe("shared column resize gestures", () => {
  it("shows the share while dragging and the merge label at the edge", () => {
    const { handle, commit, move, up } = session();
    move(460);
    expect(handle.dataset.readout).toBe("73% : 27%");
    move(600);
    expect(handle.dataset.resizeState).toBe("merge");
    expect(handle.dataset.readout).toBe("列を結合");
    up();
    expect(commit).toHaveBeenCalledExactlyOnceWith(300, 0);
    expect(handle.dataset.readout).toBeUndefined();
  });

  it("does not rewrite the widths for a click without movement", () => {
    const { commit, move, up } = session();
    move(421);
    up();
    expect(commit).not.toHaveBeenCalled();
  });

  it("evens the two columns on a double click", () => {
    const first = session();
    first.up();
    const { handle } = first;
    const commit = vi.fn();
    beginLayoutColumnResize({ button: 0, pointerId: 1, clientX: 420, preventDefault() {}, stopPropagation() {} }, handle, 0, commit);
    handle.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    expect(first.commit).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledExactlyOnceWith(150, 150);
  });

  it("moves the boundary with the arrow keys, clamped at the minimum", () => {
    const { handle, cancel } = session();
    cancel();
    const commit = vi.fn();
    const key = (keyName: string, shiftKey = false) => adjustLayoutColumnsWithKey(
      { key: keyName, shiftKey, preventDefault() {}, stopPropagation() {} },
      handle,
      0,
      commit,
    );
    expect(key("ArrowLeft")).toBe(true);
    expect(commit).toHaveBeenLastCalledWith(197, 103);
    expect(key("ArrowRight", true)).toBe(true);
    expect(commit).toHaveBeenLastCalledWith(215, 85);
    expect(key("Enter")).toBe(false);
  });

  it("builds its knob once and removes it with its listeners", () => {
    const { handle, cancel } = session();
    cancel();
    const detach = attachLayoutColumnResizeHandle(handle, () => ({ dividerIndex: 0, labels: { merge: "列を結合" }, onCommit: vi.fn() }));
    expect(handle.querySelectorAll(".layout-section-column-resize-knob")).toHaveLength(1);
    expect(handle.querySelectorAll(".layout-section-column-resize-merge")).toHaveLength(1);
    detach();
    expect(handle.children).toHaveLength(0);
  });
});
