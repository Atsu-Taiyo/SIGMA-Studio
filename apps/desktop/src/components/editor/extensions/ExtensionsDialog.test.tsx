// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setAppLocale } from "@/lib/i18n/react";
import type { DesktopAPI, DesktopCustomFont, DesktopFontsAPI, DesktopFontsResult } from "@/types/desktop";

import { ExtensionsDialog } from "./ExtensionsDialog";

let container: HTMLDivElement;
let root: Root;

const serif: DesktopCustomFont = {
  id: "font-serif", displayName: "Example Serif", fileName: "ExampleSerif-Regular.otf",
  cssFamily: '"Example Serif"', importedAt: "2026-10-01T09:00:00.000Z", url: "sigma-font://serif.otf",
};
const sans: DesktopCustomFont = {
  id: "font-sans", displayName: "Example Sans", fileName: "ExampleSans.ttf",
  cssFamily: '"Example Sans"', importedAt: "2026-10-02T09:00:00.000Z", url: "sigma-font://sans.ttf",
};

function installFonts(initial: DesktopCustomFont[], overrides: Partial<DesktopFontsAPI> = {}) {
  let fonts = initial;
  const fontsApi: DesktopFontsAPI = {
    list: vi.fn(async (): Promise<DesktopFontsResult> => ({ ok: true, fonts })),
    importFont: vi.fn(async (): Promise<DesktopFontsResult> => ({ ok: true, fonts })),
    deleteFont: vi.fn(async (id: string): Promise<DesktopFontsResult> => {
      fonts = fonts.filter((font) => font.id !== id);
      return { ok: true, fonts };
    }),
    ...overrides,
  };
  window.desktopAPI = { fonts: fontsApi } as unknown as DesktopAPI;
  return fontsApi;
}

async function render(props: Partial<Parameters<typeof ExtensionsDialog>[0]> = {}) {
  const onClose = vi.fn();
  const onFontsChanged = vi.fn();
  await act(async () => {
    root.render(<ExtensionsDialog open onClose={onClose} onFontsChanged={onFontsChanged} {...props} />);
  });
  await act(async () => undefined);
  return { onClose, onFontsChanged };
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const fontsSection = () => document.getElementById("extensions-fonts");
const tiles = () => [...(fontsSection()?.querySelectorAll<HTMLElement>("ul > li") ?? [])];
const fontStatus = () => fontsSection()?.querySelector('[role="status"], [role="alert"]') ?? null;
const trigger = (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${name}のその他の操作"]`);
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const buttonByText = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
  .find((button) => button.textContent?.trim() === text);

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setAppLocale("ja");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.desktopAPI;
});

describe("ExtensionsDialog", () => {
  it("is a named dialog holding the fonts and plugin sections with their palette anchors", async () => {
    installFonts([]);
    await render();
    expect(dialog()?.getAttribute("aria-label")).toBe("拡張機能");
    expect(document.getElementById("extensions-fonts")?.textContent).toContain("フォント");
    expect(document.getElementById("extensions-plugins")?.textContent).toContain("公式プラグイン");
  });

  it("renders nothing while closed", async () => {
    installFonts([serif]);
    await render({ open: false });
    expect(dialog()).toBeNull();
  });

  it("shows only a sample drawn in the font and its name on each added font", async () => {
    installFonts([serif, sans]);
    await render();
    expect(tiles()).toHaveLength(2);
    const first = tiles()[0];
    const preview = first.querySelector<HTMLElement>('[aria-hidden="true"]');
    expect(preview?.textContent).toBe("Aあ");
    expect(preview?.style.fontFamily).toContain("Example Serif");
    expect(first.textContent).toContain("Example Serif");
    // 副次情報はタイルに出さない。
    expect(first.textContent).not.toContain("ExampleSerif-Regular.otf");
    expect(first.textContent).not.toContain("2026");
    expect(document.querySelector('button[aria-label="Example Serifを削除"]')).toBeNull();
    // 3点ボタンは常時見えている (ホバーで初めて現れるのではない)。
    expect(trigger("Example Serif")?.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("tucks the file name, added date and delete into the three-dot menu", async () => {
    installFonts([serif]);
    await render();
    expect(menu()).toBeNull();
    await act(async () => trigger("Example Serif")?.click());
    expect(trigger("Example Serif")?.getAttribute("aria-expanded")).toBe("true");
    expect(menu()?.textContent).toContain("ExampleSerif-Regular.otf");
    expect(menu()?.textContent).toContain("追加日");
    expect(menu()?.querySelector('[role="menuitem"]')?.textContent).toBe("削除");
  });

  it("deletes through the menu, closes it and tells the editor the fonts changed", async () => {
    const fonts = installFonts([serif, sans]);
    const { onFontsChanged } = await render();
    await act(async () => trigger("Example Serif")?.click());
    await act(async () => menu()?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click());
    expect(fonts.deleteFont).toHaveBeenCalledWith("font-serif");
    expect(onFontsChanged).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
    expect(tiles().map((tile) => tile.textContent)).toEqual([expect.stringContaining("Example Sans")]);
    expect(fontStatus()?.textContent).toBe("フォントを削除しました。");
  });

  it("closes the menu with Escape and returns focus to its trigger without closing the dialog", async () => {
    installFonts([serif]);
    const { onClose } = await render();
    const button = trigger("Example Serif");
    await act(async () => { button?.focus(); button?.click(); });
    await act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(menu()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
  });

  it("shows a short empty state and still offers the add button", async () => {
    installFonts([]);
    await render();
    expect(tiles()).toHaveLength(0);
    expect(fontsSection()?.textContent).toContain("追加済みフォントはありません。");
    expect(buttonByText("フォントを追加")?.disabled).toBe(false);
  });

  it("adds a font through the host and reports success, but stays quiet when the picker is canceled", async () => {
    const importFont = vi.fn<DesktopFontsAPI["importFont"]>()
      .mockResolvedValueOnce({ ok: true, canceled: true, fonts: [] })
      .mockResolvedValueOnce({ ok: true, fonts: [serif] });
    installFonts([], { importFont });
    const { onFontsChanged } = await render();
    await act(async () => buttonByText("フォントを追加")?.click());
    expect(fontStatus()).toBeNull();
    await act(async () => buttonByText("フォントを追加")?.click());
    expect(importFont).toHaveBeenCalledTimes(2);
    expect(onFontsChanged).toHaveBeenCalledTimes(2);
    expect(tiles()).toHaveLength(1);
    expect(fontStatus()?.textContent).toBe("フォントを追加しました。");
  });

  it("reports a failed delete and keeps the font", async () => {
    installFonts([serif], {
      deleteFont: vi.fn(async () => ({ ok: false, error: "削除できません", fonts: [serif] })),
    });
    await render();
    await act(async () => trigger("Example Serif")?.click());
    await act(async () => menu()?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click());
    expect(tiles()).toHaveLength(1);
    expect(fontStatus()?.textContent).toBe("削除できません");
  });

  it("localizes the menu trigger name and sample for English", async () => {
    setAppLocale("en");
    installFonts([serif]);
    await render();
    expect(dialog()?.getAttribute("aria-label")).toBe("Extensions");
    expect(document.querySelector('button[aria-label="More actions for Example Serif"]')).not.toBeNull();
    expect(tiles()[0].querySelector('[aria-hidden="true"]')?.textContent).toBe("Aa");
  });
});
