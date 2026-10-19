// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createAddedFontCommands, type EditorShortcutOverrides } from "@/lib/editor-command-shortcuts";

import { CommandSettingsDialog } from "./CommandSettingsDialog";

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

const addedFontCommands = createAddedFontCommands([
  { id: "font_0123abcd", displayName: "しろくま明朝", cssFamily: "\"Sigma Custom Font font_0123abcd\"" },
  { id: "plugin-9f8e7d", displayName: "数研ゴシック", cssFamily: "\"Sigma Plugin Font 9f8e7d\"" },
]);

async function render(overrides: EditorShortcutOverrides, onChange: (next: EditorShortcutOverrides) => void = () => {}) {
  await act(async () => {
    root.render(
      <CommandSettingsDialog
        overrides={overrides}
        customCommands={[]}
        addedFontCommands={addedFontCommands}
        fontFamilyOptions={[]}
        platform="mac"
        onChange={onChange}
        onCustomCommandsChange={() => {}}
        onClose={() => {}}
      />,
    );
  });
}

function rowLabels(): string[] {
  return [...document.querySelectorAll(".command-shortcuts-row:not(.header) strong")].map((item) => item.textContent ?? "");
}

function toggle(): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(".command-shortcuts-subgroup-toggle");
  if (!found) throw new Error("added font toggle not found");
  return found;
}

describe("CommandSettingsDialog added fonts", () => {
  it("folds added fonts under the font category and opens them on demand", async () => {
    await render({});
    expect(toggle().textContent).toContain("追加フォント");
    expect(toggle().textContent).toContain("2");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(rowLabels()).not.toContain("フォント: しろくま明朝");
    // 「フォント」カテゴリの中 (組み込みの書体コマンドの後) に置く。
    const category = toggle().closest(".command-shortcuts-group")?.querySelector(".command-shortcuts-category");
    expect(category?.textContent).toBe("フォント");

    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(rowLabels()).toEqual(expect.arrayContaining(["フォント: しろくま明朝", "フォント: 数研ゴシック"]));
  });

  it("shows matching added fonts while searching even when folded", async () => {
    await render({});
    const search = document.querySelector<HTMLInputElement>(".command-settings-search input")!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(search, "数研");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(rowLabels()).toEqual(["フォント: 数研ゴシック"]);
  });

  it("records a key on an added font and counts assigned fonts on the folded header", async () => {
    const onChange = vi.fn();
    await render({}, onChange);
    await act(async () => toggle().click());
    const capture = document.querySelector<HTMLButtonElement>('[aria-label="フォント: 数研ゴシック のキー割り当てを変更"]');
    expect(capture).toBeTruthy();
    await act(async () => capture!.click());
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "m", code: "KeyM", metaKey: true, altKey: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith({ "format.font.added.plugin-9f8e7d": { key: "m", primary: true, alt: true } });

    await render({ "format.font.added.plugin-9f8e7d": { key: "m", primary: true, alt: true } });
    expect(toggle().textContent).toContain("キー設定済み 1");
  });
});
