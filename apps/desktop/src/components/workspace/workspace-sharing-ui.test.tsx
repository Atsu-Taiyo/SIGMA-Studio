// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import { WorkspaceItemGrid } from "./WorkspaceItemGrid";
import { WorkspaceItemList } from "./WorkspaceItemList";
import { WorkspaceMenuSurface } from "./WorkspaceMenuSurface";
import { WorkspaceSharingDialog } from "./WorkspaceSharingDialog";
import type { CatalogSharingDetails, SharedCatalogBridge, SharedCatalogStatus } from "@/lib/runtime/shared-catalog";
import * as bridgeModule from "@/lib/desktop-bridge";
vi.mock("@/features/rendering/adapters/react", () => ({ DocumentTitleText: ({ title }: { title: string }) => <>{title}</> }));
vi.mock("./WorkspaceFileCardPreview", () => ({ WorkspaceFileCardPreview: () => null }));
let root: Root;
let container: HTMLDivElement;
const now = "2026-09-22T00:00:00.000Z";
const workspace = { id: "w", name: "授業", createdAt: now, updatedAt: now, fileCount: 1, folderCount: 1 };
const folder = { id: "f", workspaceId: "w", name: "数学", parentFolderId: null, createdAt: now, updatedAt: now, fileCount: 1 };
const file = { fileId: "d", docId: "doc", workspaceId: "w", folderId: null, title: "問題", revision: 1, createdAt: now, updatedAt: now };
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });
const click = async (element: Element) => { await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); };
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
function button(name: string) { const found = Array.from(document.querySelectorAll("button")).find((item) => item.textContent === name || item.getAttribute("aria-label") === name); expect(found).toBeTruthy(); return found!; }

describe("workspace menu targets", () => {
  it("sidebar sibling menus preserve inactive workspace, folder and file selection", async () => {
    const onSwitchWorkspace = vi.fn(), onOpenFile = vi.fn(), setFolderFilter = vi.fn();
    const onWorkspaceContextMenu = vi.fn(), onFolderContextMenu = vi.fn(), onFileContextMenu = vi.fn();
    const props: ComponentProps<typeof WorkspaceSidebar> = {
      visibleWorkspaces: [workspace, { ...workspace, id: "other", name: "別の授業" }], activeWorkspaceId: "w",
      workspaceTreeExpanded: true, setWorkspaceTreeExpanded: vi.fn(), expandedFolderIds: new Set(["f"]), setExpandedFolderIds: vi.fn(),
      folders: [folder], files: [file, { ...file, fileId: "nested", title: "小問", folderId: "f" }], rootFolders: [folder], rootFiles: [file],
      effectiveFolderFilter: "all", setFolderFilter, setSearchQuery: vi.fn(), dropTarget: null,
      dropProps: () => ({ onDragOver: vi.fn(), onDragLeave: vi.fn(), onDrop: vi.fn() }),
      onNewButtonClick: vi.fn(), onSwitchWorkspace, onWorkspaceContextMenu, onOpenFile, onFolderContextMenu, onFileContextMenu,
      isRenameEditing: () => false, onStartRename: vi.fn(), onCommitRename: vi.fn(), onCancelRename: vi.fn(),
    };
    act(() => root.render(<WorkspaceSidebar {...props} />));
    expect(container.querySelector("button button")).toBeNull();
    for (const name of ["別の授業", "数学", "問題", "小問"]) await click(container.querySelector(`button[aria-label="${name} の操作"]`)!);
    expect(onWorkspaceContextMenu.mock.calls[0][1]).toBe("other");
    expect(onFolderContextMenu.mock.calls[0][1]).toBe("f");
    expect(onFileContextMenu.mock.calls.map((call) => call[1].fileId)).toEqual(["d", "nested"]);
    expect(onSwitchWorkspace).not.toHaveBeenCalled(); expect(onOpenFile).not.toHaveBeenCalled(); expect(setFolderFilter).not.toHaveBeenCalled();
  });
  for (const mode of ["list", "grid"] as const) it(`${mode} folder/file menus do not select/open the row`, async () => {
    const onItemClick = vi.fn(), onOpenFolder = vi.fn(), onOpenFile = vi.fn(), onFolderContextMenu = vi.fn(), onOpenFileActionMenu = vi.fn();
    const common = { folders: [folder], files: [file], sortKey: "name" as const, sortDirection: "asc" as const, emptyVariant: "root" as const,
      dragItem: null, dropTarget: null, dragProps: () => ({ onDragStart: vi.fn(), onDragEnd: vi.fn() }), dropProps: () => ({ onDragOver: vi.fn(), onDragLeave: vi.fn(), onDrop: vi.fn() }), selectedKeys: new Set<string>(), focusedKey: null,
      onItemClick, onItemKeyDown: vi.fn(), onOpenFolder, onFolderContextMenu, onOpenFile, savingFileId: null, saving: false, fileActionMenuFileId: null, onOpenFileActionMenu,
      onCreateDocument: vi.fn(), onClearSearch: vi.fn(), isRenameEditing: () => false, onCommitRename: vi.fn(), onCancelRename: vi.fn() };
    act(() => root.render(mode === "grid" ? <WorkspaceItemGrid {...common} /> : <WorkspaceItemList {...common} allFolders={[folder]} workspaceName="授業" onRequestSort={vi.fn()} searchActive={false} />));
    for (const name of ["数学", "問題"]) await click(container.querySelector(`button[aria-label="${name} の操作"]`)!);
    expect(onFolderContextMenu).toHaveBeenCalledOnce(); expect(onOpenFileActionMenu).toHaveBeenCalledOnce();
    expect(onItemClick).not.toHaveBeenCalled(); expect(onOpenFolder).not.toHaveBeenCalled(); expect(onOpenFile).not.toHaveBeenCalled();
  });
  it("menu arrows skip disabled actions and restores trigger focus", () => {
    const trigger = document.createElement("button"); document.body.append(trigger); trigger.focus();
    act(() => root.render(<WorkspaceMenuSurface><button>共有する</button><button disabled>改名</button><button>削除</button></WorkspaceMenuSurface>));
    expect(document.activeElement?.textContent).toBe("共有する");
    act(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement?.textContent).toBe("削除");
    act(() => root.render(null)); expect(document.activeElement).toBe(trigger); trigger.remove();
  });
});

function setupCatalog() {
  let status: SharedCatalogStatus = { state: "ready", actorId: "owner", revision: 1, capabilities: { canStartDocumentShare: true, documentShareSource: "trial", canStartHierarchyShare: true, hierarchySharingEnabled: true, hierarchyShareSource: "trial" } };
  let listener = () => {};
  const catalog: SharedCatalogBridge = {
    billing: vi.fn(async () => {}), recoverLocked: vi.fn(async () => ({ saved: 0, failed: 0 })),
    status: vi.fn(async () => status), refresh: vi.fn(async () => status), setVisible: vi.fn(async () => {}),
    details: vi.fn(async () => null), start: vi.fn(), join: vi.fn(), invite: vi.fn(), changeMember: vi.fn(), revokeInvitation: vi.fn(), end: vi.fn(),
    onChange: vi.fn((next) => { listener = () => next(status); return vi.fn(); }),
  };
  const signInWithGoogle = vi.fn(async () => { status = { ...status, state: "ready", actorId: "owner" }; });
  vi.spyOn(bridgeModule, "getDesktopBridge").mockReturnValue({ sharedCatalog: catalog, collaboration: { signInWithGoogle, info: vi.fn(async () => ({ configured: true })), cancelSignIn: vi.fn() } } as unknown as ReturnType<typeof bridgeModule.getDesktopBridge>);
  return { catalog, signInWithGoogle, change: (next: SharedCatalogStatus) => { status = next; listener(); }, signedOut: () => { status = { ...status, state: "signed-out", actorId: null }; } };
}
describe("sharing settings authority", () => {
  it("automatically logs in once, revalidates exact folder identity and blocks a deleted target", async () => {
    const f = setupCatalog(); f.signedOut();
    vi.mocked(f.catalog.details).mockRejectedValue(new Error("TARGET_UNAVAILABLE"));
    const target = { source: "local" as const, local: { kind: "folder" as const, workspaceId: "original-workspace", folderId: "selected-folder" } };
    act(() => root.render(<WorkspaceSharingDialog target={target} name="数学" onClose={vi.fn()} onChanged={vi.fn()} />));
    await settle(); await settle();
    expect(f.signInWithGoogle).toHaveBeenCalledOnce(); expect(f.catalog.details).toHaveBeenCalledWith(target);
    expect(document.body.textContent).toContain("この項目は利用できなくなりました"); expect(f.catalog.start).not.toHaveBeenCalled();
  });
  it("valid unshared target starts through the typed local contract", async () => {
    const f = setupCatalog(); const local = { kind: "workspace" as const, workspaceId: "w" };
    act(() => root.render(<WorkspaceSharingDialog target={{ source: "local", local }} name="授業" onClose={vi.fn()} onChanged={vi.fn()} />));
    await settle(); await click(button("共有を開始")); expect(f.catalog.start).toHaveBeenCalledWith(local);
  });
  it("viewer sees sharing status without mutation controls, and account switch clears access", async () => {
    const f = setupCatalog();
    const details = { target: { kind: "folder", catalogNodeId: "node" }, name: "数学", sharing: { role: "viewer", capabilities: {} }, members: [{ userId: "viewer", email: "viewer@example.test", role: "viewer", direct: false, directRole: null, inheritanceSources: [], hasHiddenInheritance: true }] } as unknown as CatalogSharingDetails;
    vi.mocked(f.catalog.details).mockResolvedValue(details);
    act(() => root.render(<WorkspaceSharingDialog target={{ source: "shared", shared: details.target }} name="数学" onClose={vi.fn()} onChanged={vi.fn()} />));
    await settle(); expect(document.body.textContent).toContain("親から継承"); expect(document.body.textContent).toContain("変更は管理者に依頼");
    expect(document.body.textContent).not.toContain("招待コードを作成"); expect(document.body.textContent).not.toContain("共有を停止");
    vi.mocked(f.catalog.details).mockRejectedValue(new Error("FORBIDDEN"));
    await act(async () => f.change({ state: "ready", actorId: "other", revision: 2 }));
    await settle(); expect(document.body.textContent).toContain("この項目は利用できなくなりました");
  });
});

it("unchanged status notifications from a details read settle without a request loop", async () => {
  const f = setupCatalog();
  vi.mocked(f.catalog.details).mockImplementation(async () => {
    f.change(await f.catalog.status());
    return null;
  });
  act(() => root.render(<WorkspaceSharingDialog target={{ source: "local", local: { kind: "workspace", workspaceId: "w" } }} name="授業" onClose={vi.fn()} onChanged={vi.fn()} />));
  await settle(); await settle();
  expect(f.catalog.details).toHaveBeenCalledOnce(); expect(button("共有を開始").disabled).toBe(false);
});

it("admin manages editor/viewer but cannot change admins or stop the root; offline keeps details", async () => {
  const f = setupCatalog();
  const member = { userId: "editor", email: "editor@example.test", role: "editor", direct: true, directRole: "editor", inheritanceSources: [], hasHiddenInheritance: false };
  const details = { target: { kind: "workspace", catalogNodeId: "node" }, name: "授業", sharing: { role: "admin", capabilities: { invite: true, manageEditorViewer: true, appointAdmin: false, stopRootShare: false, deleteRootShare: false } },
    members: [member, { ...member, userId: "admin", email: "admin@example.test", role: "admin", directRole: "admin" },
      { ...member, userId: "inherited", email: "inherited@example.test", role: "admin", directRole: "viewer", inheritanceSources: [{ catalogNodeId: "parent", name: "学校", role: "admin" }] }] } as unknown as CatalogSharingDetails;
  vi.mocked(f.catalog.details).mockResolvedValue(details);
  act(() => root.render(<WorkspaceSharingDialog target={{ source: "shared", shared: details.target }} name="授業" onClose={vi.fn()} onChanged={vi.fn()} />));
  await settle();
  expect(document.body.textContent).toContain("学校から継承：管理者");
  expect(document.querySelector('[aria-label="editor@example.test 参加者"]')).toBeTruthy();
  expect(document.querySelector('[aria-label="admin@example.test 参加者"]')).toBeNull();
  expect(document.querySelector('[aria-label="inherited@example.test 参加者"]')).toBeNull();
  expect(document.body.textContent).not.toContain("共有を停止"); expect(document.body.textContent).not.toContain("サーバーから削除");
  vi.mocked(f.catalog.details).mockRejectedValue(new Error("OFFLINE"));
  await act(async () => f.change({ state: "offline", actorId: "owner", revision: 1 })); await settle();
  expect(document.body.textContent).toContain("学校から継承：管理者");
  expect(button("招待コードを作成").disabled).toBe(true);
  expect(document.body.textContent).not.toContain("この項目は利用できなくなりました");
});

it("join retains the submitted token through Google authentication", async () => {
  const { WorkspaceJoinDialog } = await import("./WorkspaceJoinDialog");
  const f = setupCatalog();
  const onJoined = vi.fn();
  const result = { target: { kind: "folder" as const, catalogNodeId: "folder" as CatalogSharingDetails["target"]["catalogNodeId"] }, workspaceId: "shared-items", folderId: "received-folder" };
  vi.mocked(f.catalog.join).mockResolvedValue(result);
  act(() => root.render(<WorkspaceJoinDialog onClose={vi.fn()} onJoined={onJoined} />));
  const input = document.querySelector("input")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "  original-token  "); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await click(button("招待に参加"));
  expect(f.signInWithGoogle).toHaveBeenCalledOnce(); expect(f.catalog.join).toHaveBeenCalledWith("original-token"); expect(onJoined).toHaveBeenCalledWith(result);
});

it("unconfigured desktop never starts a Google authentication attempt", async () => {
  const f = setupCatalog(); f.signedOut();
  vi.mocked(bridgeModule.getDesktopBridge()!.collaboration!.info).mockResolvedValue({ configured: false, user: null, sessions: [], restrictedFileIds: [] });
  act(() => root.render(<WorkspaceSharingDialog target={{ source: "local", local: { kind: "document", fileId: "chosen" } }} name="問題" onClose={vi.fn()} onChanged={vi.fn()} />));
  await settle(); await settle();
  expect(document.body.textContent).toContain("このアプリでは共有が設定されていません"); expect(f.signInWithGoogle).not.toHaveBeenCalled();
});

it("a valid target can be shared after automatic login without changing its identity", async () => {
  const f = setupCatalog(); f.signedOut();
  const local = { kind: "document" as const, fileId: "chosen-before-login" };
  act(() => root.render(<WorkspaceSharingDialog target={{ source: "local", local }} name="問題" onClose={vi.fn()} onChanged={vi.fn()} />));
  await settle(); await settle();
  await click(button("共有を開始"));
  expect(f.signInWithGoogle).toHaveBeenCalledOnce(); expect(f.catalog.start).toHaveBeenCalledWith(local);
});

describe("Pro paywall entry", () => {
  const free = { canStartDocumentShare: true, documentShareSource: "free" as const, hierarchySharingEnabled: true, canStartHierarchyShare: false, hierarchyShareSource: "none" as const };
  it("replaces workspace and folder sharing start with the Pro paywall for a free owner", async () => {
    const f = setupCatalog();
    f.change({ state: "ready", actorId: "owner", revision: 1, capabilities: free });
    const local = { kind: "folder" as const, workspaceId: "w", folderId: "f" };
    act(() => root.render(<WorkspaceSharingDialog target={{ source: "local", local }} name="数学" onClose={vi.fn()} onChanged={vi.fn()} />));
    await settle();
    expect(Array.from(document.querySelectorAll("button")).some((item) => item.textContent === "共有を開始")).toBe(false);
    expect(document.body.textContent).toContain("ワークスペースとフォルダの共有はProプランの機能です。");
    expect(document.body.textContent).not.toContain("この項目の共有を開始できません。");
    await click(button("Proプランを見る"));
    const dialogs = document.querySelectorAll('[role="dialog"]');
    expect(dialogs).toHaveLength(2);
    expect(dialogs[1].textContent).toContain("$9");
    expect(dialogs[1].textContent).toContain("共同編集者を15人まで招待");
    expect(f.catalog.start).not.toHaveBeenCalled();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });
  it("keeps individual documents free and disabled servers out of the paywall", async () => {
    const f = setupCatalog();
    f.change({ state: "ready", actorId: "owner", revision: 1, capabilities: free });
    act(() => root.render(<WorkspaceSharingDialog target={{ source: "local", local: { kind: "document", fileId: "d" } }} name="問題" onClose={vi.fn()} onChanged={vi.fn()} />));
    await settle();
    expect(button("共有を開始").disabled).toBe(false);
    expect(document.body.textContent).not.toContain("Proプランを見る");
    f.change({ state: "ready", actorId: "owner", revision: 1, capabilities: { ...free, canStartDocumentShare: true, documentShareSource: "free" as const, hierarchySharingEnabled: false } });
    act(() => root.render(<WorkspaceSharingDialog target={{ source: "local", local: { kind: "workspace", workspaceId: "w" } }} name="授業" onClose={vi.fn()} onChanged={vi.fn()} />));
    await settle();
    expect(button("共有を開始").disabled).toBe(true);
    expect(document.body.textContent).toContain("この項目の共有を開始できません。");
    expect(document.body.textContent).not.toContain("Proプランを見る");
  });
});
