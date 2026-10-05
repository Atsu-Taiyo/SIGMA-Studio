// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OverlayShape, ParagraphNode } from "@/features/document";
import { setAppLocale } from "@/lib/i18n";
import {
  createOverlayClipboardPayload,
  createTextFlowClipboardPayload,
  writeEditorClipboardData,
} from "@/lib/editor-clipboard";

import { registerPocketPageHost } from "../application/pocket-drag";
import {
  addToPocket,
  getPocketState,
  removeFromPocket,
  resetPocketForTests,
  setPocketExpanded,
  showPocketNotice,
} from "../application/pocket-store";
import { PocketBar } from "./PocketBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const paragraph: ParagraphNode = { type: "paragraph", id: "p_src", children: [{ type: "text", text: "ポケットの本文" }] };
const rectangle = {
  id: "shape_a",
  type: "geo",
  x: 10,
  y: 20,
  rotation: 0,
  props: { w: 100, h: 60, geo: "rectangle", fill: "none", color: "#111111", labelColor: "#111111", dash: "solid", size: "m" },
} as OverlayShape;

/** コピーが書くのと同じ bag を作る。 */
function clipOf(payload: Parameters<typeof writeEditorClipboardData>[1]): Record<string, string> {
  const data = new DataTransfer();
  writeEditorClipboardData(data, payload);
  return Object.fromEntries([...data.types].map((type) => [type, data.getData(type)]));
}

function putBlocks(): string {
  const outcome = addToPocket(clipOf(createTextFlowClipboardPayload([paragraph])));
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.item.id;
}

function putShapes(): string {
  const outcome = addToPocket(clipOf(createOverlayClipboardPayload([rectangle], {}, "doc_a")));
  if (!outcome.ok) throw new Error(outcome.reason);
  return outcome.item.id;
}

let root: Root;
let container: HTMLDivElement;

async function render(): Promise<void> {
  await act(async () => {
    root.render(<PocketBar addShortcut="⇧⌘C" />);
  });
}

function buttonByLabel(label: string | RegExp): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((button) => {
    const text = button.getAttribute("aria-label") ?? button.textContent ?? "";
    return typeof label === "string" ? text === label : label.test(text);
  });
  if (!found) throw new Error(`no button named ${String(label)}: ${container.innerHTML}`);
  return found;
}

const cards = () => [...container.querySelectorAll<HTMLButtonElement>("[data-pocket-item] button[data-kind]")];

/** 開閉の動き (280ms) が終わるのを待つ。 */
const afterTransition = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 360));
});

describe("PocketBar", () => {
  beforeEach(async () => {
    setAppLocale("ja");
    resetPocketForTests();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetPocketForTests();
    document.body.innerHTML = "";
  });

  it("renders nothing while the pocket is empty and closed", async () => {
    await render();

    expect(container.innerHTML).toBe("");
  });

  it("shows one card per item, named after what it carries, in the order they were put in", async () => {
    await act(async () => {
      putBlocks();
      putShapes();
    });
    await render();

    expect(cards().map((card) => card.dataset.kind)).toEqual(["blocks", "shapes"]);
    expect(cards()[0]?.getAttribute("aria-label")).toBe("本文 1ブロック「ポケットの本文」を挿入");
    expect(cards()[1]?.getAttribute("aria-label")).toBe("図形 1個を挿入");
    expect(container.querySelector("[data-pocket-root]")).not.toBeNull();
    // 図形は DOM に SVG を展開せず、画像として描く。
    expect(cards()[1]?.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(cards()[1]?.querySelector("img")?.parentElement?.querySelector("svg")).toBeNull();
  });

  it("drags a card with the pointer: a ghost follows, and an accepted drop is confirmed on the card", async () => {
    let id = "";
    await act(async () => {
      id = putBlocks();
    });
    await render();
    const card = cards()[0]!;
    // ドロップを受ける場所。受けた印に dragover / drop を preventDefault する。
    const zone = document.body.appendChild(document.createElement("div"));
    const dropped: string[] = [];
    zone.addEventListener("dragover", (event) => event.preventDefault());
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      dropped.push(event.type);
    });
    document.elementFromPoint = () => zone;

    await act(async () => {
      card.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true, clientX: 50, clientY: 20 }));
    });
    // 動かす前は、まだドラッグではない (ふつうのクリックのまま)。
    expect(document.querySelector("[data-accepted]")).toBeNull();

    await act(async () => {
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 200, clientY: 300 }));
    });
    const ghost = document.querySelector("[data-accepted]") as HTMLElement | null;
    expect(card.dataset.dragging).toBe("true");
    expect(ghost?.dataset.accepted).toBe("true");
    expect(ghost?.textContent).toBe("ポケットの本文");
    // ゴーストはポインタのすぐ右下に付いてくる。
    expect(ghost?.style.left).toBe("214px");
    expect(ghost?.style.top).toBe("314px");
    // 並びは動かさず、項目は減らない。
    expect(getPocketState().items.map((item) => item.id)).toEqual([id]);

    await act(async () => {
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 200, clientY: 300 }));
    });

    expect(dropped).toEqual(["drop"]);
    expect(document.querySelector("[data-accepted]")).toBeNull();
    expect(card.dataset.dragging).toBeUndefined();
    expect(container.querySelector('[data-inserted="true"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("ポケットから挿入しました");
  });

  it("says nothing for a drop that nobody took, and keeps the item", async () => {
    await act(async () => {
      putBlocks();
    });
    await render();
    const card = cards()[0]!;
    document.elementFromPoint = () => document.body;

    await act(async () => {
      card.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true, clientX: 50, clientY: 20 }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 200, clientY: 300 }));
    });
    expect((document.querySelector("[data-accepted]") as HTMLElement | null)?.dataset.accepted).toBe("false");
    await act(async () => {
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 200, clientY: 300 }));
    });

    expect(container.querySelector('[data-inserted="true"]')).toBeNull();
    expect(cards()).toHaveLength(1);
  });

  it("does not insert twice when a drag is released over the card it came from", async () => {
    let pastes = 0;
    const onPaste = (event: ClipboardEvent) => {
      pastes += 1;
      event.preventDefault();
    };
    window.addEventListener("paste", onPaste);
    await act(async () => {
      putBlocks();
    });
    await render();
    const card = cards()[0]!;
    document.elementFromPoint = () => card;

    await act(async () => {
      card.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, isPrimary: true, clientX: 50, clientY: 20 }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 90, clientY: 40 }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 90, clientY: 40 }));
      // ブラウザは、同じ要素の上で押して離したので click も送る。
      card.click();
    });
    window.removeEventListener("paste", onPaste);

    expect(pastes).toBe(0);
  });

  it("starts no drag from a secondary button", async () => {
    await act(async () => {
      putBlocks();
    });
    await render();
    const card = cards()[0]!;
    document.elementFromPoint = () => document.body;

    await act(async () => {
      card.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 2, isPrimary: true, clientX: 50, clientY: 20 }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 200, clientY: 300 }));
    });

    expect(card.dataset.dragging).toBeUndefined();
    expect(document.querySelector("[data-accepted]")).toBeNull();
  });

  it("inserts when a card is pressed, and keeps the card", async () => {
    let pastes = 0;
    const onPaste = (event: ClipboardEvent) => {
      pastes += 1;
      event.preventDefault();
    };
    window.addEventListener("paste", onPaste);
    await act(async () => {
      putBlocks();
    });
    await render();

    await act(async () => cards()[0]?.click());

    window.removeEventListener("paste", onPaste);
    expect(pastes).toBe(1);
    expect(cards()).toHaveLength(1);
    // 入れられたことは、カードの上のチェックと読み上げで知らせる。
    expect(container.querySelector('[data-inserted="true"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("ポケットから挿入しました");
  });

  it("tells the user when there was nowhere to insert", async () => {
    await act(async () => {
      putBlocks();
    });
    await render();

    await act(async () => cards()[0]?.click());

    expect(container.textContent).toContain("ここには挿入できません");
    expect(container.querySelector('[data-inserted="true"]')).toBeNull();
  });

  it("removes a card, offers an undo, and the undo puts it back where it was", async () => {
    await act(async () => {
      putBlocks();
      putShapes();
    });
    await render();

    await act(async () => buttonByLabel("ポケットから外す").click());
    expect(cards().map((card) => card.dataset.kind)).toEqual(["shapes"]);
    expect(container.textContent).toContain("1件を外しました");

    await act(async () => buttonByLabel("元に戻す").click());
    expect(cards().map((card) => card.dataset.kind)).toEqual(["blocks", "shapes"]);
    expect(container.textContent).not.toContain("1件を外しました");
  });

  it("removes the focused card with Delete", async () => {
    await act(async () => {
      putBlocks();
    });
    await render();

    await act(async () => {
      cards()[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
    });

    expect(cards()).toHaveLength(0);
    expect(getPocketState().removal?.removed).toHaveLength(1);
  });

  it("offers 'remove all' only when there is more than one card", async () => {
    await act(async () => {
      putBlocks();
    });
    await render();
    expect(container.querySelector('[aria-label="すべて外す"]')).toBeNull();

    await act(async () => {
      putShapes();
    });
    await act(async () => buttonByLabel("すべて外す").click());

    expect(cards()).toHaveLength(0);
    expect(container.textContent).toContain("2件を外しました");
  });

  it("collapses to a handle that shows the count and opens again", async () => {
    await act(async () => {
      putBlocks();
      putShapes();
    });
    await render();

    await act(async () => buttonByLabel("ポケットを閉じる").click());
    await afterTransition();
    expect(cards()).toHaveLength(0);
    expect(buttonByLabel(/ポケット 2件/)).toBeDefined();

    await act(async () => buttonByLabel(/ポケット 2件/).click());
    expect(cards()).toHaveLength(2);
  });

  it("keeps drawing the open pocket while it folds away, out of reach, then switches to the chip", async () => {
    await act(async () => {
      putBlocks();
    });
    await render();
    const bar = () => container.querySelector<HTMLElement>("[data-pocket-root]");

    await act(async () => buttonByLabel("ポケットを閉じる").click());

    // 畳む動きの最中: 中身はまだあるが、押せない (畳まれていく途中の押し間違いを避ける)。
    expect(getPocketState().expanded).toBe(false);
    expect(cards()).toHaveLength(1);
    expect(bar()?.dataset.phase).toBe("expanded");
    expect(bar()?.dataset.closing).toBe("true");

    await afterTransition();

    expect(bar()?.dataset.phase).toBe("collapsed");
    expect(bar()?.dataset.closing).toBeUndefined();
    expect(cards()).toHaveLength(0);
  });

  it("stays open if it is opened again while it is still folding away", async () => {
    await act(async () => {
      putBlocks();
    });
    await render();
    await act(async () => buttonByLabel("ポケットを閉じる").click());
    expect(container.querySelector<HTMLElement>("[data-pocket-root]")?.dataset.closing).toBe("true");

    await act(async () => {
      setPocketExpanded(true);
    });
    await afterTransition();

    const bar = container.querySelector<HTMLElement>("[data-pocket-root]");
    expect(bar?.dataset.phase).toBe("expanded");
    expect(bar?.dataset.closing).toBeUndefined();
    expect(cards()).toHaveLength(1);
  });

  it("folds away at once for someone who asked for less motion", async () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), media: query } as MediaQueryList)) as typeof window.matchMedia;
    try {
      await act(async () => {
        putBlocks();
      });
      await render();

      await act(async () => buttonByLabel("ポケットを閉じる").click());

      expect(container.querySelector<HTMLElement>("[data-pocket-root]")?.dataset.phase).toBe("collapsed");
      expect(cards()).toHaveLength(0);
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  it("shows an empty pocket's hint and the reason a put-in failed", async () => {
    await act(async () => {
      setPocketExpanded(true);
    });
    await render();
    expect(container.textContent).toContain("選んだ文章や図形を追加しておくと");

    await act(async () => {
      showPocketNotice("nothing");
    });
    expect(container.textContent).toContain("追加するものが選ばれていません");
    // 理由が出ている間は、同じ場所の説明を重ねない。
    expect(container.textContent).not.toContain("選んだ文章や図形を追加しておくと");
  });

  it("does not take focus from the page when it is pressed, so the caret and selection stay", async () => {
    await act(async () => {
      putBlocks();
    });
    await render();
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });

    cards()[0]?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  it("uses the English dictionary when the app is in English", async () => {
    setAppLocale("en");
    await act(async () => {
      putShapes();
    });
    await render();

    expect(cards()[0]?.getAttribute("aria-label")).toBe("Insert 1 shapes");
    expect(container.textContent).toContain("Pocket");
    setAppLocale("ja");
  });

  it("does not render for a store that was emptied behind its back", async () => {
    await act(async () => {
      putBlocks();
    });
    await render();
    await act(async () => {
      removeFromPocket(getPocketState().items.map((item) => item.id));
      setPocketExpanded(false);
    });

    expect(container.innerHTML).toBe("");
  });

  describe("the part that was put in flies into the pocket", () => {
    interface FakeAnimation {
      keyframes: Array<Record<string, unknown>>;
      options: { duration: number };
      finish: () => void;
      cancel: ReturnType<typeof vi.fn>;
    }
    let animations: FakeAnimation[];
    let original: typeof Element.prototype.animate;
    let disposers: Array<() => void>;

    const settle = (ms = 40) => act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });

    beforeEach(() => {
      animations = [];
      disposers = [];
      original = Element.prototype.animate;
      Element.prototype.animate = function animate(this: Element, keyframes: unknown, options: unknown) {
        let finish = () => {};
        const finished = new Promise<void>((resolve) => { finish = resolve; });
        const cancel = vi.fn();
        animations.push({ keyframes: keyframes as FakeAnimation["keyframes"], options: options as FakeAnimation["options"], finish, cancel });
        return { finished, cancel } as unknown as Animation;
      } as typeof Element.prototype.animate;
    });

    afterEach(() => {
      Element.prototype.animate = original;
      disposers.forEach((dispose) => dispose());
    });

    it("hides the card while the part flies, then lets it land with a bounce", async () => {
      disposers.push(registerPocketPageHost({
        placeOnPage: () => false,
        // 幅はカード (168) の 2 倍。出発の大きさはこの比 (2 倍) になる。
        getSelectionRect: () => ({ left: 100, top: 300, width: 336, height: 20 }),
      }));
      // happy-dom は座標を持たないので、着く先のカードの位置を決める: 中心 (484, 156)。
      const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
        { left: 400, top: 120, width: 168, height: 72, right: 568, bottom: 192, x: 400, y: 120, toJSON: () => ({}) },
      );
      disposers.push(() => rect.mockRestore());
      await render();

      await act(async () => {
        putBlocks();
      });
      await settle(400);

      // 着く先のカードと同じ姿のものが飛び、本物のカードは着くまで隠れている。
      const flyer = document.querySelector("[data-pocket-flyer]");
      expect(flyer).not.toBeNull();
      expect(flyer?.querySelector("[class*='cardPreview']")).not.toBeNull();
      expect(cards()[0]?.dataset.flying).toBe("true");
      expect(animations).toHaveLength(1);
      const [first, , middle, last] = animations[0]!.keyframes;
      // 選択の中心 (268, 310) から始まり、真ん中で持ち上がり、カードの位置 (移動 0) で終わる。
      expect(first?.transform).toBe("translate(-216px, 154px) scale(2)");
      expect(String(middle?.transform)).toContain("translate(-108px, 41px)");
      expect(last?.transform).toBe("translate(0px, 0px) scale(1)");
      expect(animations[0]?.options.duration).toBeGreaterThan(300);

      await act(async () => {
        animations[0]!.finish();
        await Promise.resolve();
      });

      expect(document.querySelector("[data-pocket-flyer]")).toBeNull();
      expect(cards()[0]?.dataset.flying).toBeUndefined();
      expect(cards()[0]?.dataset.landed).toBe("true");
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 450));
      });
      expect(cards()[0]?.dataset.landed).toBeUndefined();
    });

    it("shows no flight when the page cannot say where the selection was", async () => {
      disposers.push(registerPocketPageHost({ placeOnPage: () => false, getSelectionRect: () => null }));
      await render();

      await act(async () => {
        putBlocks();
      });
      await settle(400);

      expect(document.querySelector("[data-pocket-flyer]")).toBeNull();
      expect(animations).toHaveLength(0);
      expect(cards()[0]?.dataset.flying).toBeUndefined();
    });

    it("shows no flight for someone who asked for less motion", async () => {
      disposers.push(registerPocketPageHost({
        placeOnPage: () => false,
        getSelectionRect: () => ({ left: 100, top: 300, width: 200, height: 20 }),
      }));
      const matchMedia = window.matchMedia;
      window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), media: query } as MediaQueryList)) as typeof window.matchMedia;
      try {
        await render();
        await act(async () => {
          putBlocks();
        });
        await settle(400);

        expect(document.querySelector("[data-pocket-flyer]")).toBeNull();
        expect(cards()[0]?.dataset.flying).toBeUndefined();
      } finally {
        window.matchMedia = matchMedia;
      }
    });

    it("waits for the pocket to finish opening before it flies, because the card is still moving", async () => {
      disposers.push(registerPocketPageHost({
        placeOnPage: () => false,
        getSelectionRect: () => ({ left: 100, top: 300, width: 200, height: 20 }),
      }));
      await render();

      await act(async () => {
        putBlocks();
      });
      await settle(120);
      // 開く動きの最中: カードはもう並んでいるが、まだ飛ばさない。
      expect(cards()).toHaveLength(1);
      expect(document.querySelector("[data-pocket-flyer]")).toBeNull();
      expect(animations).toHaveLength(0);

      await settle(260);
      expect(document.querySelector("[data-pocket-flyer]")).not.toBeNull();
    });

    it("flies at once when the pocket was already open", async () => {
      disposers.push(registerPocketPageHost({
        placeOnPage: () => false,
        getSelectionRect: () => ({ left: 100, top: 300, width: 200, height: 20 }),
      }));
      await render();
      await act(async () => {
        putBlocks();
      });
      await settle(400);
      await act(async () => {
        animations[0]!.finish();
        await Promise.resolve();
      });
      expect(document.querySelector("[data-pocket-flyer]")).toBeNull();

      await act(async () => {
        putShapes();
      });
      await settle(60);

      expect(document.querySelector("[data-pocket-flyer]")).not.toBeNull();
      expect(animations).toHaveLength(2);
    });

    it("throws the flight away when the pocket is closed mid-air, so it does not start again on reopening", async () => {
      disposers.push(registerPocketPageHost({
        placeOnPage: () => false,
        getSelectionRect: () => ({ left: 100, top: 300, width: 200, height: 20 }),
      }));
      await render();
      await act(async () => {
        putBlocks();
      });
      await settle(400);
      expect(document.querySelector("[data-pocket-flyer]")).not.toBeNull();

      await act(async () => buttonByLabel("ポケットを閉じる").click());
      await afterTransition();
      await act(async () => buttonByLabel(/ポケット 1件/).click());
      await settle();

      expect(document.querySelector("[data-pocket-flyer]")).toBeNull();
      expect(animations[0]?.cancel).toHaveBeenCalled();
    });
  });

  describe("the closed pocket's chip", () => {
    const move = (y: number) => window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 600, clientY: y }));
    const bar = () => container.querySelector<HTMLElement>('[data-phase="collapsed"]');

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function renderClosed(): Promise<void> {
      await act(async () => {
        putBlocks();
        setPocketExpanded(false);
      });
      await render();
      expect(bar()).not.toBeNull();
    }

    it("stays out of sight until the pointer goes to the top, then appears", async () => {
      await renderClosed();
      expect(bar()?.dataset.revealed).toBeUndefined();

      // 段の上端 (ここでは 0) から下の帯へマウスが入って、少し留まると出る。
      await act(async () => {
        move(20);
        vi.advanceTimersByTime(60);
      });
      expect(bar()?.dataset.revealed).toBeUndefined();
      await act(async () => {
        vi.advanceTimersByTime(100);
      });
      expect(bar()?.dataset.revealed).toBe("true");
    });

    it("does not flash when the pointer only passes through on its way to the toolbar", async () => {
      await renderClosed();

      await act(async () => {
        move(20);
        vi.advanceTimersByTime(60);
        move(300);
        vi.advanceTimersByTime(1000);
      });

      expect(bar()?.dataset.revealed).toBeUndefined();
    });

    it("goes away again a moment after the pointer leaves the top", async () => {
      await renderClosed();
      await act(async () => {
        move(20);
        vi.advanceTimersByTime(200);
      });
      expect(bar()?.dataset.revealed).toBe("true");

      await act(async () => {
        move(400);
        vi.advanceTimersByTime(200);
      });
      expect(bar()?.dataset.revealed).toBe("true");
      await act(async () => {
        vi.advanceTimersByTime(400);
      });
      expect(bar()?.dataset.revealed).toBeUndefined();
    });

    it("stays reachable from the keyboard while it is out of sight, and opens the pocket", async () => {
      await renderClosed();

      const handle = buttonByLabel(/ポケット 1件/);
      expect(handle.tabIndex).toBe(0);
      await act(async () => handle.click());

      expect(getPocketState().expanded).toBe(true);
    });
  });
});
