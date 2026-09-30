// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CustomCommandComposer } from "./CustomCommandComposer";
import type { EditorCustomCommandAction, ResolvedEditorCommand } from "@/lib/editor-command-shortcuts";

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  const entries = new Map<string, string>([["sigma-studio:ui-locale", "ja"]]);
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => { entries.set(key, value); },
      removeItem: (key: string) => { entries.delete(key); },
      clear: () => entries.clear(),
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const builtIn: ResolvedEditorCommand[] = [
  {
    id: "insert.pageBreak", categoryId: "insert", defaultBinding: null,
    label: "改ページ・改段を挿入", category: "挿入", keywords: "", description: "",
  },
];

async function render(onSubmit: (input: { label: string; actions: EditorCustomCommandAction[] }) => void) {
  await act(async () => {
    root.render(
      <CustomCommandComposer
        fontFamilyOptions={[{ label: "M PLUS 1p", value: "'M PLUS 1p', sans-serif" }]}
        builtInCommands={builtIn}
        onSubmit={onSubmit}
        onInvalid={() => {}}
      />,
    );
  });
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === name || item.getAttribute("aria-label") === name);
  if (!found) throw new Error(`button not found: ${name}`);
  return found;
}

describe("CustomCommandComposer", () => {
  it("is a single always-open form: one step to start, no toggle", async () => {
    await render(() => {});
    expect(container.querySelectorAll(".custom-command-step")).toHaveLength(1);
    expect(container.querySelector("[aria-controls='custom-command-panel']")).toBeNull();
    // 1 件だけの操作には削除ボタンを出さない。
    expect(container.querySelector("[aria-label='操作 1 を削除']")).toBeNull();
  });

  it("names an unnamed command from what it does", async () => {
    const onSubmit = vi.fn();
    await render(onSubmit);
    await act(async () => button("追加").click());
    expect(onSubmit).toHaveBeenCalledWith({
      label: "文字装飾: 太字",
      actions: [{ type: "textFormat", command: "bold" }],
    });
  });

  it("chains steps, lets the user remove one, and resets after adding", async () => {
    const onSubmit = vi.fn();
    await render(onSubmit);
    await act(async () => button("操作を追加").click());
    expect(container.querySelectorAll(".custom-command-step")).toHaveLength(2);

    await act(async () => button("操作 2 を削除").click());
    expect(container.querySelectorAll(".custom-command-step")).toHaveLength(1);

    await act(async () => button("操作を追加").click());
    await act(async () => button("追加").click());
    expect(onSubmit.mock.calls[0][0].actions).toEqual([
      { type: "textFormat", command: "bold" },
      { type: "textFormat", command: "bold" },
    ]);
    expect(container.querySelectorAll(".custom-command-step")).toHaveLength(1);
  });
});
