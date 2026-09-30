// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceBookmarksPanel } from "./WorkspaceBookmarksPanel";
import { WorkspaceCommentsPanel } from "./WorkspaceCommentsPanel";
import { WorkspaceSidebar } from "./WorkspaceSidebar";
import type { WorkspaceBookmarkEntry, WorkspaceCommentEntry } from "./workspace-panels-model";

vi.mock("@/features/rendering/adapters/react", () => ({ DocumentTitleText: ({ title }: { title: string }) => <>{title}</> }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

const click = async (element: Element) => { await act(async () => { element.dispatchEvent(new MouseEvent("click", { bubbles: true })); }); };
const byLabel = (label: string) => container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
const buttonWithText = (text: string) => Array.from(container.querySelectorAll("button")).find((item) => item.textContent?.trim() === text)!;

const STAMP = "2026-09-20T03:04:00.000Z";
function comment(overrides: Partial<WorkspaceCommentEntry> & { threadId: string }): WorkspaceCommentEntry {
  return {
    key: `file-1:${overrides.threadId}`, fileId: "file-1", title: "方程式", location: "マイ教材 / 数学", shared: true,
    resolved: false, mentioned: true, authored: false, ownMessage: false, authorName: "佐藤", excerpt: "@私 ここを確認してください",
    quote: "x + 1 = 2", messageCount: 3, activityAt: STAMP, ...overrides,
  };
}

describe("WorkspaceCommentsPanel", () => {
  const entries = [
    comment({ threadId: "mention" }),
    comment({ threadId: "mine", mentioned: false, authored: true, ownMessage: true, authorName: "山田", excerpt: "質問です", quote: "", messageCount: 1 }),
    comment({ threadId: "done", resolved: true, authored: true }),
  ];
  const render = (props: Partial<ComponentProps<typeof WorkspaceCommentsPanel>> = {}) => act(() => root.render(
    <WorkspaceCommentsPanel entries={entries} signedIn scanning={false} onOpen={vi.fn()} {...props} />,
  ));

  it("lists unresolved related threads with why they are related, and opens the one that is chosen", async () => {
    const onOpen = vi.fn();
    render({ onOpen });
    const items = container.querySelectorAll(".workspace-comment-item");
    expect([...items].map((item) => item.getAttribute("data-comment-thread-id"))).toEqual(["mention", "mine"]);
    expect(items[0].textContent).toContain("方程式");
    expect(items[0].textContent).toContain("マイ教材 / 数学");
    expect(items[0].textContent).toContain("メンション");
    expect(items[0].textContent).toContain("佐藤@私 ここを確認してください");
    expect(items[0].textContent).toContain("x + 1 = 2");
    expect(items[0].textContent).toContain("3件のコメント");
    // 自分の投稿は名前ではなく「あなた」で示し、1 件だけのスレッドに件数は出さない。
    expect(items[1].textContent).toContain("自分が投稿");
    expect(items[1].textContent).toContain("あなた質問です");
    expect(items[1].textContent).not.toContain("件のコメント");

    await click(items[1]);
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(entries[1]);
  });

  it("narrows by relation and can include resolved threads", async () => {
    render();
    const threadIds = () => [...container.querySelectorAll(".workspace-comment-item")].map((item) => item.getAttribute("data-comment-thread-id"));
    await click(buttonWithText("メンション"));
    expect(threadIds()).toEqual(["mention"]);
    await click(buttonWithText("自分が投稿"));
    expect(threadIds()).toEqual(["mine"]);
    await click(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!);
    expect(threadIds()).toEqual(["mine", "done"]);
    expect(container.querySelector('[data-comment-thread-id="done"]')!.textContent).toContain("解決済み");
    expect(container.querySelector('[data-comment-thread-id="done"]')!.className).toContain("is-resolved");
    await click(buttonWithText("すべて"));
    expect(threadIds()).toEqual(["mention", "mine", "done"]);
  });

  it("explains an empty list, an empty filter and a signed-out user differently", async () => {
    render({ entries: [] });
    expect(container.querySelector('[data-empty-variant="comments"]')!.textContent).toContain("自分に関係するコメントはありません");
    render({ entries: [comment({ threadId: "done", resolved: true })] });
    expect(container.querySelector('[data-empty-variant="comments"]')!.textContent).toContain("該当するコメントはありません");
    render({ signedIn: false });
    expect(container.querySelector('[data-empty-variant="comments-signed-out"]')).not.toBeNull();
    expect(container.querySelector(".workspace-segmented")).toBeNull();
    expect(container.querySelector(".workspace-comment-item")).toBeNull();
  });

  it("shows progress only while the first pass finds nothing yet", () => {
    render({ entries: [], scanning: true });
    expect(container.querySelector('[role="status"]')!.textContent).toContain("コメントを確認中");
    render({ scanning: true });
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelectorAll(".workspace-comment-item")).toHaveLength(2);
  });
});

describe("WorkspaceBookmarksPanel", () => {
  const entries: WorkspaceBookmarkEntry[] = [
    { key: "folder:f", kind: "folder", id: "f", name: "数学", location: "マイ教材", workspaceId: "w", parentFolderId: null, shared: false, addedAt: STAMP },
    { key: "file:a", kind: "file", id: "a", name: "方程式", location: "マイ教材 / 数学", workspaceId: "w", parentFolderId: "f", shared: true, addedAt: STAMP },
  ];
  const render = (props: Partial<ComponentProps<typeof WorkspaceBookmarksPanel>> = {}) => act(() => root.render(
    <WorkspaceBookmarksPanel entries={entries} loading={false} failed={false} onOpen={vi.fn()} onRemove={vi.fn()} {...props} />,
  ));

  it("shows what is bookmarked with its location, opens it and removes it without opening", async () => {
    const onOpen = vi.fn(), onRemove = vi.fn();
    render({ onOpen, onRemove });
    const rows = container.querySelectorAll(".workspace-bookmark-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("数学");
    expect(rows[0].textContent).toContain("マイ教材");
    expect(rows[1].textContent).toContain("方程式");
    expect(rows[1].textContent).toContain("マイ教材 / 数学");

    await click(byLabel("方程式 を開く"));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(entries[1]);
    await click(byLabel("数学 のブックマークを外す"));
    expect(onRemove).toHaveBeenCalledExactlyOnceWith(entries[0]);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("distinguishes loading, failure and an empty list", () => {
    render({ entries: [], loading: true });
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    render({ entries: [], failed: true });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    render({ entries: [] });
    expect(container.querySelector('[data-empty-variant="bookmarks"]')!.textContent).toContain("ブックマークはありません");
  });
});

describe("WorkspaceSidebar panels", () => {
  const stamp = "2026-09-22T00:00:00.000Z";
  const workspaces = [
    { id: "w", name: "授業", createdAt: stamp, updatedAt: stamp },
    { id: "other", name: "別の授業", createdAt: stamp, updatedAt: stamp },
  ];
  function sidebar(overrides: Partial<ComponentProps<typeof WorkspaceSidebar>> = {}): ComponentProps<typeof WorkspaceSidebar> {
    return {
      collapsed: false, panel: "files", commentsAvailable: true, mentionCount: 0, onSelectPanel: vi.fn(),
      visibleWorkspaces: workspaces, activeWorkspaceId: "w", workspaceTreeExpanded: false, setWorkspaceTreeExpanded: vi.fn(),
      expandedFolderIds: new Set(), setExpandedFolderIds: vi.fn(), folders: [], files: [], rootFolders: [], rootFiles: [],
      effectiveFolderFilter: "all", setFolderFilter: vi.fn(), setSearchQuery: vi.fn(), dropTarget: null,
      dropProps: () => ({ onDragOver: vi.fn(), onDragLeave: vi.fn(), onDrop: vi.fn() }),
      onNewButtonClick: vi.fn(), onSwitchWorkspace: vi.fn(), onWorkspaceContextMenu: vi.fn(), onOpenFile: vi.fn(),
      onFolderContextMenu: vi.fn(), onFileContextMenu: vi.fn(), isRenameEditing: () => false, onStartRename: vi.fn(),
      onCommitRename: vi.fn(), onCancelRename: vi.fn(),
      ...overrides,
    };
  }
  const render = (overrides?: Partial<ComponentProps<typeof WorkspaceSidebar>>) => {
    const props = sidebar(overrides);
    act(() => root.render(<WorkspaceSidebar {...props} />));
    return props;
  };

  it("offers the comment list with the unresolved mention count, and the bookmarks", async () => {
    const props = render({ mentionCount: 3 });
    const comments = byLabel("コメント (自分宛て 3 件)");
    expect(comments.textContent).toContain("@3");
    await click(comments);
    await click(byLabel("ブックマーク"));
    expect((props.onSelectPanel as ReturnType<typeof vi.fn>).mock.calls).toEqual([["comments"], ["bookmarks"]]);
  });

  it("marks the open panel and leaves the count off when nothing mentions the user", () => {
    render({ panel: "comments" });
    const comments = byLabel("コメント");
    expect(comments.getAttribute("aria-current")).toBe("page");
    expect(comments.textContent).not.toContain("@");
    expect(byLabel("ブックマーク").getAttribute("aria-current")).toBeNull();
  });

  it("hides the comment list when collaboration is unavailable", () => {
    render({ commentsAvailable: false });
    expect(container.querySelector('[aria-label="コメント"]')).toBeNull();
    expect(byLabel("ブックマーク")).not.toBeNull();
  });

  it("returns to the file list when a workspace is chosen from another panel, without collapsing its tree", async () => {
    const props = render({ panel: "bookmarks", workspaceTreeExpanded: true });
    await click(buttonWithText("授業"));
    expect(props.onSelectPanel).toHaveBeenCalledWith("files");
    expect(props.setWorkspaceTreeExpanded).not.toHaveBeenCalled();
    // 開いているワークスペースは、一覧が開いているときだけ「現在地」として強調する。
    expect(buttonWithText("授業").className).not.toContain("active");
  });

  it("collapses to an icon rail: new button, comments and bookmarks stay, the workspace list goes", () => {
    render({ collapsed: true, mentionCount: 2 });
    expect(container.querySelector("aside")!.getAttribute("data-collapsed")).toBe("true");
    expect(byLabel("新規")).not.toBeNull();
    expect(byLabel("コメント (自分宛て 2 件)")).not.toBeNull();
    expect(byLabel("ブックマーク")).not.toBeNull();
    expect(container.querySelector('nav[aria-label="ワークスペース一覧"]')).toBeNull();
  });
});
