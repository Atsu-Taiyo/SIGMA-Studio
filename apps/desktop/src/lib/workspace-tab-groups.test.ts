import { describe, expect, it } from "vitest";

import {
  aiWorkspaceTab,
  closeWorkspaceTabInLayout,
  createSingleGroupWorkspaceLayout,
  documentWorkspaceTab,
  focusWorkspaceTab,
  moveWorkspaceTab,
  normalizeWorkspaceLayout,
  reconcileWorkspaceLayoutDocuments,
  splitWorkspaceGroupWithTab,
  updateWorkspaceSplitRatio,
  workspaceLayoutOpenFileIds,
} from "./workspace-tab-groups";

describe("workspace tab groups", () => {
  it("migrates legacy tabs into one group", () => {
    const layout = createSingleGroupWorkspaceLayout(["a", "b"], "b");
    expect(layout.groups[0].tabs).toEqual([documentWorkspaceTab("a"), documentWorkspaceTab("b")]);
    expect(layout.groups[0].activeTabId).toBe("document:b");
    expect(layout.lastDocumentFileId).toBe("b");
  });

  it("moves a tab and removes an empty source group", () => {
    let layout = createSingleGroupWorkspaceLayout(["a", "b"], "a");
    layout = splitWorkspaceGroupWithTab(layout, "document:b", "group-1", "right", "group-2", "split-1");
    layout = moveWorkspaceTab(layout, "document:b", "group-1");
    expect(layout.groups).toHaveLength(1);
    expect(layout.groups[0].tabs.map((tab) => tab.id)).toEqual(["document:a", "document:b"]);
    expect(layout.root).toEqual({ kind: "group", groupId: "group-1" });
  });

  it("builds mixed vertical and horizontal splits and caps the fourth group", () => {
    let layout = createSingleGroupWorkspaceLayout(["a", "b", "c", "d"], "a");
    layout = splitWorkspaceGroupWithTab(layout, "document:b", "group-1", "right", "group-2", "split-1");
    layout = splitWorkspaceGroupWithTab(layout, "document:c", "group-2", "bottom", "group-3", "split-2");
    const capped = splitWorkspaceGroupWithTab(layout, "document:d", "group-1", "left", "group-4", "split-3");
    expect(layout.groups).toHaveLength(3);
    expect(layout.root).toMatchObject({ kind: "split", direction: "row", second: { kind: "split", direction: "column" } });
    expect(capped).toBe(layout);
  });

  it("does not split a pane by moving its only tab into a replacement pane", () => {
    const layout = createSingleGroupWorkspaceLayout(["a"], "a");
    expect(splitWorkspaceGroupWithTab(layout, "document:a", "group-1", "right", "group-2", "split-1"))
      .toBe(layout);
  });

  it("closes an empty group but retains the final group", () => {
    let layout = createSingleGroupWorkspaceLayout(["a", "b"], "a");
    layout = splitWorkspaceGroupWithTab(layout, "document:b", "group-1", "right", "group-2", "split-1");
    layout = closeWorkspaceTabInLayout(layout, "document:b");
    expect(layout.groups).toHaveLength(1);
    expect(closeWorkspaceTabInLayout(layout, "document:a")).toBe(layout);
  });

  it("keeps the menu target when focusing AI and clamps divider ratios", () => {
    const base = createSingleGroupWorkspaceLayout(["a"], "a");
    const withAi = {
      ...base,
      groups: [{ ...base.groups[0], tabs: [...base.groups[0].tabs, aiWorkspaceTab("room", "a")] }],
    };
    const focused = focusWorkspaceTab(withAi, "group-1", "ai:room");
    expect(focused.lastDocumentFileId).toBe("a");
    const split = splitWorkspaceGroupWithTab(focused, "ai:room", "group-1", "right", "group-2", "split-1");
    expect(updateWorkspaceSplitRatio(split, "split-1", 0.99).root).toMatchObject({ ratio: 0.8 });
  });

  it("repairs invalid files, rooms, duplicate tabs, and active selections", () => {
    const base = createSingleGroupWorkspaceLayout(["a", "b"], "a");
    const candidate = splitWorkspaceGroupWithTab(base, "document:b", "group-1", "right", "group-2", "split-1");
    candidate.groups[0].tabs.push(aiWorkspaceTab("missing-room", "a"), documentWorkspaceTab("missing-file"));
    candidate.groups[0].activeTabId = "ai:missing-room";
    const normalized = normalizeWorkspaceLayout(candidate, ["a", "b"], "a", new Set(["a", "b"]), new Set());
    expect(normalized.groups[0].tabs.map((tab) => tab.id)).toEqual(["document:a"]);
    expect(normalized.groups[0].activeTabId).toBe("document:a");
    expect(workspaceLayoutOpenFileIds(normalized)).toEqual(["a", "b"]);
  });

  it("reconciles legacy open tab writes without losing split placement", () => {
    let layout = createSingleGroupWorkspaceLayout(["a", "b"], "a");
    layout = splitWorkspaceGroupWithTab(layout, "document:b", "group-1", "right", "group-2", "split-1");
    const reconciled = reconcileWorkspaceLayoutDocuments(layout, ["b", "c"], "c");
    expect(reconciled.groups).toHaveLength(1);
    expect(reconciled.groups[0].tabs.map((tab) => tab.id)).toEqual(["document:b", "document:c"]);
    expect(reconciled.lastDocumentFileId).toBe("c");
  });
});
