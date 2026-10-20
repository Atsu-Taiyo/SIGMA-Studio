// @vitest-environment happy-dom

import { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SearchField } from "./SearchField";
import type { SearchFieldProps } from "./SearchField";

let container: HTMLDivElement;
let root: Root;

// createRoot + act をテスト環境として使うことを React に伝える (React 18 以降の要求)。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({ initial = "", ...props }: { initial?: string } & Partial<SearchFieldProps>) {
  const [value, setValue] = useState(initial);
  return <SearchField aria-label="教材を検索" placeholder="すべてを検索" {...props} value={value} onChange={(next) => { setValue(next); props.onChange?.(next); }} />;
}

function render(node: React.ReactNode) {
  act(() => {
    root.render(node);
  });
}

function input(): HTMLInputElement {
  const element = container.querySelector<HTMLInputElement>("input");
  if (!element) throw new Error("検索欄の入力が見つかりません");
  return element;
}

function clearButton(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>("button");
}

function type(text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setValue.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
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

describe("SearchField", () => {
  it("is a named searchbox with the shared size and no clear button while empty", () => {
    render(<Harness />);
    expect(input().type).toBe("search");
    expect(input().getAttribute("aria-label")).toBe("教材を検索");
    expect(input().placeholder).toBe("すべてを検索");
    expect(container.querySelector("[data-search-field]")?.getAttribute("data-size")).toBe("md");
    expect(clearButton()).toBeNull();
  });

  it("shows the clear button only for a query with visible characters", () => {
    render(<Harness />);
    type("   ");
    expect(clearButton()).toBeNull();
    type("三角関数");
    expect(clearButton()?.getAttribute("aria-label")).toBe("検索をクリア");
  });

  it("reports typed text and clears it back to empty, keeping focus in the input", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    type("sin");
    expect(onChange).toHaveBeenLastCalledWith("sin");
    act(() => clearButton()!.click());
    expect(onChange).toHaveBeenLastCalledWith("");
    expect(input().value).toBe("");
    expect(clearButton()).toBeNull();
    expect(document.activeElement).toBe(input());
  });

  it("does not take focus from the input when the clear button is pressed", () => {
    render(<Harness initial="sin" />);
    const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    act(() => { clearButton()!.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
  });

  it("runs onClear instead of onChange when the owner needs a different clear", () => {
    const onChange = vi.fn();
    const onClear = vi.fn();
    render(<SearchField aria-label="検索" value="sin" onChange={onChange} onClear={onClear} />);
    act(() => clearButton()!.click());
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("offers three sizes and defaults to the dialog-toolbar one", () => {
    render(<>
      <SearchField aria-label="既定" value="" onChange={() => {}} />
      <SearchField aria-label="大" size="lg" value="" onChange={() => {}} />
      <SearchField aria-label="小" size="sm" value="" onChange={() => {}} />
    </>);
    const sizes = Array.from(container.querySelectorAll("[data-search-field]")).map((field) => field.getAttribute("data-size"));
    expect(sizes).toEqual(["md", "lg", "sm"]);
  });

  it("can keep the right-hand button while empty so it also closes the field", () => {
    const onClear = vi.fn();
    render(<SearchField aria-label="ファイルを検索" value="" onChange={() => {}} alwaysShowClear clearLabel="検索を閉じる" onClear={onClear} />);
    expect(clearButton()?.getAttribute("aria-label")).toBe("検索を閉じる");
    act(() => clearButton()!.click());
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("shows trailing content between the input and the clear button", () => {
    render(<SearchField aria-label="検索" value="sin" onChange={() => {}} trailing={<span data-testid="count">3件</span>} />);
    const field = container.querySelector("[data-search-field]")!;
    const parts = Array.from(field.children).map((child) => child.tagName.toLowerCase());
    expect(parts).toEqual(["svg", "input", "span", "button"]);
    expect(field.querySelector("[data-testid='count']")?.textContent).toBe("3件");
  });

  it("disables the clear button together with the input", () => {
    render(<SearchField aria-label="検索" value="sin" onChange={() => {}} disabled />);
    expect(input().disabled).toBe(true);
    expect(clearButton()?.disabled).toBe(true);
  });

  it("takes the compact size, layout class, input attributes and ref from the caller", () => {
    const ref = createRef<HTMLInputElement>();
    render(<SearchField ref={ref} size="sm" className="font-family-menu-search" aria-label="フォントを検索" clearLabel="消す" data-popover-initial-focus="" value="Hira" onChange={() => {}} />);
    const field = container.querySelector("[data-search-field]")!;
    expect(field.getAttribute("data-size")).toBe("sm");
    expect(field.classList.contains("font-family-menu-search")).toBe(true);
    expect(input().hasAttribute("data-popover-initial-focus")).toBe(true);
    expect(ref.current).toBe(input());
    expect(clearButton()?.getAttribute("aria-label")).toBe("消す");
  });
});
