/**
 * ブロックエディタ風の「掴んで動かす」の純粋モデル。
 *
 * 掴む単位 (drag unit) は **本文のどの深さのブロックでも、リストなら 1 項目ずつ**。SigmaDoc の
 * 木を「入れ物 (container)」の連なりとして一様に歩き、取り出し → 差し込み → 入れ物の後始末を
 * この順で 1 回ずつ行う。UI はここへ `BlockDragMoveRequest` を渡すだけで、DOM も React も知らない。
 *
 * 段組 (`layoutSection`) の列所属は SigmaDoc の `columnStartIds` が所有する。DOM の折り返し位置や
 * `pagination.break` から列を逆算しない。空になった列は詰め、1 列になった段組は解く。
 *
 * リストは「項目 = ブロック」として扱う: 項目を外へ出せば 1 項目のリストになり、同じ種類の
 * リストの隣に落ちれば合流する。項目の間に段落を落とせばリストは 2 つに割れ、後ろは続き番号を持つ。
 */

import { createId } from "@/lib/id";
import { createParagraph, type EditableBlock } from "@/lib/document-tree";
import {
  PROBLEM_AREA_ORDER,
  type LayoutSectionNode,
  type ListItemNode,
  type ListNode,
  type ProblemAreaKind,
  type SigmaBlock,
  type SigmaDocument,
} from "@/features/document";
import {
  getLayoutSectionColumns,
  getLayoutSectionColumnWidths,
  setLayoutSectionColumns,
} from "@/features/text-editing";

export type BlockDropTarget =
  /** `anchorId` の前後に並べる。anchor がリスト項目なら項目の前後 (リストの分割・合流を伴う)。 */
  | { kind: "sibling"; anchorId: string; position: "before" | "after" }
  /** `anchorId` と横に並べて新しい 2 段組を作る。 */
  | { kind: "newColumns"; anchorId: string; side: "left" | "right" }
  /** 既存の段組で、`anchorChildId` が居る段の左右に段を 1 つ増やして入れる。 */
  | { kind: "insertColumn"; sectionId: string; anchorChildId: string; side: "left" | "right" }
  /** 問題エリアの末尾 (エリアが空のとき)。 */
  | { kind: "areaEnd"; problemId: string; area: ProblemAreaKind };

export interface BlockDragMoveRequest {
  unitIds: readonly string[];
  target: BlockDropTarget;
}

export type DragContainerKind =
  | "content"
  | "problemArea"
  | "layout"
  | "box"
  | "quote"
  | "list"
  | "nested"
  | "continuations";

export interface DragContainerRef {
  kind: DragContainerKind;
  /** 入れ物を持つブロック (または項目) の id。本文直下は null。 */
  ownerId: string | null;
  area?: ProblemAreaKind;
}

export interface DragUnitInfo {
  id: string;
  type: EditableBlock["type"];
  container: DragContainerRef;
  /** 外側から順に並べた祖先の id (ブロック・項目)。 */
  ancestors: readonly string[];
  /** 文書順の通し番号。 */
  order: number;
  /** 入れ物の中での位置と兄弟の数。 */
  index: number;
  siblingCount: number;
}

export const MAX_LAYOUT_SECTION_COLUMNS = 4;

type AnyNode = EditableBlock;

// ---------------------------------------------------------------------------------------------
// 木を歩く
// ---------------------------------------------------------------------------------------------

type Visitor = (items: readonly AnyNode[], ref: DragContainerRef) => readonly AnyNode[];

function sameItems(a: readonly AnyNode[], b: readonly AnyNode[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** 深い側から順に、すべての入れ物の配列へ `visit` を当てる。何も変えなければ同じ参照を返す。 */
function mapTree(items: readonly AnyNode[], ref: DragContainerRef, visit: Visitor): readonly AnyNode[] {
  const mapped = items.map((node) => mapNode(node, visit));
  const base = sameItems(mapped, items) ? items : mapped;
  const visited = visit(base, ref);
  return sameItems(visited, base) ? base : visited;
}

function mapNode(node: AnyNode, visit: Visitor): AnyNode {
  switch (node.type) {
    case "problem": {
      let changed = false;
      const next = { ...node };
      for (const area of PROBLEM_AREA_ORDER) {
        const blocks = mapTree(node[area], { kind: "problemArea", ownerId: node.id, area }, visit);
        if (blocks !== node[area]) {
          changed = true;
          next[area] = blocks as typeof node[typeof area];
        }
      }
      return changed ? next : node;
    }
    case "layoutSection": {
      const children = mapTree(node.children, { kind: "layout", ownerId: node.id }, visit);
      return children === node.children ? node : { ...node, children: children as LayoutSectionNode["children"] };
    }
    case "boxBlock": {
      const blocks = mapTree(node.blocks, { kind: "box", ownerId: node.id }, visit);
      return blocks === node.blocks ? node : { ...node, blocks: blocks as typeof node.blocks };
    }
    case "quote": {
      const blocks = mapTree(node.blocks, { kind: "quote", ownerId: node.id }, visit);
      return blocks === node.blocks ? node : { ...node, blocks: blocks as typeof node.blocks };
    }
    case "list": {
      const items = mapTree(node.items, { kind: "list", ownerId: node.id }, visit);
      return items === node.items ? node : { ...node, items: items as ListItemNode[] };
    }
    case "listItem": {
      let changed = false;
      const next = { ...node };
      if (node.continuations && node.continuations.length > 0) {
        const continuations = mapTree(node.continuations, { kind: "continuations", ownerId: node.id }, visit);
        if (continuations !== node.continuations) {
          changed = true;
          next.continuations = continuations as ListItemNode["continuations"];
        }
      }
      if (node.nested && node.nested.length > 0) {
        const nested = mapTree(node.nested, { kind: "nested", ownerId: node.id }, visit);
        if (nested !== node.nested) {
          changed = true;
          next.nested = nested as ListNode[];
        }
      }
      return changed ? next : node;
    }
    default:
      return node;
  }
}

function forEachContainer(
  items: readonly AnyNode[],
  ref: DragContainerRef,
  ancestors: readonly string[],
  fn: (items: readonly AnyNode[], ref: DragContainerRef, ancestors: readonly string[]) => void,
): void {
  fn(items, ref, ancestors);
  for (const node of items) {
    const chain = [...ancestors, node.id];
    switch (node.type) {
      case "problem":
        for (const area of PROBLEM_AREA_ORDER) {
          forEachContainer(node[area], { kind: "problemArea", ownerId: node.id, area }, chain, fn);
        }
        break;
      case "layoutSection":
        forEachContainer(node.children, { kind: "layout", ownerId: node.id }, chain, fn);
        break;
      case "boxBlock":
        forEachContainer(node.blocks, { kind: "box", ownerId: node.id }, chain, fn);
        break;
      case "quote":
        forEachContainer(node.blocks, { kind: "quote", ownerId: node.id }, chain, fn);
        break;
      case "list":
        forEachContainer(node.items, { kind: "list", ownerId: node.id }, chain, fn);
        break;
      case "listItem":
        if (node.continuations?.length) {
          forEachContainer(node.continuations, { kind: "continuations", ownerId: node.id }, chain, fn);
        }
        if (node.nested?.length) {
          forEachContainer(node.nested, { kind: "nested", ownerId: node.id }, chain, fn);
        }
        break;
      default:
        break;
    }
  }
}

/**
 * 掴める単位の索引。文書順 (先行順) に並ぶ。**リストそのものは入れない** — 掴むのは項目。
 * 項目にぶら下がる入れ子リストも同様で、その項目だけが単位になる。
 */
export function indexDragUnits(content: readonly SigmaBlock[]): Map<string, DragUnitInfo> {
  return indexNodes(content, false);
}

/** 掴めないリスト自身も含めた索引。落とし先の anchor (リストの前後) と、項目の入れ物の判定に使う。 */
export function indexDragAnchors(content: readonly SigmaBlock[]): Map<string, DragUnitInfo> {
  return indexNodes(content, true);
}

/** 索引の本体。`includeLists` で (掴めない) リスト自身も、落とし先の anchor として引けるようにする。 */
function indexNodes(content: readonly AnyNode[], includeLists: boolean): Map<string, DragUnitInfo> {
  const index = new Map<string, DragUnitInfo>();
  let order = 0;
  const visitInOrder = (items: readonly AnyNode[], ref: DragContainerRef, ancestors: readonly string[]) => {
    items.forEach((node, position) => {
      if (includeLists || node.type !== "list") {
        index.set(node.id, {
          id: node.id,
          type: node.type,
          container: ref,
          ancestors,
          order: order++,
          index: position,
          siblingCount: items.length,
        });
      }
      const chain = [...ancestors, node.id];
      switch (node.type) {
        case "problem":
          for (const area of PROBLEM_AREA_ORDER) {
            visitInOrder(node[area], { kind: "problemArea", ownerId: node.id, area }, chain);
          }
          break;
        case "layoutSection":
          visitInOrder(node.children, { kind: "layout", ownerId: node.id }, chain);
          break;
        case "boxBlock":
          visitInOrder(node.blocks, { kind: "box", ownerId: node.id }, chain);
          break;
        case "quote":
          visitInOrder(node.blocks, { kind: "quote", ownerId: node.id }, chain);
          break;
        case "list":
          visitInOrder(node.items, { kind: "list", ownerId: node.id }, chain);
          break;
        case "listItem":
          if (node.continuations?.length) {
            visitInOrder(node.continuations, { kind: "continuations", ownerId: node.id }, chain);
          }
          if (node.nested?.length) {
            visitInOrder(node.nested, { kind: "nested", ownerId: node.id }, chain);
          }
          break;
        default:
          break;
      }
    });
  };
  visitInOrder(content, { kind: "content", ownerId: null }, []);
  return index;
}

/** 掴む id の集合を、文書順に並べ、祖先が選ばれているものを落とした形へ。 */
export function normalizeDragUnitIds(content: readonly SigmaBlock[], ids: readonly string[]): string[] {
  const index = indexDragUnits(content);
  const set = new Set(ids.filter((id) => index.has(id)));
  return [...set]
    .filter((id) => !index.get(id)!.ancestors.some((ancestor) => set.has(ancestor)))
    .sort((a, b) => index.get(a)!.order - index.get(b)!.order);
}

interface Located {
  node: AnyNode;
  ref: DragContainerRef;
  index: number;
  siblings: readonly AnyNode[];
}

function locate(content: readonly AnyNode[], id: string): Located | null {
  let found = null as Located | null;
  forEachContainer(content, { kind: "content", ownerId: null }, [], (items, ref) => {
    if (found) {
      return;
    }
    const position = items.findIndex((node) => node.id === id);
    if (position >= 0) {
      found = { node: items[position], ref, index: position, siblings: items };
    }
  });
  return found;
}

function findNode(content: readonly AnyNode[], id: string): AnyNode | null {
  return locate(content, id)?.node ?? null;
}

// ---------------------------------------------------------------------------------------------
// 型の規則: どの入れ物に何が置けるか
// ---------------------------------------------------------------------------------------------

const LAYOUT_ELIGIBLE_TYPES = new Set([
  "section",
  "heading",
  "paragraph",
  "list",
  "quote",
  "codeBlock",
  "divider",
  "boxBlock",
]);

/**
 * 入れ物ごとに置ける型。SigmaDoc スキーマと **編集面 (ProseMirror) の content 式**
 * の受理集合に合わせる。ここだけ狭いと、描画できるブロックにグリップが出ても移動できない。
 */
export function isTypeAllowedInContainer(kind: DragContainerKind, type: string): boolean {
  switch (kind) {
    case "content":
      return type !== "listItem";
    case "problemArea":
      return ["heading", "paragraph", "list", "quote", "codeBlock", "divider", "layoutSection", "boxBlock"].includes(type);
    case "layout":
      return LAYOUT_ELIGIBLE_TYPES.has(type);
    case "box":
      return type !== "listItem" && type !== "problem";
    case "quote":
      return ["heading", "paragraph", "list", "codeBlock", "divider"].includes(type);
    case "continuations":
      return ["heading", "paragraph", "divider"].includes(type);
    case "nested":
    case "list":
      return type === "list";
    default:
      return false;
  }
}

/** 段組に横並びで置ける単位か (項目はリストになって入るので可)。 */
export function isColumnEligibleUnitType(type: string): boolean {
  return type === "listItem" || LAYOUT_ELIGIBLE_TYPES.has(type);
}

/** 新しい段組を作れる入れ物か。 */
export function containerAllowsNewColumns(kind: DragContainerKind): boolean {
  return kind === "content" || kind === "problemArea" || kind === "box";
}

function unitBlockType(node: AnyNode): string {
  return node.type === "listItem" ? "list" : node.type;
}

// ---------------------------------------------------------------------------------------------
// リスト: 分割・合流
// ---------------------------------------------------------------------------------------------

function listStart(list: ListNode): number {
  return list.listType === "ordered" ? (list.start ?? 1) : 1;
}

function withListStart(list: ListNode, start: number): ListNode {
  if (list.listType !== "ordered") {
    const { start: _omit, ...rest } = list;
    void _omit;
    return rest;
  }
  if (start <= 1) {
    const { start: _omit, ...rest } = list;
    void _omit;
    return rest;
  }
  return { ...list, start };
}

function sameListKind(a: ListNode, b: ListNode): boolean {
  return a.listType === b.listType && (a.markerStyle ?? "decimal") === (b.markerStyle ?? "decimal");
}

/** 隣り合う同じ種類のリストを 1 つにする。id は合成でない方 (元からあった方) を残す。 */
function coalesceAdjacentLists(
  items: readonly AnyNode[],
  syntheticIds: ReadonlySet<string>,
  options: {
    /** 与えると、この参照のどちらかが片側にある継ぎ目だけを合流させる (差し込んだ単位の周りだけ)。 */
    seam?: ReadonlySet<AnyNode>;
    onlyContinuous?: boolean;
  } = {},
): readonly AnyNode[] {
  const next: AnyNode[] = [];
  const seam = options.seam ? new Set(options.seam) : null;
  let changed = false;
  for (const node of items) {
    const previous = next[next.length - 1];
    if (
      previous
      && previous.type === "list"
      && node.type === "list"
      && sameListKind(previous, node)
      && (!seam || seam.has(previous) || seam.has(node))
      && (!options.onlyContinuous || previous.listType !== "ordered"
        || listStart(node) === listStart(previous) + previous.items.length)
    ) {
      const keepPrevious = !syntheticIds.has(previous.id) || syntheticIds.has(node.id);
      const merged: ListNode = {
        ...(keepPrevious ? previous : node),
        id: keepPrevious ? previous.id : node.id,
        items: [...previous.items, ...node.items],
      };
      const settled = withListStart(
        { ...merged, listType: previous.listType, markerStyle: previous.markerStyle },
        listStart(previous),
      );
      next[next.length - 1] = settled;
      seam?.add(settled);
      changed = true;
      continue;
    }
    next.push(node);
  }
  return changed ? next : items;
}

/** 項目 `itemIndex` の前 (`position: before`) または後ろに `inserted` を挟み、リストを分ける。 */
function splitListAround(
  list: ListNode,
  itemIndex: number,
  position: "before" | "after",
  inserted: readonly AnyNode[],
): AnyNode[] {
  const cut = position === "before" ? itemIndex : itemIndex + 1;
  const before = list.items.slice(0, cut);
  const after = list.items.slice(cut);
  const result: AnyNode[] = [];
  if (before.length > 0) {
    result.push({ ...list, items: before });
  }
  result.push(...inserted);
  if (after.length > 0) {
    const tail: ListNode = before.length > 0
      ? withListStart({ ...list, id: createId("list"), items: after }, listStart(list) + before.length)
      : { ...list, items: after };
    result.push(tail);
  }
  return result;
}

function wrapItemAsList(item: ListItemNode, source: ListNode): ListNode {
  const { start: _omit, ...rest } = source;
  void _omit;
  return { ...rest, id: createId("list"), items: [item] };
}

// ---------------------------------------------------------------------------------------------
// 段組: SigmaDoc が所有する独立列
// ---------------------------------------------------------------------------------------------

export function resolveExplicitColumns(section: LayoutSectionNode): AnyNode[][] {
  return getLayoutSectionColumns(section);
}

function withBreak(node: AnyNode, on: boolean): AnyNode {
  const current = (node as SigmaBlock).pagination?.break === true;
  if (current === on) {
    return node;
  }
  const block = node as SigmaBlock;
  const { break: _omit, ...restPagination } = block.pagination ?? {};
  void _omit;
  const pagination = on ? { ...restPagination, break: true } : restPagination;
  if (Object.keys(pagination).length === 0) {
    const { pagination: _drop, ...rest } = block;
    void _drop;
    return rest as AnyNode;
  }
  return { ...block, pagination } as AnyNode;
}

function withColumns(
  section: LayoutSectionNode,
  columns: readonly (readonly AnyNode[])[],
  widths: readonly number[] = getLayoutSectionColumnWidths(section, columns.length),
): LayoutSectionNode {
  return setLayoutSectionColumns(
    section,
    columns as readonly (readonly LayoutSectionNode["children"][number][])[],
    widths,
  );
}

function replaceNode(content: readonly AnyNode[], id: string, replacement: readonly AnyNode[]): readonly AnyNode[] {
  return mapTree(content, { kind: "content", ownerId: null }, (items) => {
    const position = items.findIndex((node) => node.id === id);
    if (position < 0) {
      return items;
    }
    return [...items.slice(0, position), ...replacement, ...items.slice(position + 1)];
  });
}

// ---------------------------------------------------------------------------------------------
// 取り出し
// ---------------------------------------------------------------------------------------------

interface Extraction {
  content: readonly AnyNode[];
  units: AnyNode[];
  syntheticIds: Set<string>;
  /** 取り出した入れ物 (リストの合流をやり直す相手)。 */
  sourceRefs: DragContainerRef[];
}

function extractUnits(content: readonly AnyNode[], ids: readonly string[]): Extraction | null {
  const units: AnyNode[] = [];
  const syntheticIds = new Set<string>();
  const sourceRefs: DragContainerRef[] = [];
  for (const id of ids) {
    const located = locate(content, id);
    if (!located) {
      return null;
    }
    sourceRefs.push(located.ref);
    const leavesLayoutSection = located.ref.kind === "layout";
    if (located.node.type === "listItem") {
      const list = located.ref.ownerId ? findNode(content, located.ref.ownerId) : null;
      if (!list || list.type !== "list") {
        return null;
      }
      const wrapped = wrapItemAsList(located.node, list);
      syntheticIds.add(wrapped.id);
      units.push(wrapped);
    } else {
      units.push(leavesLayoutSection ? withBreak(located.node, false) : located.node);
    }
  }
  const idSet = new Set(ids);
  const next = mapTree(content, { kind: "content", ownerId: null }, (items) => {
    const kept = items.filter((node) => !idSet.has(node.id));
    return kept.length === items.length ? items : kept;
  });
  return { content: next, units, syntheticIds, sourceRefs };
}

// ---------------------------------------------------------------------------------------------
// 差し込み
// ---------------------------------------------------------------------------------------------

function allAllowed(units: readonly AnyNode[], kind: DragContainerKind): boolean {
  return units.every((unit) => isTypeAllowedInContainer(kind, unitBlockType(unit)));
}

function insertAsSibling(
  content: readonly AnyNode[],
  anchorId: string,
  position: "before" | "after",
  units: readonly AnyNode[],
  syntheticIds: ReadonlySet<string>,
): readonly AnyNode[] | null {
  const located = locate(content, anchorId);
  if (!located) {
    return null;
  }

  if (located.node.type === "listItem") {
    // 項目の前後: リストを割って挟む。同じ種類のリスト (項目の包み) は合流して元に戻る。
    const listId = located.ref.ownerId;
    const listLocated = listId ? locate(content, listId) : null;
    if (!listLocated || listLocated.node.type !== "list") {
      return null;
    }
    const parentKind = listLocated.ref.kind;
    if (!units.every((unit) => unit.type === "list" || isTypeAllowedInContainer(parentKind, unitBlockType(unit)))) {
      return null;
    }
    if (parentKind === "nested" && !units.every((unit) => unit.type === "list")) {
      return null;
    }
    const list = listLocated.node;
    const pieces = splitListAround(list, located.index, position, units);
    return mapTree(content, { kind: "content", ownerId: null }, (items) => {
      const at = items.findIndex((node) => node.id === list.id);
      if (at < 0) {
        return items;
      }
      return coalesceAdjacentLists([...items.slice(0, at), ...pieces, ...items.slice(at + 1)], syntheticIds, { seam: new Set(units) });
    });
  }

  if (!allAllowed(units, located.ref.kind)) {
    return null;
  }
  if (located.ref.kind === "layout" && located.ref.ownerId) {
    const section = findNode(content, located.ref.ownerId);
    if (!section || section.type !== "layoutSection") {
      return null;
    }
    const columns = resolveExplicitColumns(section);
    const columnIndex = columns.findIndex((column) => column.some((child) => child.id === anchorId));
    if (columnIndex < 0) {
      return null;
    }
    const column = columns[columnIndex];
    const anchorIndex = column.findIndex((child) => child.id === anchorId);
    const cut = position === "before" ? anchorIndex : anchorIndex + 1;
    const nextColumns = columns.map((current, index) => index === columnIndex
      ? coalesceAdjacentLists([...current.slice(0, cut), ...units, ...current.slice(cut)], syntheticIds, { seam: new Set(units) })
      : current);
    return replaceNode(content, section.id, [withColumns(section, nextColumns)]);
  }
  return mapTree(content, { kind: "content", ownerId: null }, (items) => {
    const at = items.findIndex((node) => node.id === anchorId);
    if (at < 0) {
      return items;
    }
    const cut = position === "before" ? at : at + 1;
    return coalesceAdjacentLists([...items.slice(0, cut), ...units, ...items.slice(cut)], syntheticIds, { seam: new Set(units) });
  });
}

function newLayoutSection(
  columns: readonly (readonly AnyNode[])[],
  columnGapMm: number,
): LayoutSectionNode {
  const section: LayoutSectionNode = {
    type: "layoutSection",
    id: createId("layout_section"),
    layout: { columnCount: columns.length, columnGapMm: Math.max(0, columnGapMm) },
    children: [],
  };
  return withColumns(section, columns);
}

function insertAsNewColumns(
  content: readonly AnyNode[],
  anchorId: string,
  side: "left" | "right",
  units: readonly AnyNode[],
  syntheticIds: ReadonlySet<string>,
  columnGapMm: number,
): readonly AnyNode[] | null {
  const located = locate(content, anchorId);
  if (!located || !units.every((unit) => isColumnEligibleUnitType(unitBlockType(unit)))) {
    return null;
  }
  const unitColumn = coalesceAdjacentLists(units, syntheticIds);

  if (located.node.type === "listItem") {
    const listId = located.ref.ownerId;
    const listLocated = listId ? locate(content, listId) : null;
    if (!listLocated || listLocated.node.type !== "list" || !containerAllowsNewColumns(listLocated.ref.kind)) {
      return null;
    }
    const list = listLocated.node;
    const before = list.items.slice(0, located.index);
    const after = list.items.slice(located.index + 1);
    const isolated = withListStart(wrapItemAsList(located.node, list), listStart(list) + before.length);
    const section = newLayoutSection(
      side === "right" ? [[isolated], unitColumn] : [unitColumn, [isolated]],
      columnGapMm,
    );
    const pieces: AnyNode[] = [];
    if (before.length > 0) {
      pieces.push({ ...list, items: before });
    }
    pieces.push(section);
    if (after.length > 0) {
      pieces.push(before.length > 0
        ? withListStart({ ...list, id: createId("list"), items: after }, listStart(list) + before.length + 1)
        : withListStart({ ...list, items: after }, listStart(list) + 1));
    }
    return replaceNode(content, list.id, pieces);
  }

  if (!containerAllowsNewColumns(located.ref.kind) || !isColumnEligibleUnitType(located.node.type)) {
    return null;
  }
  const anchor = withBreak(located.node, false);
  const section = newLayoutSection(
    side === "right" ? [[anchor], unitColumn] : [unitColumn, [anchor]],
    columnGapMm,
  );
  // 段組の前の改ページは段組そのものが引き継ぐ。
  const carried = located.node.pagination?.break === true
    ? { ...section, pagination: { ...section.pagination, break: true } }
    : section;
  return replaceNode(content, anchorId, [carried]);
}

function insertIntoNewColumn(
  content: readonly AnyNode[],
  sectionId: string,
  anchorChildId: string,
  side: "left" | "right",
  units: readonly AnyNode[],
  syntheticIds: ReadonlySet<string>,
): readonly AnyNode[] | null {
  const section = findNode(content, sectionId);
  if (!section || section.type !== "layoutSection") {
    return null;
  }
  if (!units.every((unit) => isColumnEligibleUnitType(unitBlockType(unit)))) {
    return null;
  }
  const columns = resolveExplicitColumns(section);
  const anchorColumn = columns.findIndex((column) => column.some((child) => child.id === anchorChildId));
  if (anchorColumn < 0 || columns.length >= MAX_LAYOUT_SECTION_COLUMNS) {
    return null;
  }
  const at = side === "left" ? anchorColumn : anchorColumn + 1;
  const nextColumns = [...columns.slice(0, at), [...coalesceAdjacentLists(units, syntheticIds)], ...columns.slice(at)];
  const widths = getLayoutSectionColumnWidths(section, columns.length);
  const anchorWidth = widths[anchorColumn];
  const firstHalf = Math.max(1, Math.floor(anchorWidth / 2));
  const secondHalf = Math.max(1, anchorWidth - firstHalf);
  const splitWidths = side === "left" ? [firstHalf, secondHalf] : [secondHalf, firstHalf];
  const nextWidths = [
    ...widths.slice(0, anchorColumn),
    ...splitWidths,
    ...widths.slice(anchorColumn + 1),
  ];
  return replaceNode(content, sectionId, [withColumns(section, nextColumns, nextWidths)]);
}

function insertAtAreaEnd(
  content: readonly AnyNode[],
  problemId: string,
  area: ProblemAreaKind,
  units: readonly AnyNode[],
  syntheticIds: ReadonlySet<string>,
): readonly AnyNode[] | null {
  const problem = findNode(content, problemId);
  if (!problem || problem.type !== "problem" || !allAllowed(units, "problemArea")) {
    return null;
  }
  const blocks = coalesceAdjacentLists([...problem[area], ...units], syntheticIds, { seam: new Set(units) });
  return replaceNode(content, problemId, [{ ...problem, [area]: blocks }]);
}

// ---------------------------------------------------------------------------------------------
// 後始末
// ---------------------------------------------------------------------------------------------

interface SectionState {
  id: string;
  columnIds: string[][];
  widths: number[];
}

function sectionState(content: readonly AnyNode[], id: string): SectionState | null {
  const section = findNode(content, id);
  if (!section || section.type !== "layoutSection") {
    return null;
  }
  return {
    id,
    columnIds: resolveExplicitColumns(section).map((column) => column.map((child) => child.id)),
    widths: getLayoutSectionColumnWidths(section),
  };
}

/**
 * 取り出し直後に、消えた列先頭 id を更新する。ここでは一列になってもまだ解かない。
 * 同じ段組内への差し込みが後続する場合も、落とし先の列を失わないため。
 */
function restoreSectionColumns(
  content: readonly AnyNode[],
  before: readonly SectionState[],
): readonly AnyNode[] {
  let next = content;
  for (const previous of before) {
    const section = findNode(next, previous.id);
    if (!section || section.type !== "layoutSection") {
      continue;
    }
    const byId = new Map(section.children.map((child) => [child.id, child] as const));
    const columns = previous.columnIds.map((ids) => ids.flatMap((id) => {
      const child = byId.get(id);
      return child ? [child] : [];
    }));
    const populatedWidths = previous.widths.filter((_, index) => columns[index].length > 0);
    const populated = columns.filter((column) => column.length > 0);
    if (populated.length === 0) {
      next = replaceNode(next, section.id, []);
    } else {
      next = replaceNode(next, section.id, [withColumns(section, populated, populatedWidths)]);
    }
  }
  return next;
}

/** 空列を落とし、一列だけなら段組を解く。 */
function settleSections(content: readonly AnyNode[], sectionIds: ReadonlySet<string>): readonly AnyNode[] {
  let next = content;
  for (const sectionId of sectionIds) {
    const section = findNode(next, sectionId);
    if (!section || section.type !== "layoutSection") continue;
    const columns = resolveExplicitColumns(section).filter((column) => column.length > 0);
    if (columns.length <= 1) {
      next = replaceNode(next, section.id, (columns[0] ?? []).map((child) => withBreak(child, false)));
    } else {
      next = replaceNode(next, section.id, [withColumns(section, columns)]);
    }
  }
  return next;
}

function sameRef(a: DragContainerRef, b: DragContainerRef): boolean {
  return a.kind === b.kind && a.ownerId === b.ownerId && a.area === b.area;
}

/** 空のリストを落とし、取り出した入れ物では続き番号のリストを合流させ、空の枠を埋める。 */
function cleanup(
  content: readonly AnyNode[],
  sourceRefs: readonly DragContainerRef[],
  syntheticIds: ReadonlySet<string>,
): readonly AnyNode[] {
  return mapTree(content, { kind: "content", ownerId: null }, (items, ref) => {
    let next = items.filter((node) => !(node.type === "list" && node.items.length === 0));
    if (sourceRefs.some((source) => sameRef(source, ref))) {
      next = [...coalesceAdjacentLists(next, syntheticIds, { onlyContinuous: true })];
    }
    if ((ref.kind === "box" || ref.kind === "quote") && next.length === 0) {
      next = [createParagraph("")];
    }
    return sameItems(next, items) ? items : next;
  });
}

// ---------------------------------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------------------------------

function targetSectionId(content: readonly AnyNode[], target: BlockDropTarget): string | null {
  if (target.kind === "insertColumn") {
    return target.sectionId;
  }
  if (target.kind === "sibling") {
    const located = locate(content, target.anchorId);
    if (!located) {
      return null;
    }
    if (located.ref.kind === "layout") {
      return located.ref.ownerId;
    }
    if (located.node.type === "listItem" && located.ref.ownerId) {
      const list = locate(content, located.ref.ownerId);
      return list?.ref.kind === "layout" ? list.ref.ownerId : null;
    }
  }
  return null;
}

function isTargetInsideUnits(index: Map<string, DragUnitInfo>, unitIds: readonly string[], target: BlockDropTarget): boolean {
  const set = new Set(unitIds);
  const anchorId = target.kind === "sibling" || target.kind === "newColumns"
    ? target.anchorId
    : target.kind === "insertColumn" ? target.anchorChildId : target.problemId;
  const info = index.get(anchorId);
  if (!info) {
    return true;
  }
  return set.has(anchorId) || info.ancestors.some((ancestor) => set.has(ancestor));
}

function isSiblingNoop(content: readonly AnyNode[], unitIds: readonly string[], target: BlockDropTarget): boolean {
  if (target.kind !== "sibling") return false;
  const anchor = locate(content, target.anchorId);
  if (!anchor || unitIds.includes(target.anchorId)) return false;
  const located = unitIds.map((id) => locate(content, id));
  if (located.some((item) => !item || !sameRef(item.ref, anchor.ref))) return false;
  const moving = new Set(unitIds);
  const remaining = anchor.siblings.filter((item) => !moving.has(item.id));
  const anchorIndex = remaining.findIndex((item) => item.id === target.anchorId);
  if (anchorIndex < 0) return false;
  const byId = new Map(anchor.siblings.map((item) => [item.id, item] as const));
  const units = unitIds.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
  const cut = target.position === "before" ? anchorIndex : anchorIndex + 1;
  const reordered = [...remaining.slice(0, cut), ...units, ...remaining.slice(cut)];
  return sameItems(reordered, anchor.siblings);
}

/** 落とせるか。UI は落とし先の線を出す前にこれを通す。 */
export function canDropUnits(
  document: SigmaDocument,
  unitIds: readonly string[],
  target: BlockDropTarget,
): boolean {
  const ids = normalizeDragUnitIds(document.content, unitIds);
  if (ids.length === 0) {
    return false;
  }
  const index = indexNodes(document.content, true);
  if (isTargetInsideUnits(index, ids, target)) {
    return false;
  }
  const types = ids.map((id) => {
    const type = index.get(id)!.type;
    return type === "listItem" ? "list" : type;
  });

  switch (target.kind) {
    case "sibling": {
      const anchor = index.get(target.anchorId);
      if (!anchor) {
        return false;
      }
      if (anchor.type === "listItem") {
        const list = anchor.container.ownerId ? locate(document.content, anchor.container.ownerId) : null;
        if (!list) {
          return false;
        }
        return types.every((type) => type === "list" || isTypeAllowedInContainer(list.ref.kind, type));
      }
      return types.every((type) => isTypeAllowedInContainer(anchor.container.kind, type));
    }
    case "newColumns": {
      const anchor = index.get(target.anchorId);
      if (!anchor || !types.every(isColumnEligibleUnitType) || !isColumnEligibleUnitType(anchor.type)) {
        return false;
      }
      if (anchor.type === "listItem") {
        const list = anchor.container.ownerId ? locate(document.content, anchor.container.ownerId) : null;
        return !!list && containerAllowsNewColumns(list.ref.kind);
      }
      return containerAllowsNewColumns(anchor.container.kind);
    }
    case "insertColumn": {
      const section = findNode(document.content, target.sectionId);
      const anchor = index.get(target.anchorChildId);
      if (!section || section.type !== "layoutSection" || !anchor || anchor.container.ownerId !== target.sectionId) {
        return false;
      }
      if (!types.every(isColumnEligibleUnitType)) {
        return false;
      }
      // 取り出しで空く段があっても、上限は「取り出す前の段数 + 1」で見ておく (安全側)。
      const columns = resolveExplicitColumns(section);
      const remaining = columns.filter((column) => column.some((child) => !ids.includes(child.id))).length;
      return remaining + 1 <= MAX_LAYOUT_SECTION_COLUMNS;
    }
    case "areaEnd": {
      const problem = findNode(document.content, target.problemId);
      return !!problem && problem.type === "problem" && types.every((type) => isTypeAllowedInContainer("problemArea", type));
    }
    default:
      return false;
  }
}

/**
 * 掴んだ単位を落とし先へ動かす。無効な要求・何も変わらない要求では **同じ文書** を返す
 * (呼び出し側は参照比較で「動いたか」を知る)。
 */
export function moveBlocksByDrag(document: SigmaDocument, request: BlockDragMoveRequest): SigmaDocument {
  const ids = normalizeDragUnitIds(document.content, request.unitIds);
  if (ids.length === 0 || !canDropUnits(document, ids, request.target)) {
    return document;
  }
  if (isSiblingNoop(document.content, ids, request.target)) return document;
  const { target } = request;
  const columnGapMm = document.pageLayout?.flow.columnGapMm ?? 8;

  let content: readonly AnyNode[] = document.content;

  // 1. 触る段組の列所属を、取り出し前に記録する。
  const index = indexDragUnits(document.content);
  const touchedSectionIds = new Set<string>();
  for (const id of ids) {
    const info = index.get(id)!;
    if (info.container.kind === "layout" && info.container.ownerId) {
      touchedSectionIds.add(info.container.ownerId);
    } else if (info.type === "listItem" && info.container.ownerId) {
      const listLocated = locate(document.content, info.container.ownerId);
      if (listLocated?.ref.kind === "layout" && listLocated.ref.ownerId) {
        touchedSectionIds.add(listLocated.ref.ownerId);
      }
    }
  }
  const targetSection = targetSectionId(content, target);
  if (targetSection) {
    touchedSectionIds.add(targetSection);
  }
  const sectionStates = [...touchedSectionIds]
    .map((sectionId) => sectionState(content, sectionId))
    .filter((state): state is SectionState => state !== null);

  // 2. 取り出す。
  const extraction = extractUnits(content, ids);
  if (!extraction) {
    return document;
  }
  content = extraction.content;
  const { units, syntheticIds, sourceRefs } = extraction;
  content = restoreSectionColumns(content, sectionStates);

  // 3. 差し込む。
  let inserted: readonly AnyNode[] | null;
  switch (target.kind) {
    case "sibling":
      inserted = insertAsSibling(content, target.anchorId, target.position, units, syntheticIds);
      break;
    case "newColumns":
      inserted = insertAsNewColumns(content, target.anchorId, target.side, units, syntheticIds, columnGapMm);
      break;
    case "insertColumn":
      inserted = insertIntoNewColumn(content, target.sectionId, target.anchorChildId, target.side, units, syntheticIds);
      break;
    case "areaEnd":
      inserted = insertAtAreaEnd(content, target.problemId, target.area, units, syntheticIds);
      break;
    default:
      inserted = null;
  }
  if (!inserted) {
    return document;
  }
  content = inserted;

  // 4. 後始末。
  content = settleSections(content, touchedSectionIds);
  content = cleanup(content, sourceRefs, syntheticIds);

  if (content === document.content) {
    return document;
  }
  return { ...document, content: content as SigmaBlock[] };
}

/**
 * ⌥⇧↑/↓: 先頭 (末尾) の単位の前 (後ろ) の兄弟と入れ替える。入れ物の端では外へ出る。
 * リストの端では「リストの前 (後ろ) の兄弟」を飛び越える — リストのすぐ外へ出すと合流して
 * 何も起きないため。
 */
export function moveUnitsByStep(
  document: SigmaDocument,
  unitIds: readonly string[],
  direction: "up" | "down",
): SigmaDocument {
  const ids = normalizeDragUnitIds(document.content, unitIds);
  if (ids.length === 0) {
    return document;
  }
  const idSet = new Set(ids);
  const edgeId = direction === "up" ? ids[0] : ids[ids.length - 1];
  const swappedInColumns = swapWithinColumns(document, ids, direction);
  if (swappedInColumns) {
    return swappedInColumns;
  }
  const target = resolveStepTarget(document.content, edgeId, direction, idSet);
  if (!target) {
    return document;
  }
  const request: BlockDragMoveRequest = { unitIds: ids, target };
  return moveBlocksByDrag(document, request);
}

/**
 * 段組の中では、同じ独立列の兄弟だけを入れ替える。列の端では null (外へ出る)。
 */
function swapWithinColumns(document: SigmaDocument, ids: readonly string[], direction: "up" | "down"): SigmaDocument | null {
  const edgeId = direction === "up" ? ids[0] : ids[ids.length - 1];
  const located = locate(document.content, edgeId);
  if (!located || located.ref.kind !== "layout" || !located.ref.ownerId) {
    return null;
  }
  const section = findNode(document.content, located.ref.ownerId);
  if (!section || section.type !== "layoutSection" || section.layout.columnCount <= 1) {
    return null;
  }
  const idSet = new Set(ids);
  if (!ids.every((id) => section.children.some((child) => child.id === id))) {
    return null;
  }
  const columns = resolveExplicitColumns(section);
  const columnIndex = columns.findIndex((column) => column.some((child) => child.id === edgeId));
  if (columnIndex < 0 || !ids.every((id) => columns[columnIndex].some((child) => child.id === id))) return null;
  const column = columns[columnIndex];
  const others = column.filter((child) => !idSet.has(child.id));
  const moving = column.filter((child) => idSet.has(child.id));
  const edgeIndex = column.findIndex((child) => child.id === edgeId);
  let neighborIndex = direction === "up" ? edgeIndex - 1 : edgeIndex + 1;
  while (neighborIndex >= 0 && neighborIndex < column.length && idSet.has(column[neighborIndex].id)) {
    neighborIndex += direction === "up" ? -1 : 1;
  }
  if (neighborIndex < 0 || neighborIndex >= column.length) {
    return null;
  }
  const neighbor = column[neighborIndex];
  const at = others.findIndex((child) => child.id === neighbor.id) + (direction === "up" ? 0 : 1);
  const reordered = [...others.slice(0, at), ...moving, ...others.slice(at)];
  const nextColumns = columns.map((current, index) => index === columnIndex ? reordered : current);
  const content = replaceNode(document.content, section.id, [withColumns(section, nextColumns)]);
  return { ...document, content: content as SigmaBlock[] };
}

function resolveStepTarget(
  content: readonly AnyNode[],
  id: string,
  direction: "up" | "down",
  moving: ReadonlySet<string>,
): BlockDropTarget | null {
  const located = locate(content, id);
  if (!located) {
    return null;
  }
  const siblings = located.siblings;
  let neighborIndex = direction === "up" ? located.index - 1 : located.index + 1;
  while (neighborIndex >= 0 && neighborIndex < siblings.length && moving.has(siblings[neighborIndex].id)) {
    neighborIndex += direction === "up" ? -1 : 1;
  }
  const neighbor = siblings[neighborIndex] as AnyNode | undefined;
  if (neighbor) {
    if (neighbor.type === "list" && located.node.type !== "listItem") {
      // リストを飛び越えるのではなく、その端の項目の隣へ (項目の間に入る)。
      const items = neighbor.items;
      const edgeItem = direction === "up" ? items[items.length - 1] : items[0];
      return edgeItem
        ? { kind: "sibling", anchorId: edgeItem.id, position: direction === "up" ? "before" : "after" }
        : null;
    }
    return { kind: "sibling", anchorId: neighbor.id, position: direction === "up" ? "before" : "after" };
  }

  // 入れ物の端: 外へ出る。
  const ownerId = located.ref.ownerId;
  if (!ownerId) {
    return null;
  }
  if (located.ref.kind === "list") {
    const list = locate(content, ownerId);
    if (!list) {
      return null;
    }
    let beyondIndex = direction === "up" ? list.index - 1 : list.index + 1;
    while (beyondIndex >= 0 && beyondIndex < list.siblings.length && moving.has(list.siblings[beyondIndex].id)) {
      beyondIndex += direction === "up" ? -1 : 1;
    }
    const beyond = list.siblings[beyondIndex] as AnyNode | undefined;
    if (beyond) {
      return { kind: "sibling", anchorId: beyond.id, position: direction === "up" ? "before" : "after" };
    }
    if (!list.ref.ownerId) {
      return null;
    }
    return { kind: "sibling", anchorId: list.ref.ownerId, position: direction === "up" ? "before" : "after" };
  }
  return { kind: "sibling", anchorId: ownerId, position: direction === "up" ? "before" : "after" };
}
