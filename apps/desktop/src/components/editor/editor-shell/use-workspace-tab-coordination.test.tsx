// @vitest-environment happy-dom
import { createSingleGroupWorkspaceLayout, reconcileWorkspaceLayoutDocuments } from "@/lib/workspace-tab-groups";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentTabOpenOptions } from "./document-tab-commands";
import { useWorkspaceTabCoordination } from "./use-workspace-tab-coordination";

vi.mock("@/lib/storage", () => ({ saveWorkspaceState: vi.fn(async () => ({ ok: true })) }));
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
});
afterEach(() => act(() => root.unmount()));

describe("workspace layout owner", () => {
  it("retains a split during immediate document-open reconciliation before React renders", async () => {
    let owner!: ReturnType<typeof useWorkspaceTabCoordination>;
    const open = vi.fn(async (fileId: string, options?: DocumentTabOpenOptions) => {
      options?.onOpened?.();
      // The document navigation owner persists immediately after onOpened; this
      // must read the tab owner's current layout, rather than a render mirror.
      owner.setWorkspaceLayout(reconcileWorkspaceLayoutDocuments(owner.getWorkspaceLayout(), options?.nextOpenFileIds ?? [], fileId));
    });
    function Probe() {
      owner = useWorkspaceTabCoordination({ initialDocumentId: "one", getActiveFileId: () => "one", setOpenFileIds: vi.fn(), openDocumentInWorkspace: open, closeDocumentTab: vi.fn(async () => {}), rememberPaneHandoff: vi.fn() });
      return null;
    }
    act(() => root.render(<Probe />));
    act(() => owner.setWorkspaceLayout(createSingleGroupWorkspaceLayout(["one", "two"], "one")));
    await act(async () => owner.splitWorkspaceGroupTab("document:two", "group-1", "right"));
    expect(open).toHaveBeenCalledOnce();
    expect(owner.getWorkspaceLayout().groups).toHaveLength(2);
    expect(owner.workspaceLayout.groups).toHaveLength(2);
    expect(owner.workspaceLayout.lastDocumentFileId).toBe("two");
  });
  it("keeps the original pane layout when the save boundary refuses opening", async () => {
    let owner!: ReturnType<typeof useWorkspaceTabCoordination>;
    function Probe() {
      owner = useWorkspaceTabCoordination({ initialDocumentId: "one", getActiveFileId: () => "one", setOpenFileIds: vi.fn(), openDocumentInWorkspace: vi.fn(async () => {}), closeDocumentTab: vi.fn(async () => {}), rememberPaneHandoff: vi.fn() });
      return null;
    }
    act(() => root.render(<Probe />));
    act(() => owner.setWorkspaceLayout(createSingleGroupWorkspaceLayout(["one", "two"], "one")));
    await act(async () => owner.splitWorkspaceGroupTab("document:two", "group-1", "right"));
    expect(owner.getWorkspaceLayout().groups).toHaveLength(1);
    expect(owner.getWorkspaceLayout().lastDocumentFileId).toBe("one");
  });
});
