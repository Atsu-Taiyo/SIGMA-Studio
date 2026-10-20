// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTranslator } from "@/lib/i18n";
import type { OutlineNavigationItem } from "@/lib/outline-navigation";

import { OutlineDock } from "./OutlineDock";

const items: OutlineNavigationItem[] = [
  { id: "h1", title: "二次関数", kind: "heading", depth: 0, number: "1" },
  { id: "h2", title: "平方完成", kind: "heading", depth: 1, number: "1.1" },
  { id: "p1", title: "問題 1", kind: "problem", depth: 2 },
];

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function render(props: Partial<Parameters<typeof OutlineDock>[0]> = {}) {
  const onSelectItem = vi.fn();
  const element = (next: Partial<Parameters<typeof OutlineDock>[0]> = {}) => (
    <OutlineDock items={items} selectedId={null} onSelectItem={onSelectItem} {...props} {...next} />
  );
  act(() => root.render(element()));
  return { onSelectItem, rerender: (next: Partial<Parameters<typeof OutlineDock>[0]>) => act(() => root.render(element(next))) };
}

const toggle = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
const card = () => container.querySelector<HTMLElement>("[role='region']");
const rows = () => Array.from(container.querySelectorAll<HTMLButtonElement>("nav button"));
const hover = () => act(() => {
  container.querySelector("[data-outline-dock]")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  // React は mouseenter を mouseover から合成する。
  container.querySelector("[data-outline-dock]")!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
});

describe("OutlineDock", () => {
  it("is only an icon until it is opened, and names the item count", () => {
    render();

    expect(toggle().getAttribute("aria-label")).toBe("アウトライン (3件)");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(card()).toBeNull();
  });

  it("opens a card on hover that lists headings with their numbers, depth and the selected row", () => {
    render({ selectedId: "h2" });
    hover();

    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(card()?.getAttribute("aria-label")).toBe("アウトライン");
    expect(rows().map((row) => row.textContent)).toEqual(["1二次関数", "1.1平方完成", "問題 1"]);
    expect(rows().map((row) => row.dataset.depth)).toEqual(["0", "1", "2"]);
    expect(rows().map((row) => row.dataset.kind)).toEqual(["heading", "heading", "problem"]);
    expect(rows().map((row) => row.getAttribute("aria-current"))).toEqual([null, "location", null]);
  });

  it("selects the clicked item and folds the card away", () => {
    const { onSelectItem } = render();
    hover();

    act(() => rows()[2]!.click());

    expect(onSelectItem).toHaveBeenCalledExactlyOnceWith("p1");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the click inside the dock so the canvas does not clear the selection it just made", () => {
    const onCanvasClick = vi.fn();
    const onSelectItem = vi.fn();
    act(() => root.render(
      <div onClick={onCanvasClick}>
        <OutlineDock items={items} selectedId={null} onSelectItem={onSelectItem} />
      </div>,
    ));
    hover();

    act(() => rows()[0]!.click());

    expect(onSelectItem).toHaveBeenCalledExactlyOnceWith("h1");
    expect(onCanvasClick).not.toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    render();
    hover();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes when the pointer leaves, after a short grace period", () => {
    vi.useFakeTimers();
    render();
    hover();

    act(() => {
      container.querySelector("[data-outline-dock]")!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      container.querySelector("[data-outline-dock]")!.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
    });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    act(() => vi.advanceTimersByTime(150));

    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("opens from a command request and moves focus to the selected row", () => {
    vi.useFakeTimers();
    const { rerender } = render({ selectedId: "h2", openRequest: 0 });
    expect(card()).toBeNull();

    rerender({ selectedId: "h2", openRequest: 1 });
    act(() => vi.advanceTimersByTime(50));

    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(rows()[1]);

    // 同じ値では開き直さない (再描画のたびに奪わない)。
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    rerender({ selectedId: "h2", openRequest: 1 });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });

  it("moves between rows with the arrow keys", () => {
    render();
    hover();
    act(() => rows()[0]!.focus());

    act(() => {
      rows()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(document.activeElement).toBe(rows()[1]);

    act(() => {
      rows()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(document.activeElement).toBe(rows()[2]);
  });

  it("has an English label too", () => {
    const t = createTranslator("en", "editor");

    expect(t("outline.titleWithCount", { replace: { items: 3 } })).toBe("Outline (3 items)");
    expect(t("outline.title")).toBe("Outline");
  });
});
