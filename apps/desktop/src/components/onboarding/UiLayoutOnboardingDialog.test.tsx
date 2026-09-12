// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { APP_READY_EVENT, SPLASH_MARKER_ATTRIBUTE, SPLASH_MAX_VISIBLE_MS } from "@/components/StartupSplash";

let UiLayoutOnboardingDialog: typeof import("./UiLayoutOnboardingDialog").UiLayoutOnboardingDialog;
let preferences: typeof import("@/lib/ui-layout-preference");
let container: HTMLDivElement;
let root: Root;
let splash: HTMLDivElement;

/** MutationObserver / Escape などのマイクロタスクを流すだけの短い待ち。 */
const TICK_MS = 20;

/**
 * happy-dom は localStorage を持たないので、preference が読む最小限だけを置く。
 *
 * 表示言語も一緒に仕込む: このファイルは閉じるボタンを `aria-label="閉じる"` で引くが、
 * happy-dom の `navigator.language` は "en-US" なので、仕込まないと共通の `Modal` が
 * 英語で描かれて選択できない (`vitest.setup.ts` の仕込みはここで上書きされる)。
 */
function installLocalStorage(): void {
  const store = new Map<string, string>([["sigma-studio:ui-locale", "ja"]]);
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string): string | null => store.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        store.set(key, value);
      },
      removeItem: (key: string): void => {
        store.delete(key);
      },
      clear: (): void => {
        store.clear();
      },
    },
  });
}

function setDesktopBridge(present: boolean): void {
  if (present) {
    Object.defineProperty(window, "desktopAPI", { configurable: true, value: {} });
    return;
  }
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, "desktopAPI");
}

async function mount(): Promise<void> {
  await act(async () => {
    root.render(<UiLayoutOnboardingDialog />);
    await Promise.resolve();
  });
  await advance(0);
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** 本物の起動シーケンス: 教材が開けた合図 → スプラッシュが要素ごと消える。 */
async function finishStartup(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event(APP_READY_EVENT));
    await Promise.resolve();
  });
  splash.remove();
  // MutationObserver の通知順は happy-dom のテスト順で揺れるため、実装側の
  // bounded fallback まで進めて起動完了状態を決定的にする。
  await advance(SPLASH_MAX_VISIBLE_MS + 1_000);
}

function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="dialog"]');
}

function card(mode: "docs" | "word"): HTMLButtonElement {
  const element = document.body.querySelector<HTMLButtonElement>(`[data-ui-layout-choice="${mode}"]`);
  if (!element) {
    throw new Error(`ui layout choice card not found: ${mode}`);
  }
  return element;
}

beforeAll(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  UiLayoutOnboardingDialog = (await import("./UiLayoutOnboardingDialog")).UiLayoutOnboardingDialog;
  preferences = await import("@/lib/ui-layout-preference");
});

beforeEach(() => {
  vi.useFakeTimers();
  setDesktopBridge(true);
  // 空にするだけではモジュール側のスナップショットキャッシュが前のテストの値を
  // 保ったままになる。保存経路で書くとキャッシュも無効化されるので初期値もこちらで作る。
  installLocalStorage();
  preferences.saveUiLayoutPreference({ mode: "docs", onboardingCompleted: false });
  container = document.createElement("div");
  document.body.append(container);
  // 起動直後はスプラッシュが画面を覆っている。オンボーディングはこれが消えてから出る。
  splash = document.createElement("div");
  splash.setAttribute(SPLASH_MARKER_ATTRIBUTE, "");
  document.body.append(splash);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  splash.remove();
  setDesktopBridge(false);
  vi.useRealTimers();
});

describe("UiLayoutOnboardingDialog", () => {
  it("stays hidden while the startup splash still covers the screen", async () => {
    await mount();
    await act(async () => {
      window.dispatchEvent(new Event(APP_READY_EVENT));
      await Promise.resolve();
    });
    await advance(TICK_MS);
    expect(dialog()).toBeNull();

    splash.remove();
    await advance(TICK_MS);
    expect(dialog()).not.toBeNull();
  });

  it("appears anyway if the splash never goes away", async () => {
    await mount();
    await act(async () => {
      window.dispatchEvent(new Event(APP_READY_EVENT));
      await Promise.resolve();
    });

    await advance(SPLASH_MAX_VISIBLE_MS + 1_000);
    expect(dialog()).not.toBeNull();
  });

  it("never appears while the app has not signalled that it is ready", async () => {
    // EditorShellが落ちた場合はapp-readyが来ない。クラッシュ画面をinertで塞がない。
    await mount();
    splash.remove();

    await advance(SPLASH_MAX_VISIBLE_MS + 10_000);
    expect(dialog()).toBeNull();
  });

  it("offers both layouts with a one-line description each", async () => {
    await mount();
    await finishStartup();

    expect(dialog()?.getAttribute("aria-label")).toBe("UIの表示を選ぶ");
    expect(card("word").textContent).toContain("Word風");
    expect(card("word").textContent).toContain("上部のタブでコマンドを切り替えます");
    expect(card("docs").textContent).toContain("Googleドキュメント風");
    expect(card("docs").textContent).toContain("1段のツールバーにまとめます（既定）");
  });

  it("never appears once onboarding is completed", async () => {
    preferences.saveUiLayoutPreference({ onboardingCompleted: true });

    await mount();
    await finishStartup();

    expect(dialog()).toBeNull();
  });

  it("never appears outside the desktop app", async () => {
    setDesktopBridge(false);

    await mount();
    await finishStartup();

    expect(dialog()).toBeNull();
  });

  it("applies and persists the picked layout, then closes", async () => {
    await mount();
    await finishStartup();

    await act(async () => {
      card("word").click();
      await Promise.resolve();
    });

    expect(preferences.getUiLayoutPreference()).toEqual({ mode: "word", onboardingCompleted: true, ribbonCollapsed: false });
    expect(dialog()).toBeNull();
  });

  it("keeps the current mode when the dialog is skipped", async () => {
    preferences.saveUiLayoutPreference({ mode: "word", onboardingCompleted: false });

    await mount();
    await finishStartup();

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-label="閉じる"]')?.click();
      await Promise.resolve();
    });

    expect(preferences.getUiLayoutPreference()).toEqual({ mode: "word", onboardingCompleted: true, ribbonCollapsed: false });
    expect(dialog()).toBeNull();
  });

  it("keeps the current mode when Escape skips the dialog", async () => {
    preferences.saveUiLayoutPreference({ mode: "word", onboardingCompleted: false });

    await mount();
    await finishStartup();

    await act(async () => {
      // ModalFrame の Escape は document の capture リスナー。window へ投げても届かない。
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });

    expect(preferences.getUiLayoutPreference()).toEqual({ mode: "word", onboardingCompleted: true, ribbonCollapsed: false });
    expect(dialog()).toBeNull();
  });

  it("marks the layout that is in effect so a re-opened dialog can be re-picked", async () => {
    preferences.saveUiLayoutPreference({ mode: "word", onboardingCompleted: false });

    await mount();
    await finishStartup();

    expect(card("word").dataset.selected).toBe("true");
    expect(card("word").getAttribute("aria-pressed")).toBe("true");
    expect(card("docs").dataset.selected).toBe("false");
    expect(card("docs").getAttribute("aria-pressed")).toBe("false");
  });

  it("puts the initial focus on the layout that is in effect, not on the close button", async () => {
    await mount();
    await finishStartup();
    await advance(TICK_MS);

    expect((document.activeElement as HTMLElement | null)?.dataset.uiLayoutChoice).toBe("docs");
  });

  it("closes even when the preference cannot be persisted", async () => {
    // 保存できないまま開いたままにすると、モーダルが背面をinertにするのでアプリごと
    // 操作不能になる。永続化の失敗は「次回また出る」で済ませる。
    await mount();
    await finishStartup();
    const storage = window.localStorage;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { ...storage, setItem: () => { throw new Error("storage is full"); } },
    });

    await act(async () => {
      card("word").click();
      await Promise.resolve();
    });

    expect(dialog()).toBeNull();
    expect(preferences.getUiLayoutPreference().onboardingCompleted).toBe(false);
  });

  it("reappears when the layout menu resets the onboarding flag", async () => {
    preferences.saveUiLayoutPreference({ onboardingCompleted: true });

    await mount();
    await finishStartup();
    expect(dialog()).toBeNull();

    await act(async () => {
      preferences.saveUiLayoutPreference({ onboardingCompleted: false });
      await Promise.resolve();
    });

    expect(dialog()).not.toBeNull();
  });
});
