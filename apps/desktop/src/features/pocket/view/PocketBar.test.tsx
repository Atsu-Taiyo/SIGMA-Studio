// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { OverlayShape, ParagraphNode } from "@/features/document";
import { setAppLocale } from "@/lib/i18n";
import {
  createOverlayClipboardPayload,
  createTextFlowClipboardPayload,
  writeEditorClipboardData,
} from "@/lib/editor-clipboard";

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
    expect(cards()).toHaveLength(0);
    expect(buttonByLabel(/ポケット 2件/)).toBeDefined();

    await act(async () => buttonByLabel(/ポケット 2件/).click());
    expect(cards()).toHaveLength(2);
  });

  it("shows an empty pocket's hint and the reason a put-in failed", async () => {
    await act(async () => {
      setPocketExpanded(true);
    });
    await render();
    expect(container.textContent).toContain("選んだ文章や図形を入れておくと");

    await act(async () => {
      showPocketNotice("nothing");
    });
    expect(container.textContent).toContain("入れるものが選ばれていません");
    // 理由が出ている間は、同じ場所の説明を重ねない。
    expect(container.textContent).not.toContain("選んだ文章や図形を入れておくと");
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
});
