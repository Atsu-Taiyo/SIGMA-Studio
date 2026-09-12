import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "sigma-studio:workspace-view-preference";
const DEFAULT_PREFERENCE = { mode: "grid", sortKey: "updatedAt", sortDirection: "desc" };

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

describe("workspace-view-preferences", () => {
  let fakeWindow: FakeWindow;
  // Each test gets a freshly imported module so the module-level snapshot
  // cache never leaks state from one fake window into the next test's.
  let mod: typeof import("./workspace-view-preferences");

  beforeEach(async () => {
    fakeWindow = new FakeWindow();
    vi.stubGlobal("window", fakeWindow);
    vi.resetModules();
    mod = await import("./workspace-view-preferences");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns defaults when nothing is stored", () => {
    expect(mod.getWorkspaceViewPreference()).toEqual(DEFAULT_PREFERENCE);
  });

  it("returns defaults when the stored value is corrupt JSON", () => {
    fakeWindow.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(mod.getWorkspaceViewPreference()).toEqual(DEFAULT_PREFERENCE);
  });

  it("falls back per-field for a partial stored object", () => {
    fakeWindow.localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: "list" }));
    expect(mod.getWorkspaceViewPreference()).toEqual({
      mode: "list",
      sortKey: "updatedAt",
      sortDirection: "desc",
    });
  });

  it("defaults an invalid mode while the other fields survive", () => {
    fakeWindow.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      mode: "kanban",
      sortKey: "name",
      sortDirection: "asc",
    }));
    expect(mod.getWorkspaceViewPreference()).toEqual({
      mode: "grid",
      sortKey: "name",
      sortDirection: "asc",
    });
  });

  it("defaults an invalid sortKey while the other fields survive", () => {
    fakeWindow.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      mode: "list",
      sortKey: "size",
      sortDirection: "asc",
    }));
    expect(mod.getWorkspaceViewPreference()).toEqual({
      mode: "list",
      sortKey: "updatedAt",
      sortDirection: "asc",
    });
  });

  it("defaults an invalid sortDirection while the other fields survive", () => {
    fakeWindow.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      mode: "list",
      sortKey: "name",
      sortDirection: "sideways",
    }));
    expect(mod.getWorkspaceViewPreference()).toEqual({
      mode: "list",
      sortKey: "name",
      sortDirection: "desc",
    });
  });

  it("round-trips a saved preference", () => {
    mod.saveWorkspaceViewPreference({ mode: "list", sortKey: "name", sortDirection: "asc" });
    expect(mod.getWorkspaceViewPreference()).toEqual({
      mode: "list",
      sortKey: "name",
      sortDirection: "asc",
    });
  });

  it("merges a partial save on top of the previously saved preference", () => {
    mod.saveWorkspaceViewPreference({ mode: "list" });
    mod.saveWorkspaceViewPreference({ sortKey: "name" });
    expect(mod.getWorkspaceViewPreference()).toEqual({
      mode: "list",
      sortKey: "name",
      sortDirection: "desc",
    });
  });

  it("returns defaults when window is unavailable", () => {
    vi.stubGlobal("window", undefined);
    expect(mod.getWorkspaceViewPreference()).toEqual(DEFAULT_PREFERENCE);
    expect(() => mod.saveWorkspaceViewPreference({ mode: "list" })).not.toThrow();
  });

  it("dispatches the change event when saving", () => {
    const listener = vi.fn();
    fakeWindow.addEventListener("sigma-studio:workspace-view-preference-change", listener);
    mod.saveWorkspaceViewPreference({ mode: "list" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  // The cross-tab "storage" event listener is wired up inside subscribe(),
  // which useSyncExternalStore only calls while a component using
  // useWorkspaceViewPreference is mounted. Hooks can't be exercised in this
  // node-environment test suite (no @testing-library/react), so that wiring
  // is left to manual/e2e verification rather than a unit test here.

  it("returns a stable object identity across repeated reads with no change in between", () => {
    // useSyncExternalStore treats a new object identity as a signal to
    // re-render; getSnapshot must not fabricate a new object on every call.
    expect(mod.getWorkspaceViewPreference()).toBe(mod.getWorkspaceViewPreference());
  });
});
