import { describe, expect, it } from "vitest";
import type { SharedCapabilities } from "@/features/collaboration/model/catalog";
import type { LibrarySharingMetadata, SharedCatalogStatus } from "@/lib/runtime/shared-catalog";
import { SHARED_ITEMS_WORKSPACE_ID } from "@/lib/runtime/shared-catalog";
import type { WorkspaceOverview } from "@/lib/workspace-repository";
import { describeCreatedMaterial, planNewMaterialTargets } from "./new-material-destination";

const stamp = "2026-10-16T00:00:00.000Z";
const ready: SharedCatalogStatus = { state: "ready", actorId: "me", revision: 1 };

function sharing(createChildren: boolean, placement: "owned" | "incoming" = "incoming"): LibrarySharingMetadata {
  const capabilities = {
    read: true, editDocument: createChildren, createChildren, rename: false, move: false, deleteDescendants: false,
    invite: false, manageEditorViewer: false, appointAdmin: false, stopRootShare: false, deleteRootShare: false,
    restoreDocument: false, startHierarchyShare: false,
  } satisfies SharedCapabilities;
  return {
    target: { kind: "workspace", catalogNodeId: "node" as never }, ownerId: "owner", createdBy: "owner",
    role: createChildren ? "editor" : "viewer", capabilities, state: "active", placement, isShareRoot: true,
  };
}

function workspace(id: string, name: string, extra: Partial<WorkspaceOverview["workspaces"][number]> = {}) {
  return { id, name, createdAt: stamp, updatedAt: stamp, ...extra };
}

function folder(id: string, workspaceId: string, name: string, parentFolderId: string | null = null, extra: Partial<WorkspaceOverview["folders"][number]> = {}) {
  return { id, workspaceId, name, parentFolderId, fileCount: 0, createdAt: stamp, updatedAt: stamp, ...extra };
}

function overview(partial: Partial<WorkspaceOverview>): WorkspaceOverview {
  return { activeWorkspaceId: "local", workspaces: [], folders: [], files: [], catalog: ready, ...partial };
}

describe("planNewMaterialTargets", () => {
  it("clicks into the previous material's workspace and folder, and offers every workspace that accepts new materials", () => {
    const plan = planNewMaterialTargets({ workspaceId: "team", folderId: "unit" }, overview({
      activeWorkspaceId: "team",
      workspaces: [
        workspace("local", "マイ教材"),
        workspace("team", "数学科", { sharing: sharing(true, "owned") }),
        workspace("viewer", "閲覧だけ", { sharing: sharing(false) }),
        workspace("pending", "共有の準備中", { sharingPending: true }),
        workspace(SHARED_ITEMS_WORKSPACE_ID, "共有アイテム"),
      ],
      folders: [folder("unit", "team", "単元", null, { sharing: sharing(true, "owned") })],
    }));
    expect(plan.clickTarget).toEqual({ location: { workspaceId: "team", folderId: "unit" }, origin: "previous" });
    expect(plan.options.map(({ workspaceId, cloud, location, isDefault }) => ({ workspaceId, cloud, location, isDefault }))).toEqual([
      { workspaceId: "local", cloud: false, location: { workspaceId: "local", folderId: null }, isDefault: false },
      { workspaceId: "team", cloud: true, location: { workspaceId: "team", folderId: "unit" }, isDefault: true },
    ]);
  });

  it("falls back to the first local workspace root when the previous material's place is read-only, never to the cloud", () => {
    const plan = planNewMaterialTargets({ workspaceId: SHARED_ITEMS_WORKSPACE_ID, folderId: "shared-folder" }, overview({
      activeWorkspaceId: SHARED_ITEMS_WORKSPACE_ID,
      workspaces: [
        workspace("team", "数学科", { sharing: sharing(true, "owned") }),
        workspace("local", "マイ教材"),
        workspace(SHARED_ITEMS_WORKSPACE_ID, "共有アイテム"),
      ],
      folders: [folder("shared-folder", SHARED_ITEMS_WORKSPACE_ID, "見るだけのフォルダ", null, { sharing: sharing(false) })],
    }));
    expect(plan.clickTarget).toEqual({ location: { workspaceId: "local", folderId: null }, origin: "fallback" });
    expect(plan.options.map((option) => option.workspaceId)).toEqual(["team", "local"]);
    expect(plan.options.find((option) => option.isDefault)?.workspaceId).toBe("local");
  });

  it("keeps an editable folder inside the shared items as the click target, though the shared items root is not a choice", () => {
    const plan = planNewMaterialTargets({ workspaceId: SHARED_ITEMS_WORKSPACE_ID, folderId: "shared-folder" }, overview({
      workspaces: [workspace("local", "マイ教材"), workspace(SHARED_ITEMS_WORKSPACE_ID, "共有アイテム")],
      folders: [folder("shared-folder", SHARED_ITEMS_WORKSPACE_ID, "編集できるフォルダ", null, { sharing: sharing(true) })],
    }));
    expect(plan.clickTarget).toEqual({ location: { workspaceId: SHARED_ITEMS_WORKSPACE_ID, folderId: "shared-folder" }, origin: "previous" });
    expect(plan.options.find((option) => option.isDefault)).toMatchObject({ workspaceId: SHARED_ITEMS_WORKSPACE_ID, sharedItems: true, cloud: true });
  });

  it("does not offer shared workspaces while the shared catalog is offline", () => {
    const plan = planNewMaterialTargets({ workspaceId: "team", folderId: null }, overview({
      catalog: { state: "offline", actorId: "me", revision: 1 },
      workspaces: [workspace("team", "数学科", { sharing: sharing(true, "owned") }), workspace("local", "マイ教材")],
    }));
    expect(plan.options.map((option) => option.workspaceId)).toEqual(["local"]);
    expect(plan.clickTarget).toEqual({ location: { workspaceId: "local", folderId: null }, origin: "fallback" });
  });

  it("chooses a workspace other than the previous one at its root", () => {
    const plan = planNewMaterialTargets({ workspaceId: "local", folderId: "f" }, overview({
      workspaces: [workspace("local", "マイ教材"), workspace("other", "別のワークスペース")],
      folders: [folder("f", "local", "フォルダ")],
    }));
    expect(plan.options.find((option) => option.workspaceId === "other")?.location).toEqual({ workspaceId: "other", folderId: null });
    expect(plan.options.find((option) => option.workspaceId === "local")?.location).toEqual({ workspaceId: "local", folderId: "f" });
  });
});

describe("describeCreatedMaterial", () => {
  const base = { title: "無題の教材", sharing: undefined };
  const list = overview({
    workspaces: [workspace("local", "マイ教材"), workspace("team", "数学科", { sharing: sharing(true, "owned") })],
    folders: [folder("grade", "local", "2年"), folder("unit", "local", "関数", "grade")],
  });

  it("names the workspace and the whole folder hierarchy of the saved location", () => {
    expect(describeCreatedMaterial({ ...base, workspaceId: "local", folderId: "unit" }, list, { kind: "material", origin: "previous", runtimeTarget: "desktop" }))
      .toEqual({ kind: "material", title: "無題の教材", workspaceId: "local", workspaceName: "マイ教材", sharedItems: false, folderPath: ["2年", "関数"], storage: "device", origin: "previous" });
  });

  it("says the workspace root when there is no folder, and the cloud for a shared workspace", () => {
    expect(describeCreatedMaterial({ ...base, workspaceId: "team", folderId: null }, list, { kind: "whiteboard", origin: "chosen", runtimeTarget: "desktop" }))
      .toMatchObject({ workspaceName: "数学科", folderPath: [], storage: "cloud", kind: "whiteboard" });
    expect(describeCreatedMaterial({ ...base, workspaceId: "local", folderId: null }, list, { kind: "material", origin: "default", runtimeTarget: "web" }))
      .toMatchObject({ folderPath: [], storage: "browser" });
  });

  it("does not guess a location it could not read", () => {
    expect(describeCreatedMaterial({ ...base, workspaceId: "gone", folderId: "missing" }, null, { kind: "material", origin: "previous", runtimeTarget: "desktop" }))
      .toMatchObject({ workspaceName: null, folderPath: null });
  });
});
