// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";

import { readEditorOpenFileIds, readWorkspaceReturnLocation, rememberEditorOpenFileIds, rememberWorkspaceReturnLocation, workspaceReturnSearch } from "./workspace-return-location";

describe("workspace return location", () => {
  beforeEach(() => { window.sessionStorage.clear(); });

  it("does not pick a workspace before the workspace screen has shown one", () => {
    expect(readWorkspaceReturnLocation()).toBeNull();
    expect(workspaceReturnSearch()).toBeUndefined();
  });

  it("returns to the workspace and folder that were last shown", () => {
    rememberWorkspaceReturnLocation({ workspaceId: "ws-b", folderId: "folder-1" });
    expect(workspaceReturnSearch()).toEqual({ workspaceId: "ws-b", folderId: "folder-1" });
    rememberWorkspaceReturnLocation({ workspaceId: "ws-c", folderId: null });
    expect(workspaceReturnSearch()).toEqual({ workspaceId: "ws-c" });
  });

  it("ignores a malformed stored value", () => {
    window.sessionStorage.setItem("sigma-studio:workspace-return-location", "{\"workspaceId\":3}");
    expect(readWorkspaceReturnLocation()).toBeNull();
  });

  it("distinguishes an editor that was never opened from one whose tabs were all closed", () => {
    expect(readEditorOpenFileIds()).toBeNull();
    rememberEditorOpenFileIds(["a", "b"]);
    expect(readEditorOpenFileIds()).toEqual(["a", "b"]);
    rememberEditorOpenFileIds([]);
    expect(readEditorOpenFileIds()).toEqual([]);
  });
});
