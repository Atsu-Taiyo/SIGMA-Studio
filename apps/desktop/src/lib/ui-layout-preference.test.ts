import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "sigma-studio:ui-layout-preference";
const CHANGE_EVENT = "sigma-studio:ui-layout-preference-change";
const DEFAULT_PREFERENCE = { mode: "docs", onboardingCompleted: false, ribbonCollapsed: false };

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

// Node's test environment has no StorageEvent constructor, so the cross-tab
// event is modelled with the one field subscribe() actually inspects.
class FakeStorageEvent extends Event {
  readonly key: string | null;

  constructor(key: string | null) {
    super("storage");
    this.key = key;
  }
}

describe("ui-layout-preference", () => {
  let fakeWindow: FakeWindow;
  // Each test gets a freshly imported module so the module-level snapshot
  // cache never leaks state from one fake window into the next test's.
  let mod: typeof import("./ui-layout-preference");

  beforeEach(async () => {
    fakeWindow = new FakeWindow();
    vi.stubGlobal("window", fakeWindow);
    vi.resetModules();
    mod = await import("./ui-layout-preference");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns defaults when nothing is stored", () => {
    expect(mod.getUiLayoutPreference()).toEqual(DEFAULT_PREFERENCE);
  });

  it("returns defaults when the stored value is corrupt JSON", () => {
    fakeWindow.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(mod.getUiLayoutPreference()).toEqual(DEFAULT_PREFERENCE);
  });

  it("returns defaults when the stored value is not an object", () => {
    fakeWindow.localStorage.setItem(STORAGE_KEY, JSON.stringify("garbage"));
    expect(mod.getUiLayoutPreference()).toEqual(DEFAULT_PREFERENCE);
  });

  it("falls back per-field for a partial stored object", () => {
    fakeWindow.localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: "word" }));
    expect(mod.getUiLayoutPreference()).toEqual({ mode: "word", onboardingCompleted: false, ribbonCollapsed: false });
  });

  it("defaults an invalid mode while onboardingCompleted survives", () => {
    fakeWindow.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: "ribbon", onboardingCompleted: true }),
    );
    expect(mod.getUiLayoutPreference()).toEqual({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false });
  });

  it("defaults a non-boolean onboardingCompleted while mode survives", () => {
    fakeWindow.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: "word", onboardingCompleted: "yes" }),
    );
    expect(mod.getUiLayoutPreference()).toEqual({ mode: "word", onboardingCompleted: false, ribbonCollapsed: false });
  });

  it("round-trips a saved preference", () => {
    mod.saveUiLayoutPreference({ mode: "word", onboardingCompleted: true });
    expect(mod.getUiLayoutPreference()).toEqual({ mode: "word", onboardingCompleted: true, ribbonCollapsed: false });
  });

  it("merges a partial save on top of the previously saved preference", () => {
    mod.saveUiLayoutPreference({ mode: "word", onboardingCompleted: true });
    mod.saveUiLayoutPreference({ onboardingCompleted: false });
    expect(mod.getUiLayoutPreference()).toEqual({ mode: "word", onboardingCompleted: false, ribbonCollapsed: false });
  });

  it("dispatches the change event when saving", () => {
    const listener = vi.fn();
    fakeWindow.addEventListener(CHANGE_EVENT, listener);
    mod.saveUiLayoutPreference({ mode: "word" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not throw when localStorage refuses the write", () => {
    // Sandboxed iframes, blocked third-party storage and quota exhaustion all
    // make setItem throw. That must not escape a React onClick and tear down
    // the editor tree.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fakeWindow.localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    expect(() => mod.saveUiLayoutPreference({ mode: "word" })).not.toThrow();
    warn.mockRestore();
  });

  it("keeps the snapshot in step with storage when the write fails", () => {
    // The cache must always mirror what is actually persisted. Reporting a
    // value that never reached storage would make the next save (which merges
    // onto a fresh read) silently drop it.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fakeWindow.localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    mod.saveUiLayoutPreference({ mode: "word" });
    expect(mod.getUiLayoutPreference()).toEqual(DEFAULT_PREFERENCE);
    warn.mockRestore();
  });

  it("does not let a later save resurrect a value that never reached storage", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const workingSetItem = fakeWindow.localStorage.setItem;
    fakeWindow.localStorage.setItem = () => {
      throw new Error("QuotaExceededError");
    };
    mod.saveUiLayoutPreference({ mode: "word" });
    // Storage recovers, then an unrelated field is saved.
    fakeWindow.localStorage.setItem = workingSetItem;
    mod.saveUiLayoutPreference({ onboardingCompleted: true });
    expect(mod.getUiLayoutPreference()).toEqual({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false });
    warn.mockRestore();
  });

  it("merges a partial save onto the persisted value, not a stale cached snapshot", () => {
    // Prime this window's snapshot cache.
    expect(mod.getUiLayoutPreference()).toEqual(DEFAULT_PREFERENCE);
    // Another window writes the key. With no subscriber mounted here, no event
    // arrives and the cache goes stale; a later partial save must not write
    // that stale field back over the other window's change.
    fakeWindow.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: "docs", onboardingCompleted: true }),
    );
    mod.saveUiLayoutPreference({ mode: "word" });
    expect(JSON.parse(fakeWindow.localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual({
      mode: "word",
      onboardingCompleted: true,
      // 保存値に無かったフィールドは既定で埋めて書き戻す（読み側の per-field ガードと同じ値）。
      ribbonCollapsed: false,
    });
  });

  it("returns defaults when window is unavailable", () => {
    vi.stubGlobal("window", undefined);
    expect(mod.getUiLayoutPreference()).toEqual(DEFAULT_PREFERENCE);
    expect(() => mod.saveUiLayoutPreference({ mode: "word" })).not.toThrow();
  });

  it("returns a stable object identity across repeated reads with no change in between", () => {
    // useSyncExternalStore treats a new object identity as a signal to
    // re-render; getSnapshot must not fabricate a new object on every call.
    expect(mod.getUiLayoutPreference()).toBe(mod.getUiLayoutPreference());
  });

  it("notifies subscribers and re-reads when the change event fires", () => {
    const onStoreChange = vi.fn();
    const unsubscribe = mod.subscribeUiLayoutPreference(onStoreChange);
    mod.saveUiLayoutPreference({ mode: "word" });
    expect(onStoreChange).toHaveBeenCalledTimes(1);
    expect(mod.getUiLayoutPreference().mode).toBe("word");
    unsubscribe();
  });

  it("invalidates the snapshot when the change event arrives from another writer", () => {
    // saveUiLayoutPreference clears the cache before dispatching, so this only bites when a
    // second writer dispatches the event on its own — a separate copy of the module (SDK
    // bundle) or a future onboarding screen.
    const onStoreChange = vi.fn();
    const unsubscribe = mod.subscribeUiLayoutPreference(onStoreChange);
    expect(mod.getUiLayoutPreference().mode).toBe("docs");
    fakeWindow.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: "word", onboardingCompleted: true }),
    );
    fakeWindow.dispatchEvent(new CustomEvent(CHANGE_EVENT));
    expect(onStoreChange).toHaveBeenCalledTimes(1);
    expect(mod.getUiLayoutPreference()).toEqual({ mode: "word", onboardingCompleted: true, ribbonCollapsed: false });
    unsubscribe();
  });

  it("invalidates the snapshot on a storage event for this key", () => {
    const onStoreChange = vi.fn();
    const unsubscribe = mod.subscribeUiLayoutPreference(onStoreChange);
    expect(mod.getUiLayoutPreference().mode).toBe("docs");
    // Another tab wrote the key directly; no CustomEvent reaches this window.
    fakeWindow.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ mode: "word", onboardingCompleted: true }),
    );
    fakeWindow.dispatchEvent(new FakeStorageEvent(STORAGE_KEY));
    expect(onStoreChange).toHaveBeenCalledTimes(1);
    expect(mod.getUiLayoutPreference()).toEqual({ mode: "word", onboardingCompleted: true, ribbonCollapsed: false });
    unsubscribe();
  });

  it("invalidates the snapshot on a storage event with a null key (clear)", () => {
    const onStoreChange = vi.fn();
    const unsubscribe = mod.subscribeUiLayoutPreference(onStoreChange);
    mod.saveUiLayoutPreference({ mode: "word", onboardingCompleted: true });
    fakeWindow.localStorage.clear();
    fakeWindow.dispatchEvent(new FakeStorageEvent(null));
    expect(mod.getUiLayoutPreference()).toEqual(DEFAULT_PREFERENCE);
    unsubscribe();
  });

  it("ignores storage events for unrelated keys", () => {
    const onStoreChange = vi.fn();
    const unsubscribe = mod.subscribeUiLayoutPreference(onStoreChange);
    fakeWindow.dispatchEvent(new FakeStorageEvent("sigma-studio:some-other-preference"));
    expect(onStoreChange).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("stops notifying after unsubscribe", () => {
    const onStoreChange = vi.fn();
    const unsubscribe = mod.subscribeUiLayoutPreference(onStoreChange);
    unsubscribe();
    mod.saveUiLayoutPreference({ mode: "word" });
    expect(onStoreChange).not.toHaveBeenCalled();
  });

  it("returns a no-op unsubscribe when window is unavailable", () => {
    vi.stubGlobal("window", undefined);
    const unsubscribe = mod.subscribeUiLayoutPreference(vi.fn());
    expect(() => unsubscribe()).not.toThrow();
  });

  describe("ribbonCollapsed", () => {
    it("既定は展開 (false)", () => {
      expect(mod.getUiLayoutPreference().ribbonCollapsed).toBe(false);
    });

    it("保存値に ribbonCollapsed が無くても他のフィールドは生き残る", () => {
      window.localStorage.setItem(
        "sigma-studio:ui-layout-preference",
        JSON.stringify({ mode: "word", onboardingCompleted: true }),
      );
      expect(mod.getUiLayoutPreference()).toEqual({
        mode: "word",
        onboardingCompleted: true,
        ribbonCollapsed: false,
      });
    });

    it("不正な ribbonCollapsed は既定に落ち、他のフィールドは生き残る", () => {
      window.localStorage.setItem(
        "sigma-studio:ui-layout-preference",
        JSON.stringify({ mode: "word", onboardingCompleted: true, ribbonCollapsed: "yes" }),
      );
      expect(mod.getUiLayoutPreference()).toEqual({
        mode: "word",
        onboardingCompleted: true,
        ribbonCollapsed: false,
      });
    });

    it("ribbonCollapsed の部分保存が mode を壊さない", () => {
      window.localStorage.setItem(
        "sigma-studio:ui-layout-preference",
        JSON.stringify({ mode: "word", onboardingCompleted: true }),
      );
      mod.saveUiLayoutPreference({ ribbonCollapsed: true });
      expect(mod.getUiLayoutPreference()).toEqual({
        mode: "word",
        onboardingCompleted: true,
        ribbonCollapsed: true,
      });
    });
  });

  describe("shouldShowUiLayoutOnboarding", () => {
    const READY = {
      onboardingCompleted: false,
      isDesktopApp: true,
      isEmbedded: false,
      appReady: true,
    };

    it("shows the onboarding only when every condition is met", () => {
      expect(mod.shouldShowUiLayoutOnboarding(READY)).toBe(true);
    });

    it("hides the onboarding once it has been completed", () => {
      expect(mod.shouldShowUiLayoutOnboarding({ ...READY, onboardingCompleted: true })).toBe(false);
    });

    it("hides the onboarding outside the desktop app", () => {
      expect(mod.shouldShowUiLayoutOnboarding({ ...READY, isDesktopApp: false })).toBe(false);
    });

    it("hides the onboarding when embedded in a host", () => {
      expect(mod.shouldShowUiLayoutOnboarding({ ...READY, isEmbedded: true })).toBe(false);
    });

    it("hides the onboarding until the app reports it is ready", () => {
      expect(mod.shouldShowUiLayoutOnboarding({ ...READY, appReady: false })).toBe(false);
    });
  });
});
