import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "sigma-studio:workspace-view-preference";
const DEFAULT_PREFERENCE = { sortKey: "updatedAt", sortDirection: "desc", sidebarCollapsed: false };

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
    fakeWindow.localStorage.setItem(STORAGE_KEY, JSON.stringify({ sortKey: "name" }));
    expect(mod.getWorkspaceViewPreference()).toEqual({
      sortKey: "name",
      sortDirection: "desc",
      sidebarCollapsed: false,
    });
  });

  it("ignores the retired grid/list mode and drops it on the next save", () => {
    fakeWindow.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      mode: "grid",
      sortKey: "name",
      sortDirection: "asc",
      sidebarCollapsed: true,
    }));
    expect(mod.getWorkspaceViewPreference()).toEqual({
      sortKey: "name",
      sortDirection: "asc",
      sidebarCollapsed: true,
    });
    mod.saveWorkspaceViewPreference({ sortDirection: "desc" });
    expect(JSON.parse(fakeWindow.localStorage.getItem(STORAGE_KEY) as string)).toEqual({
      sortKey: "name",
      sortDirection: "desc",
      sidebarCollapsed: true,
    });
  });

  it("defaults an invalid sortKey while the other fields survive", () => {
    fakeWindow.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sortKey: "size",
      sortDirection: "asc",
    }));
    expect(mod.getWorkspaceViewPreference()).toEqual({
      sortKey: "updatedAt",
      sortDirection: "asc",
      sidebarCollapsed: false,
    });
  });

  it("defaults an invalid sortDirection while the other fields survive", () => {
    fakeWindow.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      sortKey: "name",
      sortDirection: "sideways",
    }));
    expect(mod.getWorkspaceViewPreference()).toEqual({
      sortKey: "name",
      sortDirection: "desc",
      sidebarCollapsed: false,
    });
  });

  it("round-trips a saved preference", () => {
    mod.saveWorkspaceViewPreference({ sortKey: "name", sortDirection: "asc" });
    expect(mod.getWorkspaceViewPreference()).toEqual({
      sortKey: "name",
      sortDirection: "asc",
      sidebarCollapsed: false,
    });
  });

  it("merges a partial save on top of the previously saved preference", () => {
    mod.saveWorkspaceViewPreference({ sortDirection: "asc" });
    mod.saveWorkspaceViewPreference({ sortKey: "name" });
    expect(mod.getWorkspaceViewPreference()).toEqual({
      sortKey: "name",
      sortDirection: "asc",
      sidebarCollapsed: false,
    });
  });

  it("keeps the sidebar state when other fields are saved", () => {
    mod.saveWorkspaceViewPreference({ sidebarCollapsed: true });
    mod.saveWorkspaceViewPreference({ sortKey: "name" });
    expect(mod.getWorkspaceViewPreference().sidebarCollapsed).toBe(true);
  });

  it("defaults a non-boolean sidebar state", () => {
    fakeWindow.localStorage.setItem(STORAGE_KEY, JSON.stringify({ sortKey: "name", sidebarCollapsed: "yes" }));
    expect(mod.getWorkspaceViewPreference()).toEqual({ ...DEFAULT_PREFERENCE, sortKey: "name" });
  });

  it("returns defaults when window is unavailable", () => {
    vi.stubGlobal("window", undefined);
    expect(mod.getWorkspaceViewPreference()).toEqual(DEFAULT_PREFERENCE);
    expect(() => mod.saveWorkspaceViewPreference({ sortKey: "name" })).not.toThrow();
  });

  it("dispatches the change event when saving", () => {
    const listener = vi.fn();
    fakeWindow.addEventListener("sigma-studio:workspace-view-preference-change", listener);
    mod.saveWorkspaceViewPreference({ sortKey: "name" });
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
