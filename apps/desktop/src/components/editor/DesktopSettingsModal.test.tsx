// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { setAppLocale } from "@/lib/i18n/react";
import type { DesktopAPI } from "@/types/desktop";

import { DesktopSettingsModal, LanguageChangeDialog, LanguageSettingButton } from "./DesktopSettingsModal";

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
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

async function renderDialog(props: Partial<Parameters<typeof LanguageChangeDialog>[0]> = {}) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  await act(async () => {
    root.render(
      <LanguageChangeDialog
        open
        currentLocale="ja"
        selectedLocale="ja"
        onLocaleChange={vi.fn()}
        onCancel={onCancel}
        onConfirm={onConfirm}
        {...props}
      />,
    );
  });
  await act(async () => window.requestAnimationFrame(() => {}));
  return { onCancel, onConfirm };
}

describe("LanguageChangeDialog", () => {
  it("shows both language choices and marks the current selection", async () => {
    await renderDialog();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');

    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.textContent).toContain("表示言語を選択");
    expect(dialog?.textContent).toContain("現在の言語");
    expect(dialog?.querySelector('[lang="ja"]')).not.toBeNull();
    expect(dialog?.querySelector('[lang="en"]')).not.toBeNull();
    expect(dialog?.textContent).toContain("編集中の教材や入力内容は変更されません。");
    expect(dialog?.querySelector('[aria-pressed="true"] [lang="ja"]')).not.toBeNull();
    expect(dialog?.querySelector<HTMLButtonElement>('button[data-tone="primary"]')?.disabled).toBe(true);
  });

  it("focuses the selected language and enables an explicit switch after choosing another", async () => {
    const onLocaleChange = vi.fn();
    const { onConfirm } = await renderDialog({ selectedLocale: "en", onLocaleChange });
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
    const english = buttons.find((button) => button.querySelector('[lang="en"]'));
    const confirm = buttons.find((button) => button.textContent?.includes("Englishへ切り替える"));

    expect(document.activeElement).toBe(english);
    expect(confirm?.disabled).toBe(false);
    await act(async () => english?.click());
    expect(onLocaleChange).toHaveBeenCalledWith("en");
    await act(async () => confirm?.click());
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

describe("LanguageSettingButton", () => {
  it("shows the active language in the settings row and opens its dialog", async () => {
    const onOpen = vi.fn();
    await act(async () => {
      root.render(<LanguageSettingButton locale="ja" dialogOpen={false} onOpen={onOpen} />);
    });

    const button = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
    expect(button?.textContent).toContain("JA");
    expect(button?.textContent).toContain("日本語");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
    expect(button?.getAttribute("aria-label")).toBe("表示言語を変更（現在：日本語）");

    await act(async () => button?.click());
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe("DesktopSettingsModal on the web", () => {
  it("keeps the display-language setting available without the desktop bridge", async () => {
    await act(async () => {
      root.render(<DesktopSettingsModal open onClose={vi.fn()} />);
    });

    const settingsDialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="設定"]');
    const languageButton = settingsDialog?.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
    expect(settingsDialog?.textContent).toContain("表示言語");
    expect(languageButton?.textContent).toContain("日本語");

    await act(async () => languageButton?.click());
    const englishOption = [...document.querySelectorAll<HTMLButtonElement>('.language-option-card')]
      .find((button) => button.querySelector('[lang="en"]'));
    await act(async () => englishOption?.click());
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('.language-change-actions button')]
      .find((button) => button.textContent?.includes("Englishへ切り替える"));
    await act(async () => confirm?.click());

    expect(document.querySelector<HTMLElement>('[role="dialog"][aria-label="Settings"]')).not.toBeNull();
    expect(window.localStorage.getItem("sigma-studio:ui-locale")).toBe("en");
  });
});

describe("DesktopSettingsModal updates", () => {
  function installBridge(supported: boolean) {
    const status = { phase: "idle" as const, supported, currentVersion: "0.515.1", releaseUrl: "https://github.com/Atsu-Taiyo/SIGMA-Studio/releases/latest" };
    const updater = {
      getStatus: vi.fn().mockResolvedValue(status),
      checkForUpdates: vi.fn().mockResolvedValue({ ...status, phase: "not-available" }),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn(),
      onStatusChange: vi.fn(() => () => {}),
    };
    const openLatestReleasePage = vi.fn().mockResolvedValue({ ok: true });
    window.desktopAPI = {
      platform: "win32",
      app: { getInfo: vi.fn().mockResolvedValue({ version: "0.515.1", releaseUrl: status.releaseUrl }), openLatestReleasePage },
      storage: { getDataDir: vi.fn().mockResolvedValue({ path: "/test/profile" }) },
      codex: {
        getStatus: vi.fn().mockResolvedValue({ available: false, loggedIn: false }),
        onStatusChange: vi.fn(() => () => {}),
      },
      updater,
    } as unknown as DesktopAPI;
    return { updater, openLatestReleasePage };
  }

  it("shows the Store notice and preserves manual access without checking GitHub from the menu", async () => {
    const { updater, openLatestReleasePage } = installBridge(false);
    await act(async () => {
      root.render(<DesktopSettingsModal open onClose={vi.fn()} requestUpdateCheck={1} />);
    });

    const section = document.getElementById("desktop-settings-app-update");
    expect(section?.textContent).toContain("更新は Microsoft Store から自動的にインストールされます。");
    const buttons = [...section!.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map(button => button.textContent)).toEqual(["手動で開く"]);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    await act(async () => buttons[0].click());
    expect(openLatestReleasePage).toHaveBeenCalledOnce();
  });

  it("keeps the menu update check for existing Windows installer builds", async () => {
    const { updater } = installBridge(true);
    await act(async () => {
      root.render(<DesktopSettingsModal open onClose={vi.fn()} requestUpdateCheck={1} />);
    });

    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    const section = document.getElementById("desktop-settings-app-update");
    expect(section?.textContent).toContain("現在のバージョンは最新版です。");
    expect(section?.textContent).toContain("最新版を確認");
  });
});
