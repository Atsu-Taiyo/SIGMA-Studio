import { describe, expect, it } from "vitest";

import {
  cancelRunningTurns,
  closeSurface,
  isInlineToggleShortcut,
  openInline,
  promoteToSidebar,
  resolveAiSurface,
  toggleSurface,
  type AiSurfaceState,
} from "@/lib/ai/ai-surface";

function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "k",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("resolveAiSurface", () => {
  it("does not add the workspace AI column while the inline editor is shown", () => {
    const surface = resolveAiSurface({
      displayMode: "inline",
      aiSidebarOpen: false,
      aiInlineOpen: true,
    });
    expect(surface.gridHasAiColumn).toBe(false);
    expect(surface.hostVisible).toBe(true);
    expect(surface.hostClassName).toBe("ai-chat-host--inline");
    expect(surface.catcherVisible).toBe(true);
  });

  it("adds the workspace AI column only when promoted to the sidebar", () => {
    const surface = resolveAiSurface({
      displayMode: "sidebar",
      aiSidebarOpen: true,
      aiInlineOpen: false,
    });
    expect(surface.gridHasAiColumn).toBe(true);
    expect(surface.hostVisible).toBe(true);
    expect(surface.hostClassName).toBe("ai-chat-host--sidebar");
    expect(surface.catcherVisible).toBe(false);
  });

  it("hides the host when neither inline nor sidebar is open", () => {
    const surface = resolveAiSurface({
      displayMode: "inline",
      aiSidebarOpen: false,
      aiInlineOpen: false,
    });
    expect(surface.hostVisible).toBe(false);
    expect(surface.gridHasAiColumn).toBe(false);
    expect(surface.catcherVisible).toBe(false);
  });
});

describe("surface transitions", () => {
  const closed: AiSurfaceState = {
    displayMode: "inline",
    aiSidebarOpen: false,
    aiInlineOpen: false,
  };

  it("openInline shows the inline editor without opening the sidebar column", () => {
    expect(openInline()).toEqual({
      displayMode: "inline",
      aiSidebarOpen: false,
      aiInlineOpen: true,
    });
  });

  it("toggleSurface opens the inline editor then closes it again", () => {
    const opened = toggleSurface(closed);
    expect(opened.aiInlineOpen).toBe(true);
    const reclosed = toggleSurface(opened);
    expect(reclosed.aiInlineOpen).toBe(false);
    expect(reclosed.aiSidebarOpen).toBe(false);
  });

  it("toggleSurface closes an open sidebar instead of reopening the inline editor", () => {
    const next = toggleSurface({
      displayMode: "sidebar",
      aiSidebarOpen: true,
      aiInlineOpen: false,
    });
    expect(next).toEqual({
      displayMode: "inline",
      aiSidebarOpen: false,
      aiInlineOpen: false,
    });
  });

  it("closeSurface hides both inline editor and sidebar", () => {
    expect(closeSurface()).toEqual({
      displayMode: "inline",
      aiSidebarOpen: false,
      aiInlineOpen: false,
    });
  });

  it("promoteToSidebar moves to the sidebar and closes the inline editor", () => {
    expect(promoteToSidebar()).toEqual({
      displayMode: "sidebar",
      aiSidebarOpen: true,
      aiInlineOpen: false,
    });
  });
});

describe("isInlineToggleShortcut", () => {
  it("matches Cmd/Ctrl+K", () => {
    expect(isInlineToggleShortcut(keyEvent({ key: "k", metaKey: true }))).toBe(true);
    expect(isInlineToggleShortcut(keyEvent({ key: "K", ctrlKey: true }))).toBe(true);
  });

  it("ignores plain k and modifier-laden combos", () => {
    expect(isInlineToggleShortcut(keyEvent({ key: "k" }))).toBe(false);
    expect(isInlineToggleShortcut(keyEvent({ key: "k", metaKey: true, shiftKey: true }))).toBe(false);
    expect(isInlineToggleShortcut(keyEvent({ key: "k", metaKey: true, altKey: true }))).toBe(false);
    expect(isInlineToggleShortcut(keyEvent({ key: "j", metaKey: true }))).toBe(false);
  });

  it("ignores keystrokes mid IME composition", () => {
    expect(isInlineToggleShortcut(keyEvent({ key: "k", metaKey: true, isComposing: true }))).toBe(false);
  });
});

describe("cancelRunningTurns", () => {
  it("closes running assistant turns and leaves others untouched", () => {
    const turns = [
      { id: "u1", role: "user" as const },
      { id: "a1", role: "assistant" as const, isRunning: true, endedAt: null, error: null },
      { id: "a2", role: "assistant" as const, isRunning: false, endedAt: 10, error: null },
    ];
    const next = cancelRunningTurns(turns, 1234, "中止しました");
    expect(next[0]).toBe(turns[0]);
    expect(next[1]).toMatchObject({ isRunning: false, endedAt: 1234, error: "中止しました" });
    expect(next[2]).toBe(turns[2]);
  });

  it("returns the same array reference when nothing is running", () => {
    const turns = [{ id: "a1", role: "assistant" as const, isRunning: false }];
    expect(cancelRunningTurns(turns, 1, "x")).toBe(turns);
  });
});
