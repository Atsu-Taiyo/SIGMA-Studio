// @vitest-environment happy-dom

import { act } from "react";
import type { Editor } from "@tiptap/core";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { OverlayShape, OverlayTextBlock } from "@/features/document";

import { OverlayTextShapeEditor } from "./text-shape-editor";

/**
 * 編集中のテキスト図形の「段落の下余白」つまみ。happy-dom はレイアウトを持たないので、置き場所の
 * 測定 (`offsetTop` の鎖) だけを差し替え、操作 (ドラッグ・キー・ダブルクリック) と、その結果が図形の
 * blocks へ 1 手で確定することを固定する。見た目の幾何は `tests/e2e/overlay-text-space-after.spec.ts`。
 */

const originalOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");
let container: HTMLDivElement;
let root: Root;
let editor: Editor;
let committed: OverlayTextBlock[][];
let measured: Array<{ height: number; preview: boolean }>;

const TWO_PARAGRAPHS: OverlayTextBlock[] = [
  { type: "paragraph", id: "p_a", children: [{ type: "text", text: "一つ目" }] },
  { type: "paragraph", id: "p_b", spaceAfterPx: 6, children: [{ type: "text", text: "二つ目" }] },
];

function textShape(blocks: OverlayTextBlock[], extra: Partial<Extract<OverlayShape, { type: "text" }>> = {}): Extract<OverlayShape, { type: "text" }> {
  return {
    id: "text_space",
    type: "text",
    x: 0,
    y: 0,
    props: { w: 240, h: 40, color: "#111827", size: "m", blocks },
    ...extra,
  };
}

async function mount(shape: Extract<OverlayShape, { type: "text" }>, editing = true) {
  await act(async () => {
    root.render(
      <OverlayTextShapeEditor
        shape={shape}
        externalRevision={0}
        editing={editing}
        onFocus={vi.fn()}
        onCancel={vi.fn()}
        onMeasuredHeight={(_id, height, options) => { measured.push({ height, preview: options?.preview === true }); }}
        onChange={(_id, blocks) => { committed.push(blocks); }}
      />,
    );
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  });
  editor = (container.querySelector(".ProseMirror") as (HTMLElement & { editor?: Editor }) | null)?.editor as Editor;
  expect(editor).toBeDefined();
  // happy-dom は焦点を持たない。編集に入った図形は焦点が編集面にある前提 (実機では focus("end") で入る)
  // なので、そう見せて、編集に入る処理が選択を末尾へ戻し続けないようにする。
  editor.view.hasFocus = () => true;
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  });
}

function handle(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>("[data-testid='overlay-text-space-handle']");
}

async function frame() {
  await act(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null)));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

/** キャレットを n 番目のテキストの中へ置く (キャレットの段落が相手になる)。 */
async function placeCaretIn(text: string) {
  let target = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === text) target = pos + 1;
  });
  await act(async () => {
    editor.commands.setTextSelection(target);
  });
  await frame();
}

beforeAll(() => {
  // KaTeX が quirks mode を警告するので、他の spec と同じく標準モードの文書にしておく。
  document.open();
  document.write("<!doctype html><html><head></head><body></body></html>");
  document.close();
});

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  committed = [];
  measured = [];
  // happy-dom にレイアウトは無い。つまみの置き場所を測る offsetTop の鎖だけを、箱を原点にして差し替える。
  vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("overlay-text-shape") ? 0 : 10;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.tagName === "P" ? 20 : 0;
  });
  // happy-dom は offsetParent を持たないので、定義ごと差し替えて afterEach で戻す。
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("overlay-text-shape") ? null : this.closest(".overlay-text-shape");
    },
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  if (originalOffsetParent) {
    Object.defineProperty(HTMLElement.prototype, "offsetParent", originalOffsetParent);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "offsetParent");
  }
});

describe("text shape space-after handle", () => {
  it("shows only while the shape is being edited", async () => {
    await mount(textShape(TWO_PARAGRAPHS), false);
    await frame();

    expect(handle()).toBeNull();
  });

  it("sits under the caret's paragraph in the left gutter, with the body handle's look", async () => {
    await mount(textShape(TWO_PARAGRAPHS));
    await placeCaretIn("一つ目");

    const button = handle();
    expect(button?.dataset.visible).toBe("true");
    expect(button?.classList.contains("page-block-space-handle")).toBe(true);
    // 段落の下端 = offsetTop (10) + offsetHeight (20)
    expect(button?.style.top).toBe("30px");
    expect(button?.getAttribute("aria-label")).toBeTruthy();
  });

  it("follows the hovered paragraph, and falls back to the caret's paragraph on a new selection", async () => {
    await mount(textShape(TWO_PARAGRAPHS));
    await placeCaretIn("一つ目");
    const [first, second] = Array.from(container.querySelectorAll(".ProseMirror > p")) as HTMLElement[];
    expect(first.textContent).toBe("一つ目");

    await act(async () => {
      second.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
    });
    await frame();
    expect(handle()?.dataset.index).toBe("1");

    // キャレットが動いたら、ホバーより編集の場所を優先する (同じ段落の中で動かしても手放す)。
    await act(async () => {
      editor.commands.setTextSelection(3);
    });
    await frame();
    expect(handle()?.dataset.index).toBe("0");
  });

  it("is hidden for a flipped shape, whose downward axis is reversed", async () => {
    await mount(textShape(TWO_PARAGRAPHS, { flipY: true } as Partial<Extract<OverlayShape, { type: "text" }>>));
    await frame();

    expect(handle()).toBeNull();
  });

  it("commits a keyboard step as one change and keeps the other paragraph's value", async () => {
    await mount(textShape(TWO_PARAGRAPHS));
    await placeCaretIn("一つ目");
    committed = [];

    await act(async () => {
      handle()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });

    expect(committed).toHaveLength(1);
    expect(committed[0][0]).toMatchObject({ id: "p_a", spaceAfterPx: 1 });
    expect(committed[0][1]).toMatchObject({ id: "p_b", spaceAfterPx: 6 });
  });

  it("steps by 10 with Shift, never below 0, and never above the maximum", async () => {
    await mount(textShape([{ ...TWO_PARAGRAPHS[0], spaceAfterPx: 395 }, TWO_PARAGRAPHS[1]]));
    await placeCaretIn("一つ目");
    committed = [];

    await act(async () => {
      handle()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(committed.at(-1)?.[0]).toMatchObject({ spaceAfterPx: 400 });

    await frame();
    await act(async () => {
      handle()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(committed.at(-1)?.[0]).toMatchObject({ spaceAfterPx: 390 });
  });

  it("resets to nothing on Delete and on double-click, leaving no stored value behind", async () => {
    await mount(textShape(TWO_PARAGRAPHS));
    await placeCaretIn("二つ目");
    committed = [];

    await act(async () => {
      handle()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    });
    expect(committed).toHaveLength(1);
    expect(committed[0][1]).not.toHaveProperty("spaceAfterPx");
    expect(committed[0][0]).not.toHaveProperty("spaceAfterPx");

    // もう 0 なので、ダブルクリックしても確定は増えない。
    await frame();
    await act(async () => {
      handle()!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    expect(committed).toHaveLength(1);
  });

  it("drags: the paragraph moves live without writing, and the release commits once", async () => {
    await mount(textShape(TWO_PARAGRAPHS));
    await placeCaretIn("一つ目");
    committed = [];
    const button = handle()!;

    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 100 }));
    });
    await act(async () => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 5, clientY: 118 }));
    });
    await frame();

    // 編集面の属性は動いている (後続の段落は本物のレイアウトで追従する) が、図形の blocks には書いていない。
    expect(editor.state.doc.firstChild?.attrs.spaceAfterPx).toBe(18);
    expect(committed).toHaveLength(0);
    expect(button.dataset.dragging).toBe("true");

    await act(async () => {
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 5, clientY: 120 }));
    });
    await frame();

    expect(committed).toHaveLength(1);
    expect(committed[0][0]).toMatchObject({ id: "p_a", spaceAfterPx: 20 });
    expect(button.dataset.dragging).toBeUndefined();
  });

  it("reports the box height as a preview while dragging, and as a normal measurement after", async () => {
    await mount(textShape(TWO_PARAGRAPHS));
    await placeCaretIn("一つ目");
    const button = handle()!;
    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 100 }));
    });
    measured = [];
    // 測り直しを起こす DOM の変化 (style の書き換え) を挟んで、ドラッグ中の報告が仮であることを見る。
    await act(async () => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 5, clientY: 130 }));
    });
    await frame();
    await frame();

    expect(measured.length).toBeGreaterThan(0);
    expect(measured.every((entry) => entry.preview)).toBe(true);

    await act(async () => {
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 5, clientY: 130 }));
    });
    measured = [];
    await act(async () => {
      editor.commands.insertContent("あ");
    });
    await frame();
    await frame();
    expect(measured.every((entry) => !entry.preview)).toBe(true);
  });

  it("cancels on Escape: nothing is written and the previous value comes back", async () => {
    await mount(textShape(TWO_PARAGRAPHS));
    await placeCaretIn("一つ目");
    committed = [];
    const button = handle()!;

    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 100 }));
    });
    await act(async () => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 5, clientY: 140 }));
    });
    await frame();
    expect(editor.state.doc.firstChild?.attrs.spaceAfterPx).toBe(40);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await frame();

    expect(editor.state.doc.firstChild?.attrs.spaceAfterPx ?? null).toBeNull();
    expect(committed).toHaveLength(0);
    expect(button.dataset.dragging).toBeUndefined();

    // 畳んだ後のポインタの動きや離しは何も確定しない。
    await act(async () => {
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 5, clientY: 160 }));
    });
    expect(committed).toHaveLength(0);
  });

  it("does not commit a click that never moved", async () => {
    await mount(textShape(TWO_PARAGRAPHS));
    await placeCaretIn("一つ目");
    committed = [];
    const button = handle()!;

    await act(async () => {
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 100 }));
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 5, clientY: 100 }));
    });

    expect(committed).toHaveLength(0);
  });

  it("keeps a typed edit's value after the space was set (no rollback by the next keystroke)", async () => {
    await mount(textShape(TWO_PARAGRAPHS));
    await placeCaretIn("一つ目");
    await act(async () => {
      handle()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true, cancelable: true }));
    });
    committed = [];

    await act(async () => {
      editor.commands.insertContent("あ");
    });

    expect(committed.at(-1)?.[0]).toMatchObject({ id: "p_a", spaceAfterPx: 10 });
  });
});

describe("text shape space under a list item", () => {
  it("writes an item's space on the item, below nothing else, and hides for quotes", async () => {
    await mount(textShape([
      {
        type: "list",
        id: "l1",
        listType: "bullet",
        items: [
          { type: "listItem", id: "li1", children: [{ type: "text", text: "甲" }] },
          { type: "listItem", id: "li2", children: [{ type: "text", text: "乙" }] },
        ],
      },
      { type: "quote", id: "q1", blocks: [{ type: "paragraph", id: "qp", children: [{ type: "text", text: "引用" }] }] },
    ]));
    await placeCaretIn("甲");
    committed = [];

    await act(async () => {
      handle()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true, cancelable: true }));
    });
    const [list] = committed.at(-1) ?? [];
    expect(list?.type).toBe("list");
    if (list?.type !== "list") return;
    expect(list.items[0]).toMatchObject({ id: "li1", spaceAfterPx: 10 });
    expect(list.items[1].spaceAfterPx).toBeUndefined();

    // 引用の中にキャレットがあっても相手が無いので、つまみは出さない。
    await placeCaretIn("引用");
    expect(handle()?.dataset.visible).toBeUndefined();
  });
});
