// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Select } from "./Select";

const OPTIONS = [
  { value: "x", label: "x軸" },
  { value: "y", label: "y軸" },
  { value: "locked", label: "選べない軸", disabled: true },
  { value: "z", label: "z軸" },
];

let container: HTMLDivElement;
let root: Root;

// createRoot + act をテスト環境として使うことを React に伝える (React 18 以降の要求)。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(node: React.ReactNode) {
  act(() => {
    root.render(node);
  });
}

function trigger(): HTMLButtonElement {
  const element = container.querySelector<HTMLButtonElement>(".ui-select");
  if (!element) throw new Error("Select のトリガーが見つかりません");
  return element;
}

function listbox(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="listbox"]');
}

function options(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
}

function press(key: string) {
  act(() => {
    trigger().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Select", () => {
  it("keeps the option list inside the app instead of handing it to the OS", () => {
    render(<Select aria-label="回転軸" value="y" options={OPTIONS} onChange={() => {}} />);

    expect(container.querySelector("select")).toBeNull();
    expect(trigger().getAttribute("role")).toBe("combobox");
    expect(trigger().getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger().textContent).toContain("y軸");
    // 閉じている間は選択肢のDOMを持たない。
    expect(listbox()).toBeNull();

    act(() => trigger().click());
    expect(listbox()).not.toBeNull();
    expect(options().map((option) => option.textContent)).toEqual(["x軸", "y軸", "選べない軸", "z軸"]);
    expect(options()[1].getAttribute("aria-selected")).toBe("true");
  });

  it("moves, commits, and cancels from the keyboard without leaving the trigger", () => {
    const picked: string[] = [];
    render(<Select aria-label="回転軸" value="y" options={OPTIONS} onChange={(value) => picked.push(value)} />);

    press("ArrowDown");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    // 開いた直後は現在値。次の ArrowDown は disabled を飛ばして z へ進む。
    expect(trigger().getAttribute("aria-activedescendant")).toBe(options()[1].id);
    press("ArrowDown");
    expect(trigger().getAttribute("aria-activedescendant")).toBe(options()[3].id);

    press("Enter");
    expect(picked).toEqual(["z"]);
    expect(listbox()).toBeNull();

    press("ArrowUp");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    press("Escape");
    expect(listbox()).toBeNull();
    expect(picked).toEqual(["z"]);
  });

  it("never commits a disabled option", () => {
    const picked: string[] = [];
    render(<Select aria-label="回転軸" value="x" options={OPTIONS} onChange={(value) => picked.push(value)} />);

    act(() => trigger().click());
    act(() => options()[2].click());
    expect(picked).toEqual([]);
    expect(listbox()).not.toBeNull();
  });

  it("publishes the current value and list size on the closed trigger", () => {
    render(<Select aria-label="回転軸" value="z" options={OPTIONS} onChange={() => {}} />);

    expect(trigger().dataset.value).toBe("z");
    expect(trigger().dataset.optionCount).toBe("4");
  });

  it("flattens grouped options into one keyboard sequence", () => {
    render(
      <Select
        aria-label="フォント"
        value="serif"
        options={[
          { label: "ゴシック", options: [{ value: "sans", label: "標準ゴシック" }] },
          { label: "明朝", options: [{ value: "serif", label: "標準明朝" }, { value: "mincho", label: "Hiragino Mincho" }] },
        ]}
        onChange={() => {}}
      />,
    );

    act(() => trigger().click());
    expect(options().map((option) => option.dataset.value)).toEqual(["sans", "serif", "mincho"]);
    expect(trigger().getAttribute("aria-activedescendant")).toBe(options()[1].id);
  });
});
