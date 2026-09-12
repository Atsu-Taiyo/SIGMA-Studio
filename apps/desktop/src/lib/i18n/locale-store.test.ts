import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "sigma-studio:ui-locale";

class FakeWindow extends EventTarget {
  private readonly store = new Map<string, string>();

  localStorage = {
    getItem: (key: string): string | null => this.store.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      this.store.set(key, value);
    },
    removeItem: (key: string): void => {
      this.store.delete(key);
    },
    clear: (): void => {
      this.store.clear();
    },
  };
}

// Node's test environment has no StorageEvent constructor, so the cross-window
// event is modelled with the one field subscribe() actually inspects.
class FakeStorageEvent extends Event {
  readonly key: string | null;

  constructor(key: string | null) {
    super("storage");
    this.key = key;
  }
}

describe("locale-store", () => {
  let fakeWindow: FakeWindow;

  async function load(): Promise<typeof import("./locale-store")> {
    return import("./locale-store");
  }

  beforeEach(() => {
    fakeWindow = new FakeWindow();
    vi.stubGlobal("window", fakeWindow);
    vi.stubGlobal("navigator", undefined);
    // Each test gets a freshly imported module so the module-level snapshot
    // cache (and the i18next instance it drives) never leaks across tests.
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to Japanese when nothing is stored and no locale can be detected", async () => {
    const mod = await load();
    expect(mod.getAppLocale()).toBe("ja");
  });

  it("reads a stored locale", async () => {
    fakeWindow.localStorage.setItem(STORAGE_KEY, "en");
    const mod = await load();
    expect(mod.getAppLocale()).toBe("en");
  });

  it("ignores an unsupported stored value", async () => {
    fakeWindow.localStorage.setItem(STORAGE_KEY, "fr");
    const mod = await load();
    expect(mod.getAppLocale()).toBe("ja");
  });

  it("falls back to the detected OS locale when nothing is stored", async () => {
    vi.stubGlobal("navigator", { languages: ["en-US"], language: "en-US" });
    const mod = await load();
    expect(mod.getAppLocale()).toBe("en");
  });

  it("prefers the stored locale over the detected one", async () => {
    vi.stubGlobal("navigator", { languages: ["en-US"], language: "en-US" });
    fakeWindow.localStorage.setItem(STORAGE_KEY, "ja");
    const mod = await load();
    expect(mod.getAppLocale()).toBe("ja");
  });

  it("persists a selected locale under the sigma-studio namespace", async () => {
    const mod = await load();
    mod.setAppLocale("en");
    expect(fakeWindow.localStorage.getItem(STORAGE_KEY)).toBe("en");
    expect(mod.getAppLocale()).toBe("en");
  });

  it("notifies subscribers exactly once per change", async () => {
    const mod = await load();
    const listener = vi.fn();
    const unsubscribe = mod.subscribeAppLocale(listener);
    mod.setAppLocale("en");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("does not notify when the locale is unchanged", async () => {
    // useSyncExternalStore bails out on an unchanged snapshot anyway, but a
    // spurious notification still costs a store read on every subscriber and
    // the idle re-render budget is zero.
    const mod = await load();
    mod.setAppLocale("en");
    const listener = vi.fn();
    mod.subscribeAppLocale(listener);
    mod.setAppLocale("en");
    expect(listener).not.toHaveBeenCalled();
  });

  it("still rewrites storage when the locale is unchanged", async () => {
    // The resolved locale can come from OS detection with nothing stored yet.
    // Skipping the write there would leave the choice at the mercy of the OS.
    vi.stubGlobal("navigator", { languages: ["en-US"], language: "en-US" });
    const mod = await load();
    expect(fakeWindow.localStorage.getItem(STORAGE_KEY)).toBeNull();
    mod.setAppLocale("en");
    expect(fakeWindow.localStorage.getItem(STORAGE_KEY)).toBe("en");
  });

  it("stops notifying after unsubscribe", async () => {
    const mod = await load();
    const listener = vi.fn();
    mod.subscribeAppLocale(listener)();
    mod.setAppLocale("en");
    expect(listener).not.toHaveBeenCalled();
  });

  it("re-reads when another window writes the locale", async () => {
    const mod = await load();
    const listener = vi.fn();
    mod.subscribeAppLocale(listener);
    fakeWindow.localStorage.setItem(STORAGE_KEY, "en");
    fakeWindow.dispatchEvent(new FakeStorageEvent(STORAGE_KEY));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(mod.getAppLocale()).toBe("en");
  });

  it("switches the i18next runtime language when another window writes the locale", async () => {
    // 購読者への通知だけだと、この画面の `t()` は日本語のまま `useAppLocale()` だけが
    // en になる。Electron の印刷ウィンドウのように別ウィンドウが同じロケールを共有する
    // 経路で必ず起きる食い違いなので、ランタイム側も一緒に追随させる。
    const mod = await load();
    const { i18n } = await import("./i18n");
    expect(i18n.language).toBe("ja");
    fakeWindow.localStorage.setItem(STORAGE_KEY, "en");
    fakeWindow.dispatchEvent(new FakeStorageEvent(STORAGE_KEY));
    expect(mod.getAppLocale()).toBe("en");
    expect(i18n.language).toBe("en");
  });

  it("keeps the runtime in step even with no subscriber mounted", async () => {
    const mod = await load();
    const { i18n } = await import("./i18n");
    fakeWindow.localStorage.setItem(STORAGE_KEY, "en");
    fakeWindow.dispatchEvent(new FakeStorageEvent(STORAGE_KEY));
    expect(i18n.language).toBe("en");
    expect(mod.getAppLocale()).toBe("en");
  });

  it("re-reads when another window clears storage", async () => {
    fakeWindow.localStorage.setItem(STORAGE_KEY, "en");
    const mod = await load();
    expect(mod.getAppLocale()).toBe("en");
    const listener = vi.fn();
    mod.subscribeAppLocale(listener);
    fakeWindow.localStorage.clear();
    fakeWindow.dispatchEvent(new FakeStorageEvent(null));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(mod.getAppLocale()).toBe("ja");
  });

  it("ignores storage events for unrelated keys", async () => {
    const mod = await load();
    const listener = vi.fn();
    mod.subscribeAppLocale(listener);
    fakeWindow.dispatchEvent(new FakeStorageEvent("sigma-studio:ui-layout-preference"));
    expect(listener).not.toHaveBeenCalled();
  });

  it("returns a referentially stable snapshot between changes", async () => {
    const mod = await load();
    expect(mod.getAppLocale()).toBe(mod.getAppLocale());
  });

  it("always reports Japanese for the server snapshot", async () => {
    // The editor route is server-rendered by Next; the first client render has
    // to match it or React throws a hydration mismatch.
    fakeWindow.localStorage.setItem(STORAGE_KEY, "en");
    const mod = await load();
    expect(mod.getServerAppLocale()).toBe("ja");
  });

  it("does not throw when localStorage refuses the write", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await load();
    fakeWindow.localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => mod.setAppLocale("en")).not.toThrow();
    warn.mockRestore();
  });

  it("still switches for the session when localStorage refuses the write", async () => {
    // sandbox iframe / ストレージ無効の環境では書き込みが必ず throw する。ここで
    // 保存値を読み直して古い値に戻すと、言語を選んでも無反応になってしまう。
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await load();
    fakeWindow.localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    mod.setAppLocale("en");
    expect(mod.getAppLocale()).toBe("en");
    expect(fakeWindow.localStorage.getItem(STORAGE_KEY)).toBeNull();
    warn.mockRestore();
  });

  it("notifies subscribers even when the write fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await load();
    const listener = vi.fn();
    mod.subscribeAppLocale(listener);
    fakeWindow.localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    mod.setAppLocale("en");
    expect(listener).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("goes back to the persisted value once storage accepts writes again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await load();
    const originalSetItem = fakeWindow.localStorage.setItem;
    fakeWindow.localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    mod.setAppLocale("en");
    fakeWindow.localStorage.setItem = originalSetItem;
    mod.setAppLocale("ja");
    expect(fakeWindow.localStorage.getItem(STORAGE_KEY)).toBe("ja");
    expect(mod.getAppLocale()).toBe("ja");
    warn.mockRestore();
  });

  it("switches the i18next runtime language", async () => {
    const mod = await load();
    const { i18n } = await import("./i18n");
    mod.setAppLocale("en");
    expect(i18n.language).toBe("en");
    expect(i18n.t("actions.cancel")).toBe("Cancel");
  });

  it("applies the persisted locale to i18next at import time", async () => {
    // The workspace and print routes never mount EditorShell, so the boot has
    // to happen as a module side effect rather than in a provider.
    fakeWindow.localStorage.setItem(STORAGE_KEY, "en");
    await load();
    const { i18n } = await import("./i18n");
    expect(i18n.language).toBe("en");
  });

  it("leaves i18next on Japanese when nothing is stored", async () => {
    await load();
    const { i18n } = await import("./i18n");
    expect(i18n.language).toBe("ja");
  });
});
