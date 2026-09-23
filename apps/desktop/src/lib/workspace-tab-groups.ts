export const MAX_WORKSPACE_TAB_GROUPS = 3;

export type WorkspaceTab =
  | { id: string; kind: "document"; fileId: string }
  | { id: string; kind: "ai"; roomId: string; documentFileId: string };

export interface TabGroupState {
  id: string;
  tabs: WorkspaceTab[];
  activeTabId: string;
}

export type WorkspaceSplitNode =
  | { kind: "group"; groupId: string }
  | {
      kind: "split";
      id: string;
      direction: "row" | "column";
      ratio: number;
      first: WorkspaceSplitNode;
      second: WorkspaceSplitNode;
    };

export interface WorkspaceLayoutV2 {
  version: 2;
  groups: TabGroupState[];
  root: WorkspaceSplitNode;
  focusedGroupId: string;
  lastDocumentFileId: string;
}

export type WorkspaceDropEdge = "left" | "right" | "top" | "bottom";

const MIN_SPLIT_RATIO = 0.2;
const MAX_SPLIT_RATIO = 0.8;

export function documentWorkspaceTab(fileId: string): WorkspaceTab {
  return { id: `document:${fileId}`, kind: "document", fileId };
}

export function aiWorkspaceTab(roomId: string, documentFileId: string): WorkspaceTab {
  return { id: `ai:${roomId}`, kind: "ai", roomId, documentFileId };
}

export function createSingleGroupWorkspaceLayout(
  openFileIds: readonly string[],
  activeFileId: string,
): WorkspaceLayoutV2 {
  const fileIds = uniqueStrings([...openFileIds, activeFileId].filter(Boolean));
  const tabs = fileIds.map(documentWorkspaceTab);
  const groupId = "group-1";
  return {
    version: 2,
    groups: [{
      id: groupId,
      tabs,
      activeTabId: documentWorkspaceTab(activeFileId || fileIds[0] || "").id,
    }],
    root: { kind: "group", groupId },
    focusedGroupId: groupId,
    lastDocumentFileId: activeFileId || fileIds[0] || "",
  };
}

export function workspaceLayoutOpenFileIds(layout: WorkspaceLayoutV2): string[] {
  return uniqueStrings(layout.groups.flatMap((group) => group.tabs.flatMap((tab) => (
    tab.kind === "document" ? [tab.fileId] : [tab.documentFileId]
  ))));
}

/** Keeps legacy openFileIds callers and the V2 layout projection in lock-step. */
export function reconcileWorkspaceLayoutDocuments(
  layout: WorkspaceLayoutV2,
  openFileIds: readonly string[],
  activeFileId: string,
): WorkspaceLayoutV2 {
  const openIds = new Set(openFileIds);
  let groups = layout.groups.map((group) => {
    const tabs = group.tabs.filter((tab) => tab.kind === "ai" || openIds.has(tab.fileId));
    return {
      ...group,
      tabs,
      activeTabId: tabs.some((tab) => tab.id === group.activeTabId) ? group.activeTabId : tabs[0]?.id ?? "",
    };
  });
  let root = layout.root;
  const emptyIds = new Set(groups.filter((group) => group.tabs.length === 0).map((group) => group.id));
  if (groups.length > 1 && emptyIds.size > 0) {
    groups = groups.filter((group) => !emptyIds.has(group.id));
    root = removeGroupsFromSplitTree(root, emptyIds) ?? { kind: "group", groupId: groups[0].id };
  }
  const represented = new Set(groups.flatMap((group) => group.tabs.flatMap((tab) => (
    tab.kind === "document" ? [tab.fileId] : [tab.documentFileId]
  ))));
  const focusedGroupId = groups.some((group) => group.id === layout.focusedGroupId)
    ? layout.focusedGroupId
    : groups[0].id;
  groups = groups.map((group) => group.id === focusedGroupId
    ? {
        ...group,
        tabs: [...group.tabs, ...openFileIds.filter((id) => !represented.has(id)).map(documentWorkspaceTab)],
      }
    : group);
  const activeTabId = documentWorkspaceTab(activeFileId).id;
  if (groups.some((group) => group.tabs.some((tab) => tab.id === activeTabId))) {
    groups = groups.map((group) => group.tabs.some((tab) => tab.id === activeTabId)
      ? { ...group, activeTabId }
      : group);
  }
  return { ...layout, groups, root, focusedGroupId, lastDocumentFileId: activeFileId || layout.lastDocumentFileId };
}

export function findWorkspaceTab(layout: WorkspaceLayoutV2, tabId: string): WorkspaceTab | null {
  for (const group of layout.groups) {
    const tab = group.tabs.find((candidate) => candidate.id === tabId);
    if (tab) return tab;
  }
  return null;
}

export function addWorkspaceTab(
  layout: WorkspaceLayoutV2,
  tab: WorkspaceTab,
  groupId = layout.focusedGroupId,
): WorkspaceLayoutV2 {
  const existing = findWorkspaceTab(layout, tab.id);
  if (existing) {
    const owner = layout.groups.find((group) => group.tabs.some((candidate) => candidate.id === tab.id));
    return owner ? focusWorkspaceTab(layout, owner.id, tab.id) : layout;
  }
  if (!layout.groups.some((group) => group.id === groupId)) return layout;
  return {
    ...layout,
    groups: layout.groups.map((group) => group.id === groupId
      ? { ...group, tabs: [...group.tabs, tab], activeTabId: tab.id }
      : group),
    focusedGroupId: groupId,
  };
}

export function focusWorkspaceTab(
  layout: WorkspaceLayoutV2,
  groupId: string,
  tabId: string,
): WorkspaceLayoutV2 {
  const tab = findWorkspaceTab(layout, tabId);
  if (!tab || !layout.groups.some((group) => group.id === groupId && group.tabs.some((item) => item.id === tabId))) {
    return layout;
  }
  return {
    ...layout,
    groups: layout.groups.map((group) => group.id === groupId ? { ...group, activeTabId: tabId } : group),
    focusedGroupId: groupId,
    lastDocumentFileId: tab.kind === "document" ? tab.fileId : layout.lastDocumentFileId,
  };
}

export function moveWorkspaceTab(
  layout: WorkspaceLayoutV2,
  tabId: string,
  targetGroupId: string,
  targetIndex?: number,
): WorkspaceLayoutV2 {
  const tab = findWorkspaceTab(layout, tabId);
  if (!tab || !layout.groups.some((group) => group.id === targetGroupId)) return layout;

  let sourceGroupId = "";
  let nextGroups = layout.groups.map((group) => {
    if (!group.tabs.some((candidate) => candidate.id === tabId)) return group;
    sourceGroupId = group.id;
    const tabs = group.tabs.filter((candidate) => candidate.id !== tabId);
    return { ...group, tabs, activeTabId: group.activeTabId === tabId ? tabs[0]?.id ?? "" : group.activeTabId };
  });
  nextGroups = nextGroups.map((group) => {
    if (group.id !== targetGroupId) return group;
    const tabs = group.tabs.filter((candidate) => candidate.id !== tabId);
    const insertionIndex = Math.max(0, Math.min(targetIndex ?? tabs.length, tabs.length));
    tabs.splice(insertionIndex, 0, tab);
    return { ...group, tabs, activeTabId: tab.id };
  });

  let root = layout.root;
  if (sourceGroupId !== targetGroupId) {
    const emptyGroupIds = new Set(nextGroups.filter((group) => group.tabs.length === 0).map((group) => group.id));
    if (nextGroups.length > 1 && emptyGroupIds.size > 0) {
      nextGroups = nextGroups.filter((group) => !emptyGroupIds.has(group.id));
      root = removeGroupsFromSplitTree(root, emptyGroupIds) ?? { kind: "group", groupId: nextGroups[0].id };
    }
  }
  return {
    ...layout,
    groups: nextGroups,
    root,
    focusedGroupId: targetGroupId,
    lastDocumentFileId: layout.lastDocumentFileId,
  };
}

export function splitWorkspaceGroupWithTab(
  layout: WorkspaceLayoutV2,
  tabId: string,
  targetGroupId: string,
  edge: WorkspaceDropEdge,
  newGroupId: string,
  splitId: string,
): WorkspaceLayoutV2 {
  if (layout.groups.length >= MAX_WORKSPACE_TAB_GROUPS || layout.groups.some((group) => group.id === newGroupId)) {
    return layout;
  }
  const tab = findWorkspaceTab(layout, tabId);
  const target = layout.groups.find((group) => group.id === targetGroupId);
  if (!tab || !target) return layout;
  const source = layout.groups.find((group) => group.tabs.some((candidate) => candidate.id === tabId));
  // Moving the only tab out of the pane it already occupies would only replace
  // that pane with another pane containing the same tab. Keep the stable layout
  // instead of creating an empty leaf in the split tree.
  if (source?.id === targetGroupId && source.tabs.length === 1) return layout;

  const strippedGroups = layout.groups.map((group) => {
    if (!group.tabs.some((candidate) => candidate.id === tabId)) return group;
    const tabs = group.tabs.filter((candidate) => candidate.id !== tabId);
    return { ...group, tabs, activeTabId: group.activeTabId === tabId ? tabs[0]?.id ?? "" : group.activeTabId };
  });
  const emptyIds = new Set(strippedGroups.filter((group) => group.tabs.length === 0 && group.id !== targetGroupId).map((group) => group.id));
  const compactGroups = strippedGroups.filter((group) => !emptyIds.has(group.id));
  const compactRoot = removeGroupsFromSplitTree(layout.root, emptyIds) ?? layout.root;
  const groupLeaf: WorkspaceSplitNode = { kind: "group", groupId: newGroupId };
  const targetLeaf: WorkspaceSplitNode = { kind: "group", groupId: targetGroupId };
  const before = edge === "left" || edge === "top";
  const replacement: WorkspaceSplitNode = {
    kind: "split",
    id: splitId,
    direction: edge === "left" || edge === "right" ? "row" : "column",
    ratio: 0.5,
    first: before ? groupLeaf : targetLeaf,
    second: before ? targetLeaf : groupLeaf,
  };
  return {
    ...layout,
    groups: [...compactGroups, { id: newGroupId, tabs: [tab], activeTabId: tab.id }],
    root: replaceGroupLeaf(compactRoot, targetGroupId, replacement),
    focusedGroupId: newGroupId,
    lastDocumentFileId: layout.lastDocumentFileId,
  };
}

export function closeWorkspaceTabInLayout(layout: WorkspaceLayoutV2, tabId: string): WorkspaceLayoutV2 {
  const owner = layout.groups.find((group) => group.tabs.some((tab) => tab.id === tabId));
  if (!owner) return layout;
  const tabs = owner.tabs.filter((tab) => tab.id !== tabId);
  if (tabs.length > 0) {
    const closedIndex = owner.tabs.findIndex((tab) => tab.id === tabId);
    const activeTabId = owner.activeTabId === tabId
      ? tabs[Math.max(0, closedIndex - 1)]?.id ?? tabs[0].id
      : owner.activeTabId;
    return {
      ...layout,
      groups: layout.groups.map((group) => group.id === owner.id ? { ...group, tabs, activeTabId } : group),
    };
  }
  if (layout.groups.length === 1) return layout;
  const groups = layout.groups.filter((group) => group.id !== owner.id);
  const root = removeGroupsFromSplitTree(layout.root, new Set([owner.id])) ?? { kind: "group", groupId: groups[0].id };
  const focusedGroupId = layout.focusedGroupId === owner.id ? groups[0].id : layout.focusedGroupId;
  return { ...layout, groups, root, focusedGroupId };
}

export function updateWorkspaceSplitRatio(
  layout: WorkspaceLayoutV2,
  splitId: string,
  ratio: number,
): WorkspaceLayoutV2 {
  const clamped = Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, ratio));
  const update = (node: WorkspaceSplitNode): WorkspaceSplitNode => node.kind === "group"
    ? node
    : node.id === splitId
      ? { ...node, ratio: clamped }
      : { ...node, first: update(node.first), second: update(node.second) };
  return { ...layout, root: update(layout.root) };
}

export function normalizeWorkspaceLayout(
  candidate: WorkspaceLayoutV2 | null | undefined,
  openFileIds: readonly string[],
  activeFileId: string,
  validFileIds: ReadonlySet<string>,
  validRoomIds?: ReadonlySet<string>,
): WorkspaceLayoutV2 {
  const fallback = createSingleGroupWorkspaceLayout(openFileIds.filter((id) => validFileIds.has(id)), activeFileId);
  if (!candidate || candidate.version !== 2 || !Array.isArray(candidate.groups)) return fallback;

  const seenTabIds = new Set<string>();
  let groups = candidate.groups.slice(0, MAX_WORKSPACE_TAB_GROUPS).flatMap((group) => {
    if (!group || typeof group.id !== "string" || !Array.isArray(group.tabs)) return [];
    const tabs = group.tabs.filter((tab) => {
      if (!tab || typeof tab.id !== "string" || seenTabIds.has(tab.id)) return false;
      if (tab.kind === "document" && validFileIds.has(tab.fileId)) {
        seenTabIds.add(tab.id);
        return true;
      }
      if (tab.kind === "ai" && validFileIds.has(tab.documentFileId) && (!validRoomIds || validRoomIds.has(tab.roomId))) {
        seenTabIds.add(tab.id);
        return true;
      }
      return false;
    });
    if (tabs.length === 0) return [];
    return [{ ...group, tabs, activeTabId: tabs.some((tab) => tab.id === group.activeTabId) ? group.activeTabId : tabs[0].id }];
  });
  if (groups.length === 0) return fallback;
  const groupIds = new Set(groups.map((group) => group.id));
  const root = normalizeSplitNode(candidate.root, groupIds) ?? buildBalancedRoot(groups.map((group) => group.id));
  const referenced = collectGroupIds(root);
  groups = groups.filter((group) => referenced.has(group.id));
  const lastDocumentFileId = validFileIds.has(candidate.lastDocumentFileId)
    ? candidate.lastDocumentFileId
    : validFileIds.has(activeFileId) ? activeFileId : workspaceLayoutOpenFileIds({ ...candidate, groups, root })[0] ?? "";
  return {
    version: 2,
    groups,
    root,
    focusedGroupId: groupIds.has(candidate.focusedGroupId) ? candidate.focusedGroupId : groups[0].id,
    lastDocumentFileId,
  };
}

function replaceGroupLeaf(node: WorkspaceSplitNode, groupId: string, replacement: WorkspaceSplitNode): WorkspaceSplitNode {
  if (node.kind === "group") return node.groupId === groupId ? replacement : node;
  return { ...node, first: replaceGroupLeaf(node.first, groupId, replacement), second: replaceGroupLeaf(node.second, groupId, replacement) };
}

function removeGroupsFromSplitTree(node: WorkspaceSplitNode, removed: ReadonlySet<string>): WorkspaceSplitNode | null {
  if (node.kind === "group") return removed.has(node.groupId) ? null : node;
  const first = removeGroupsFromSplitTree(node.first, removed);
  const second = removeGroupsFromSplitTree(node.second, removed);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function normalizeSplitNode(node: WorkspaceSplitNode | null | undefined, groupIds: ReadonlySet<string>): WorkspaceSplitNode | null {
  if (!node || typeof node !== "object") return null;
  if (node.kind === "group") return groupIds.has(node.groupId) ? node : null;
  if (node.kind !== "split" || (node.direction !== "row" && node.direction !== "column")) return null;
  const first = normalizeSplitNode(node.first, groupIds);
  const second = normalizeSplitNode(node.second, groupIds);
  if (!first) return second;
  if (!second) return first;
  return { ...node, ratio: Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, Number(node.ratio) || 0.5)), first, second };
}

function buildBalancedRoot(groupIds: readonly string[]): WorkspaceSplitNode {
  let root: WorkspaceSplitNode = { kind: "group", groupId: groupIds[0] };
  for (let index = 1; index < groupIds.length; index += 1) {
    root = {
      kind: "split",
      id: `restored-split-${index}`,
      direction: "row",
      ratio: index / (index + 1),
      first: root,
      second: { kind: "group", groupId: groupIds[index] },
    };
  }
  return root;
}

function collectGroupIds(node: WorkspaceSplitNode): Set<string> {
  if (node.kind === "group") return new Set([node.groupId]);
  return new Set([...collectGroupIds(node.first), ...collectGroupIds(node.second)]);
}

function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

/** ペインがこれより狭い / 低いと、さらに分割しても本文が読めなくなる。 */
export const MIN_SPLIT_PANE_WIDTH = 560;
export const MIN_SPLIT_PANE_HEIGHT = 440;
/** ペイン端からこの割合までが「分割」、内側は「このペインへ移動」。 */
const SPLIT_EDGE_RATIO = 0.3;

export type WorkspaceDropIntent =
  | { kind: "move" }
  | { kind: "split"; edge: WorkspaceDropEdge };

/**
 * 並べ替えの差し込み位置。
 *
 * `moveWorkspaceTab` は «抜いてから差す» ので、同じ囲みの中で右へ動かすときは、
 * 画面で数えた落とし先から抜いた 1 つ分を引く。引かないと 1 つ右へ行き過ぎる。
 */
export function workspaceTabInsertionIndex(
  group: TabGroupState,
  tabId: string,
  dropIndex: number,
): number {
  const current = group.tabs.findIndex((tab) => tab.id === tabId);
  return current >= 0 && current < dropIndex ? dropIndex - 1 : dropIndex;
}

/** 画面での並び順 (左→右 / 上→下)。タブ列の並びとペインの並びを一致させるために使う。 */
export function orderedWorkspaceGroups(layout: WorkspaceLayoutV2): TabGroupState[] {
  const byId = new Map(layout.groups.map((group) => [group.id, group]));
  return orderedGroupIds(layout.root).flatMap((groupId) => {
    const group = byId.get(groupId);
    return group ? [group] : [];
  });
}

export function workspaceGroupPosition(layout: WorkspaceLayoutV2, groupId: string): number {
  return orderedGroupIds(layout.root).indexOf(groupId) + 1;
}

export function canSplitWorkspaceLayout(layout: WorkspaceLayoutV2): boolean {
  return layout.groups.length < MAX_WORKSPACE_TAB_GROUPS;
}

/**
 * ドラッグ中のタブをどう落とすかを、ペインの矩形とポインタ位置だけから決める。
 *
 * 4隅に目印を出す代わりに「端に寄せたら分割 / 内側なら移動」の 1 つの規則にまとめてある。
 * 分割できない (上限・ペインが小さい) 方向は候補に入らないので、移動として扱われる。
 */
export function resolveWorkspaceDropIntent(
  bounds: { left: number; top: number; width: number; height: number },
  point: { x: number; y: number },
  options: { splittable?: boolean } = {},
): WorkspaceDropIntent {
  if (options.splittable === false || bounds.width <= 0 || bounds.height <= 0) return { kind: "move" };
  const relativeX = (point.x - bounds.left) / bounds.width;
  const relativeY = (point.y - bounds.top) / bounds.height;
  const candidates: { edge: WorkspaceDropEdge; distance: number }[] = [];
  if (bounds.width >= MIN_SPLIT_PANE_WIDTH) {
    candidates.push({ edge: "left", distance: relativeX }, { edge: "right", distance: 1 - relativeX });
  }
  if (bounds.height >= MIN_SPLIT_PANE_HEIGHT) {
    candidates.push({ edge: "top", distance: relativeY }, { edge: "bottom", distance: 1 - relativeY });
  }
  const nearest = candidates
    .filter((candidate) => candidate.distance >= 0 && candidate.distance <= SPLIT_EDGE_RATIO)
    .sort((a, b) => a.distance - b.distance)[0];
  return nearest ? { kind: "split", edge: nearest.edge } : { kind: "move" };
}

function orderedGroupIds(node: WorkspaceSplitNode): string[] {
  return node.kind === "group"
    ? [node.groupId]
    : [...orderedGroupIds(node.first), ...orderedGroupIds(node.second)];
}
