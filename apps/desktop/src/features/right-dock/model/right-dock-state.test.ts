import { describe, expect, it } from "vitest";

import { readRightDockPreference, saveRightDockPreference } from "./right-dock-preference";
import {
  activateRightDockPage,
  activeRightDockPage,
  clampRightDockWidth,
  closeRightDock,
  closeRightDockPage,
  closeRightDockToolIfShowing,
  INITIAL_RIGHT_DOCK_STATE,
  isRightDockShowing,
  neighborRightDockPageId,
  openRightDock,
  openRightDockHub,
  openRightDockPage,
  openRightDockTool,
  RIGHT_DOCK_DEFAULT_WIDTH,
  RIGHT_DOCK_MAX_WIDTH,
  RIGHT_DOCK_MIN_WIDTH,
  syncRightDockBrowserPages,
  toggleRightDock,
  type RightDockState,
} from "./right-dock-state";

const ids = (state: RightDockState) => state.pages.map((page) => page.id);
const browser = (id: string) => ({ id, kind: "browser" as const });

describe("right dock pages", () => {
  it("starts closed with no pages, and opening it shows the hub", () => {
    expect(INITIAL_RIGHT_DOCK_STATE).toEqual({ open: false, pages: [], activeId: null });
    const opened = openRightDock(INITIAL_RIGHT_DOCK_STATE);
    expect(opened.open).toBe(true);
    expect(ids(opened)).toEqual(["hub"]);
    expect(opened.activeId).toBe("hub");
  });

  it("remembers what was open while the dock is closed and comes back to it", () => {
    const files = openRightDockTool(openRightDock(INITIAL_RIGHT_DOCK_STATE), "files");
    const closed = closeRightDock(files);
    expect(closed.open).toBe(false);
    expect(ids(closed)).toEqual(["files"]);
    expect(toggleRightDock(closed)).toEqual(files);
  });

  it("returns the same object when nothing changes so React can bail out", () => {
    const open = openRightDock(INITIAL_RIGHT_DOCK_STATE);
    expect(openRightDock(open)).toBe(open);
    expect(openRightDockHub(open)).toBe(open);
    expect(closeRightDock(INITIAL_RIGHT_DOCK_STATE)).toBe(INITIAL_RIGHT_DOCK_STATE);
    expect(closeRightDockToolIfShowing(open, "files")).toBe(open);
    expect(activateRightDockPage(open, "missing")).toBe(open);
  });

  it("replaces the hub with the tool that was chosen from it", () => {
    const hub = openRightDock(INITIAL_RIGHT_DOCK_STATE);
    const files = openRightDockTool(hub, "files");
    expect(ids(files)).toEqual(["files"]);
    expect(files.activeId).toBe("files");
  });

  it("appends a tool when another page is being viewed, and moves to it if it is already open", () => {
    let state = openRightDockTool(openRightDock(INITIAL_RIGHT_DOCK_STATE), "files");
    state = openRightDockTool(state, "chat");
    expect(ids(state)).toEqual(["files", "chat"]);
    expect(openRightDockTool(state, "files").activeId).toBe("files");
    expect(ids(openRightDockTool(state, "files"))).toEqual(["files", "chat"]);
  });

  it("opens one hub at a time with the plus button", () => {
    const files = openRightDockTool(openRightDock(INITIAL_RIGHT_DOCK_STATE), "files");
    const withHub = openRightDockHub(files);
    expect(ids(withHub)).toEqual(["files", "hub"]);
    expect(withHub.activeId).toBe("hub");
    const backToFiles = activateRightDockPage(withHub, "files");
    const again = openRightDockHub(backToFiles);
    expect(ids(again)).toEqual(["files", "hub"]);
    expect(again.activeId).toBe("hub");
  });

  it("drops the hub when the chosen page was already open elsewhere", () => {
    const state = openRightDockHub(openRightDockTool(openRightDock(INITIAL_RIGHT_DOCK_STATE), "files"));
    expect(ids(openRightDockTool(state, "files"))).toEqual(["files"]);
    expect(openRightDockTool(state, "files").activeId).toBe("files");
  });

  it("moves to the right neighbour, then the left, when the viewed page closes", () => {
    let state = openRightDockTool(openRightDock(INITIAL_RIGHT_DOCK_STATE), "files");
    state = openRightDockPage(state, browser("b1"));
    state = openRightDockTool(state, "chat");
    expect(ids(state)).toEqual(["files", "b1", "chat"]);
    expect(closeRightDockPage(activateRightDockPage(state, "b1"), "b1").activeId).toBe("chat");
    expect(closeRightDockPage(state, "chat").activeId).toBe("b1");
    expect(closeRightDockPage(activateRightDockPage(state, "files"), "chat").activeId).toBe("files");
  });

  it("closes the whole dock when the last page closes", () => {
    const files = openRightDockTool(openRightDock(INITIAL_RIGHT_DOCK_STATE), "files");
    expect(closeRightDockPage(files, "files")).toEqual(INITIAL_RIGHT_DOCK_STATE);
  });

  it("closes the side chat only when the AI surface asks while it is showing", () => {
    const chat = openRightDockTool(openRightDockTool(openRightDock(INITIAL_RIGHT_DOCK_STATE), "files"), "chat");
    expect(isRightDockShowing(chat, "chat")).toBe(true);
    expect(isRightDockShowing(closeRightDock(chat), "chat")).toBe(false);
    const closed = closeRightDockToolIfShowing(chat, "chat");
    expect(ids(closed)).toEqual(["files"]);
    expect(closed.open).toBe(true);
    const viewingFiles = activateRightDockPage(chat, "files");
    expect(closeRightDockToolIfShowing(viewingFiles, "chat")).toBe(viewingFiles);
  });

  it("cycles through pages in both directions", () => {
    const state = openRightDockTool(openRightDockTool(openRightDock(INITIAL_RIGHT_DOCK_STATE), "files"), "chat");
    expect(neighborRightDockPageId(state, "files", 1)).toBe("chat");
    expect(neighborRightDockPageId(state, "chat", 1)).toBe("files");
    expect(neighborRightDockPageId(state, "files", -1)).toBe("chat");
    expect(neighborRightDockPageId(state, "missing", 1)).toBeNull();
  });
});

describe("browser page sync", () => {
  const withFilesAndBrowser = () => openRightDockPage(openRightDockTool(openRightDock(INITIAL_RIGHT_DOCK_STATE), "files"), browser("a"));

  it("adopts a tab the user just asked for into the hub's place", () => {
    const hub = openRightDock(INITIAL_RIGHT_DOCK_STATE);
    const next = syncRightDockBrowserPages(hub, { tabIds: ["a"], activeTabId: "a" }, { adopt: true });
    expect(ids(next)).toEqual(["a"]);
    expect(next.activeId).toBe("a");
  });

  it("appends a new tab and follows it only while a browser page is being viewed", () => {
    const viewingBrowser = withFilesAndBrowser();
    const followed = syncRightDockBrowserPages(viewingBrowser, { tabIds: ["a", "b"], activeTabId: "b" });
    expect(ids(followed)).toEqual(["files", "a", "b"]);
    expect(followed.activeId).toBe("b");

    const viewingFiles = activateRightDockPage(viewingBrowser, "files");
    const stayed = syncRightDockBrowserPages(viewingFiles, { tabIds: ["a", "b"], activeTabId: "b" });
    expect(ids(stayed)).toEqual(["files", "a", "b"]);
    expect(stayed.activeId).toBe("files");
  });

  it("does not follow a tab opened in the background", () => {
    const state = withFilesAndBrowser();
    expect(syncRightDockBrowserPages(state, { tabIds: ["a", "b"], activeTabId: "a" }).activeId).toBe("a");
  });

  it("drops pages whose tab is gone and moves to a neighbour", () => {
    const state = syncRightDockBrowserPages(withFilesAndBrowser(), { tabIds: ["a", "b"], activeTabId: "b" });
    const gone = syncRightDockBrowserPages(state, { tabIds: ["a"], activeTabId: "a" });
    expect(ids(gone)).toEqual(["files", "a"]);
    expect(gone.activeId).toBe("a");
  });

  it("closes the dock when the last page was a tab that went away", () => {
    const onlyBrowser = openRightDockPage(openRightDock(INITIAL_RIGHT_DOCK_STATE), browser("a"));
    expect(syncRightDockBrowserPages(onlyBrowser, { tabIds: [], activeTabId: null })).toEqual(INITIAL_RIGHT_DOCK_STATE);
  });

  it("restores tabs that outlive a renderer reload without opening the dock", () => {
    const next = syncRightDockBrowserPages(INITIAL_RIGHT_DOCK_STATE, { tabIds: ["a", "b"], activeTabId: "b" });
    expect(next.open).toBe(false);
    expect(ids(next)).toEqual(["a", "b"]);
    expect(activeRightDockPage(next)?.id).toBe("b");
  });

  it("keeps the same object when the tabs already match", () => {
    const state = withFilesAndBrowser();
    expect(syncRightDockBrowserPages(state, { tabIds: ["a"], activeTabId: "a" })).toBe(state);
  });
});

describe("right dock width", () => {
  it("keeps the width usable and never lets the dock swallow the document", () => {
    expect(clampRightDockWidth(100, 1600)).toBe(RIGHT_DOCK_MIN_WIDTH);
    expect(clampRightDockWidth(5000, 4000)).toBe(RIGHT_DOCK_MAX_WIDTH);
    expect(clampRightDockWidth(700, 1000)).toBe(600);
    expect(clampRightDockWidth(Number.NaN, 1600)).toBe(RIGHT_DOCK_DEFAULT_WIDTH);
    expect(clampRightDockWidth(500, 400)).toBe(RIGHT_DOCK_MIN_WIDTH);
  });
});

describe("right dock preference", () => {
  const memory = (initial?: string) => {
    let value = initial ?? null;
    return { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
  };

  it("round-trips the width", () => {
    const storage = memory();
    saveRightDockPreference({ width: 480 }, storage);
    expect(readRightDockPreference(storage)).toEqual({ width: 480 });
  });

  it("ignores the last-viewed tab that older versions saved, and falls back on bad values", () => {
    expect(readRightDockPreference(memory(JSON.stringify({ tab: "browser", width: 500 })))).toEqual({ width: 500 });
    expect(readRightDockPreference(memory(JSON.stringify({ width: "wide" })))).toEqual({ width: RIGHT_DOCK_DEFAULT_WIDTH });
    expect(readRightDockPreference(memory("{broken"))).toEqual({ width: RIGHT_DOCK_DEFAULT_WIDTH });
    expect(readRightDockPreference(null)).toEqual({ width: RIGHT_DOCK_DEFAULT_WIDTH });
  });
});
