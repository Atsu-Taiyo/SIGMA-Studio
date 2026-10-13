// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiImageAnnotation } from "@/lib/ai/ai-image-annotations";

import { AiImageAnnotationDialog } from "./AiImageAnnotationDialog";

let root: Root;
let container: HTMLDivElement;
let onChange: ReturnType<typeof vi.fn<(annotations: AiImageAnnotation[]) => void>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;

const IMAGE = "data:image/png;base64,iVBORw0KGgo=";

function Harness({ initial = [] }: { initial?: AiImageAnnotation[] }) {
  const [annotations, setAnnotations] = useState<AiImageAnnotation[]>(initial);
  return (
    <AiImageAnnotationDialog
      src={IMAGE}
      name="screenshot.png"
      naturalSize={{ width: 400, height: 200 }}
      annotations={annotations}
      onChange={(next) => {
        onChange(next);
        setAnnotations(next);
      }}
      onClose={onClose}
    />
  );
}

function render(initial?: AiImageAnnotation[]) {
  act(() => root.render(<Harness initial={initial} />));
}

function surface(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-ai-image-annotation-surface]");
  if (!element) {
    throw new Error("annotation surface is missing");
  }
  // happy-dom はレイアウトしないので、画像の箱 (400x200 を左上 100,50 に置いた) を与える。
  element.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 200, right: 500, bottom: 250, x: 100, y: 50, toJSON: () => ({}) }) as DOMRect;
  const captured = new Set<number>();
  element.setPointerCapture = vi.fn((id: number) => { captured.add(id); });
  element.hasPointerCapture = vi.fn((id: number) => captured.has(id));
  element.releasePointerCapture = vi.fn((id: number) => { captured.delete(id); });
  return element;
}

function pointer(target: Element, type: string, x: number, y: number) {
  act(() => target.dispatchEvent(new PointerEvent(type, {
    clientX: x, clientY: y, pointerId: 1, button: 0, bubbles: true, cancelable: true,
  })));
}

function textarea(): HTMLTextAreaElement {
  const element = document.querySelector<HTMLTextAreaElement>("[data-ai-image-annotation-dialog] textarea");
  if (!element) {
    throw new Error("comment input is missing");
  }
  return element;
}

function type(text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea(), text);
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function key(target: Element, keyName: string, init: KeyboardEventInit = {}) {
  act(() => target.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true, ...init })));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  onChange = vi.fn<(annotations: AiImageAnnotation[]) => void>();
  onClose = vi.fn<() => void>();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("AiImageAnnotationDialog", () => {
  it("adds a point comment where the image was clicked, with Enter", () => {
    render();
    const target = surface();
    pointer(target, "pointerdown", 200, 100);
    pointer(target, "pointerup", 200, 100);
    expect(document.activeElement).toBe(textarea());
    type("ここの符号が逆");
    key(textarea(), "Enter");

    expect(onChange).toHaveBeenLastCalledWith([
      { id: expect.any(String), x: 0.25, y: 0.25, comment: "ここの符号が逆" },
    ]);
    expect(document.querySelector("[data-ai-image-annotation-dialog] textarea")).toBeNull();
    // 一覧にも同じ番号で並ぶ。
    expect(document.querySelector("[data-ai-image-annotation-dialog] ol")?.textContent).toContain("ここの符号が逆");
  });

  it("adds a region comment when the pointer is dragged", () => {
    render();
    const target = surface();
    pointer(target, "pointerdown", 140, 70);
    pointer(target, "pointermove", 300, 150);
    pointer(target, "pointerup", 300, 150);
    type("この表");
    key(textarea(), "Enter");

    const [[annotations]] = onChange.mock.calls;
    expect(annotations[0]).toMatchObject({ x: 0.1, y: 0.1, comment: "この表" });
    expect(annotations[0]?.width).toBeCloseTo(0.4, 5);
    expect(annotations[0]?.height).toBeCloseTo(0.4, 5);
  });

  it("does not add a comment while the Japanese input method is composing, and Shift+Enter keeps typing", () => {
    render();
    const target = surface();
    pointer(target, "pointerdown", 200, 100);
    pointer(target, "pointerup", 200, 100);
    type("へんかん");
    key(textarea(), "Enter", { isComposing: true });
    key(textarea(), "Enter", { shiftKey: true });
    expect(onChange).not.toHaveBeenCalled();
    expect(textarea()).toBeTruthy();
  });

  it("closes only the comment card on Escape, keeping the dialog open", () => {
    render();
    const target = surface();
    pointer(target, "pointerdown", 200, 100);
    pointer(target, "pointerup", 200, 100);
    type("やめる");
    key(textarea(), "Escape");
    expect(document.querySelector("[data-ai-image-annotation-dialog] textarea")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps a typed comment when another place is clicked instead of throwing it away", () => {
    render();
    const target = surface();
    pointer(target, "pointerdown", 200, 100);
    pointer(target, "pointerup", 200, 100);
    type("一つ目");
    pointer(target, "pointerdown", 400, 200);
    pointer(target, "pointerup", 400, 200);
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ comment: "一つ目" })]);
    expect(textarea().value).toBe("");
  });

  it("edits and deletes an existing comment from the list", () => {
    render([
      { id: "a", x: 0.2, y: 0.2, comment: "前のコメント" },
      { id: "b", x: 0.6, y: 0.6, comment: "残す" },
    ]);
    const editButton = document.querySelector<HTMLButtonElement>("[aria-label='コメント1を編集'][class*='listMain']")!;
    act(() => editButton.click());
    expect(textarea().value).toBe("前のコメント");
    type("直したコメント");
    key(textarea(), "Enter");
    expect(onChange).toHaveBeenLastCalledWith([
      { id: "a", x: 0.2, y: 0.2, comment: "直したコメント" },
      { id: "b", x: 0.6, y: 0.6, comment: "残す" },
    ]);

    const deleteButtons = document.querySelectorAll<HTMLButtonElement>("[data-ai-image-annotation-dialog] li button[aria-label='コメントを削除']");
    act(() => deleteButtons[0]!.click());
    expect(onChange).toHaveBeenLastCalledWith([{ id: "b", x: 0.6, y: 0.6, comment: "残す" }]);
  });

  it("saves what is being typed when the dialog is closed with 完了", () => {
    render();
    const target = surface();
    pointer(target, "pointerdown", 200, 100);
    pointer(target, "pointerup", 200, 100);
    type("閉じる前に打った");
    const done = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent === "完了")!;
    act(() => done.click());
    expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ comment: "閉じる前に打った" })]);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
