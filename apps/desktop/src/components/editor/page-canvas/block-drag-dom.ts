/**
 * ブロックのドラッグの DOM 側: ポインタの下の単位を拾い、箱を測り、ゴーストを作る。
 *
 * 判断はしない — 「どこへ落とすか」は `block-drag-target.ts`、「文書をどう書き換えるか」は
 * `lib/block-drag-move.ts`。ここは紙面の DOM から実測を集めて、その 2 つへ渡す形に整えるだけ。
 *
 * 全文書を測ることはしない (ページ割りのたびに古くなる)。ポインタの下の 1 単位と、その祖先、
 * 落とし先が段組ならその段だけを、その場で測る。座標はすべて紙面のレイアウト px。
 */

import { emptyProblemAreaEditorBlockId } from "@/features/rendering/core";
import { isProblemAreaKind } from "@/features/text-editing";
import type { ProblemAreaKind, SigmaDocument } from "@/features/document";
import { findBlock } from "@/lib/document-tree";
import type { DragContainerKind, DragUnitInfo } from "@/lib/block-drag-move";

import { type DragBox, type DragHit, type DragHitAncestor } from "./block-drag-target";
import { visibleBlockClientRect } from "./visible-block-rect";
import { resolveInnerLaneProbe } from "./block-affordances";

/** ドラッグ中だけ紙面に載る層。ポインタの下に居ても本文ではない。 */
const DRAG_CHROME_SELECTOR = ".page-block-drag-ghost-layer, .page-block-affordance-layer";
const PROBLEM_AREA_SELECTOR = "[data-problem-id][data-problem-area]";
/** 隙間から上下へ伸ばして拾う距離 (画面 px 換算前のレイアウト px)。 */
const GAP_PROBE_PX = 14;
/** ゴーストに載せる単位の上限。掴んだのが 10 個でも重さは一定にする。 */
const GHOST_UNIT_LIMIT = 3;

export interface DragUnitGeometry {
  elements: HTMLElement[];
  box: DragBox;
  ownBox: DragBox;
  hasVisibleEnd?: boolean;
}

export interface DragIndex {
  units: Map<string, DragUnitInfo>;
  /** リスト自身も含む索引。落とし先の anchor と、項目の入れ物の判定に使う。 */
  anchors: Map<string, DragUnitInfo>;
}

export interface DescendantHoverCandidate {
  id: string;
  ancestors: readonly string[];
  order: number;
  left: number;
  right: number;
}

/**
 * Walk one ancestry branch at a time. Equal-distance gaps belong to the branch on their right,
 * matching the column-lane rule used by the visible gutter controls.
 */
export function resolveDeepestDescendantHoverCandidate(
  ownerId: string,
  candidates: readonly DescendantHoverCandidate[],
  x: number,
): string | null {
  let branchOwnerId = ownerId;
  let branchCandidates = [...candidates];
  while (true) {
    const branches = new Map<string, DescendantHoverCandidate[]>();
    for (const candidate of branchCandidates) {
      const chain = [...candidate.ancestors, candidate.id];
      const ownerIndex = chain.indexOf(branchOwnerId);
      const branchId = chain[ownerIndex + 1];
      if (!branchId) continue;
      const branch = branches.get(branchId) ?? [];
      branch.push(candidate);
      branches.set(branchId, branch);
    }
    if (branches.size === 0) break;
    const chosen = [...branches.entries()].sort(([leftId, left], [rightId, right]) => {
      const score = (branchId: string, items: readonly DescendantHoverCandidate[]) => {
        const immediate = items.find((candidate) => candidate.id === branchId)
          ?? items.reduce((best, item) => {
            const bestDistance = horizontalDistanceToEdges(best.left, best.right, x);
            const itemDistance = horizontalDistanceToEdges(item.left, item.right, x);
            return itemDistance < bestDistance || (itemDistance === bestDistance && item.left > best.left)
              ? item
              : best;
          });
        return [horizontalDistanceToEdges(immediate.left, immediate.right, x), immediate.left, immediate.order] as const;
      };
      const a = score(leftId, left);
      const b = score(rightId, right);
      return a[0] - b[0] || b[1] - a[1] || a[2] - b[2];
    })[0];
    branchOwnerId = chosen[0];
    branchCandidates = chosen[1];
  }
  return branchCandidates.sort((a, b) => (
    b.ancestors.length - a.ancestors.length
    || horizontalDistanceToEdges(a.left, a.right, x) - horizontalDistanceToEdges(b.left, b.right, x)
    || b.left - a.left
    || a.order - b.order
  ))[0]?.id ?? null;
}

function horizontalDistanceToEdges(left: number, right: number, x: number): number {
  if (x < left) return left - x;
  if (x > right) return x - right;
  return 0;
}

export function canvasLayoutScale(canvas: HTMLElement): number {
  const width = canvas.getBoundingClientRect().width;
  return canvas.offsetWidth > 0 && width > 0 ? width / canvas.offsetWidth : 1;
}

export function toCanvasPoint(canvas: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const scale = canvasLayoutScale(canvas);
  return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
}

function unionBox(canvas: HTMLElement, elements: readonly HTMLElement[]): DragBox | null {
  const canvasRect = canvas.getBoundingClientRect();
  const scale = canvasLayoutScale(canvas);
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const element of elements) {
    const rect = visibleBlockClientRect(element);
    if (!rect) {
      continue;
    }
    top = Math.min(top, rect.top);
    bottom = Math.max(bottom, rect.bottom);
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
  }
  if (top === Number.POSITIVE_INFINITY) {
    return null;
  }
  return {
    top: (top - canvasRect.top) / scale,
    bottom: (bottom - canvasRect.top) / scale,
    left: (left - canvasRect.left) / scale,
    right: (right - canvasRect.left) / scale,
  };
}

/** The list element (`ul` / `ol`) that draws a list item's marker, if the item has one. */
function listElementOf(item: HTMLElement): HTMLElement | null {
  const parent = item.parentElement;
  return parent && (parent.tagName === "UL" || parent.tagName === "OL") ? parent : null;
}

/**
 * Canvas-px left edge of the list that owns `item` — where the marker (•, ○, 数字) starts.
 * Null when the item is not inside a list element or the list has no layout box yet.
 */
function listAffordanceLeft(canvas: HTMLElement, item: HTMLElement): number | null {
  const list = listElementOf(item);
  const rect = list?.getBoundingClientRect();
  if (!list || !rect || (rect.width === 0 && rect.height === 0)) {
    return null;
  }
  return (rect.left - canvas.getBoundingClientRect().left) / canvasLayoutScale(canvas);
}

function liveElements(canvas: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(canvas.querySelectorAll<HTMLElement>(selector))
    .filter((element) => !element.closest(DRAG_CHROME_SELECTOR));
}

function blockElements(canvas: HTMLElement, id: string): HTMLElement[] {
  return liveElements(canvas, `[data-sigma-doc-id="${CSS.escape(id)}"]`);
}

/**
 * 単位の要素と箱。リスト項目は `data-sigma-doc-id` を持つ段落の親 `li` (入れ子ごと) が見た目の箱、
 * 段落自身が自分の行。問題はエリア要素の合併。
 */
export function measureDragUnit(canvas: HTMLElement, id: string, type: string, clientY?: number): DragUnitGeometry | null {
  if (type === "problem") {
    const elements = liveElements(canvas, `[data-problem-id="${CSS.escape(id)}"]`);
    const box = unionBox(canvas, elements);
    return box ? { elements, box, ownBox: box } : null;
  }
  // Each copy is a separate visible region. Never union the hidden source with a continuation.
  const candidates = blockElements(canvas, id).filter((element) => visibleBlockClientRect(element));
  candidates.sort((a, b) => {
    const distance = (element: HTMLElement) => {
      const rect = visibleBlockClientRect(element)!;
      return clientY === undefined ? 0 : Math.max(rect.top - clientY, clientY - rect.bottom, 0);
    };
    return distance(a) - distance(b);
  });
  const chosen = candidates[0];
  const viewport = chosen?.closest(".editor-box-fragment-viewport") ?? null;
  const own = candidates.filter((element) => (element.closest(".editor-box-fragment-viewport") ?? null) === viewport);
  if (own.length === 0) {
    return null;
  }
  if (type === "listItem") {
    const item = own[0].closest<HTMLElement>("li") ?? own[0];
    const box = unionBox(canvas, [item]);
    // The item's adjustable edge sits after every Shift+Enter continuation but before a nested
    // list. Those continuations are direct list-item children with their own ids; the nested list
    // carries an id too, so it has to be excluded explicitly — otherwise the parent's own row
    // stretches over its children and the `>--` lands under the whole list.
    const ownElements = item === own[0]
      ? own
      : Array.from(item.querySelectorAll<HTMLElement>(":scope > [data-sigma-doc-id]"))
        .filter((element) => element.tagName !== "UL" && element.tagName !== "OL");
    const ownBox = unionBox(canvas, ownElements.length > 0 ? ownElements : own);
    if (!box || !ownBox) {
      return null;
    }
    // Affordances (grip, `>--`) hang off the row's left edge. For a list item that edge is the
    // list's own left (the marker box), not the paragraph's — the paragraph starts after the
    // marker, so anchoring there draws the grip on top of the bullet.
    const listLeft = listAffordanceLeft(canvas, item);
    return { elements: [item], box, hasVisibleEnd: visibleEnd(canvas, ownElements.length > 0 ? ownElements : own, ownBox), ownBox: listLeft === null ? ownBox : { ...ownBox, left: Math.min(ownBox.left, listLeft) } };
  }
  const box = unionBox(canvas, own);
  return box ? { elements: own, box, ownBox: box, hasVisibleEnd: visibleEnd(canvas, own, box) } : null;
}

function visibleEnd(canvas: HTMLElement, elements: readonly HTMLElement[], box: DragBox): boolean {
  const bottom = Math.max(...elements.map((element) => element.getBoundingClientRect().bottom));
  return bottom <= canvas.getBoundingClientRect().top + box.bottom * canvasLayoutScale(canvas) + 0.5;
}

/** Selection follows every visible piece, without outlining the empty inter-page gap. */
export function measureDragUnitPieces(canvas: HTMLElement, id: string, type: string): DragUnitGeometry[] {
  if (type === "problem") {
    const geometry = measureDragUnit(canvas, id, type);
    return geometry ? [geometry] : [];
  }
  const seen = new Set<string>();
  return blockElements(canvas, id).flatMap((element) => {
    const rect = visibleBlockClientRect(element);
    if (!rect) return [];
    const geometry = measureDragUnit(canvas, id, type, (rect.top + rect.bottom) / 2);
    if (!geometry) return [];
    const key = JSON.stringify(geometry.box);
    if (seen.has(key)) return [];
    seen.add(key);
    return [geometry];
  });
}

function readProblemArea(element: Element): { problemId: string; area: ProblemAreaKind } | null {
  const host = element.closest<HTMLElement>(PROBLEM_AREA_SELECTOR);
  const problemId = host?.getAttribute("data-problem-id");
  const area = host?.getAttribute("data-problem-area") ?? null;
  return host && problemId && isProblemAreaKind(area) ? { problemId, area } : null;
}

/** リスト要素の中で、ポインタの高さに一番近い項目の id。 */
function itemIdNearY(list: HTMLElement, clientY: number): string | null {
  let best: { id: string; distance: number } | null = null;
  for (const item of Array.from(list.children)) {
    if (!(item instanceof HTMLElement) || item.tagName !== "LI") {
      continue;
    }
    const own = item.querySelector<HTMLElement>(":scope > [data-sigma-doc-id]");
    const id = own?.getAttribute("data-sigma-doc-id");
    if (!id) {
      continue;
    }
    const rect = visibleBlockClientRect(item);
    if (!rect) continue;
    const distance = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
    if (!best || distance < best.distance) {
      best = { id, distance };
    }
  }
  return best?.id ?? null;
}

export interface ListItemAffordanceProbe {
  probeX: number;
  laneLeft: number;
}

/**
 * Resolve a gutter probe against the deepest list item whose own body row contains the pointer Y.
 *
 * An `li` rectangle includes its nested lists, so using that rectangle makes the parent item win
 * over every nested row. Direct non-list children are the item's owned body (leading paragraph and
 * continuations), matching `measureDragUnit`'s `ownBox` boundary.
 */
export function resolveListItemAffordanceProbe(
  editor: HTMLElement,
  clientX: number,
  clientY: number,
): ListItemAffordanceProbe | null {
  const candidates = Array.from(editor.querySelectorAll<HTMLElement>("li")).flatMap((item) => {
    const owned = Array.from(item.children).filter((child): child is HTMLElement => (
      child instanceof HTMLElement && child.tagName !== "UL" && child.tagName !== "OL"
    ));
    if (owned.length === 0) return [];
    const rects = owned.map((child) => visibleBlockClientRect(child)).filter((rect): rect is DOMRect => rect !== null);
    if (rects.length === 0) return [];
    const rect = rects.reduce<{ top: number; bottom: number; left: number; right: number }>((union, current) => ({
      top: Math.min(union.top, current.top),
      bottom: Math.max(union.bottom, current.bottom),
      left: Math.min(union.left, current.left),
      right: Math.max(union.right, current.right),
    }), {
      top: Number.POSITIVE_INFINITY,
      bottom: Number.NEGATIVE_INFINITY,
      left: Number.POSITIVE_INFINITY,
      right: Number.NEGATIVE_INFINITY,
    });
    // Treat adjacent rows as half-open intervals so their shared edge belongs to the next row.
    if (clientY < rect.top || clientY >= rect.bottom) return [];
    let depth = 0;
    for (let ancestor = item.parentElement?.closest("li"); ancestor && editor.contains(ancestor); ancestor = ancestor.parentElement?.closest("li")) {
      depth += 1;
    }
    const distance = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
    // The lane's left edge is the list's own left (marker box), so the grip and `>--` sit
    // left of the bullet instead of on top of it. Fall back to the row when the list has no box.
    const listRect = listElementOf(item)?.getBoundingClientRect();
    const laneLeft = listRect && (listRect.width > 0 || listRect.height > 0)
      ? Math.min(listRect.left, rect.left)
      : rect.left;
    return [{ rect, depth, distance, laneLeft }];
  });
  candidates.sort((a, b) => a.distance - b.distance || b.depth - a.depth);
  const match = candidates[0];
  return match
    ? {
        probeX: match.rect.left + Math.min(8, (match.rect.right - match.rect.left) / 2),
        laneLeft: match.laneLeft,
      }
    : null;
}

/** 問題エリアの要素の中で、ポインタの高さに一番近いブロック。 */
function areaBlockIdNearY(area: HTMLElement, clientY: number, index: DragIndex): string | null {
  let best: { id: string; distance: number } | null = null;
  for (const element of Array.from(area.querySelectorAll<HTMLElement>(".ProseMirror > [data-sigma-doc-id]"))) {
    const id = element.getAttribute("data-sigma-doc-id");
    if (!id || !index.units.has(id)) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    const distance = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
    if (!best || distance < best.distance) {
      best = { id, distance };
    }
  }
  return best?.id ?? null;
}

type RawHit =
  | { kind: "unit"; id: string }
  | { kind: "area"; problemId: string; area: ProblemAreaKind };

/**
 * ポインタの下の単位。**紙面の chrome を透かして** 一番内側の `[data-sigma-doc-id]` を採る
 * (箱の中の段落なら箱ではなく段落)。紙面の外の何か (ダイアログ) が覆っていれば null。
 */
function rawHitAt(
  canvas: HTMLElement,
  document: SigmaDocument,
  index: DragIndex,
  clientX: number,
  clientY: number,
  options: {
    /**
     * 問題の chrome (番号・サイドノート・枠の余白) の上では問題そのものにする。ホバー用 —
     * そこにグリップが出れば問題ごと掴める。落とし先の解決では false (chrome の近くの
     * ブロックの前後に落とす)。
     */
    chromeResolvesToProblem?: boolean;
  } = {},
): RawHit | null {
  for (const target of canvas.ownerDocument.elementsFromPoint(clientX, clientY)) {
    if (!canvas.contains(target)) {
      if (target.contains(canvas)) {
        continue;
      }
      return null;
    }
    if (target.closest(DRAG_CHROME_SELECTOR)) {
      continue;
    }
    const element = target.closest<HTMLElement>("[data-sigma-doc-id]");
    if (element) {
      const id = element.getAttribute("data-sigma-doc-id") ?? "";
      if (index.units.has(id)) {
        return { kind: "unit", id };
      }
      if (element.tagName === "UL" || element.tagName === "OL") {
        const itemId = itemIdNearY(element, clientY);
        if (itemId && index.units.has(itemId)) {
          return { kind: "unit", id: itemId };
        }
      }
      const area = readProblemArea(element);
      if (area && id === emptyProblemAreaEditorBlockId(area.problemId, area.area)) {
        return { kind: "area", ...area };
      }
      continue;
    }
    const area = readProblemArea(target);
    if (area) {
      const problem = findBlock(document, area.problemId);
      if (problem?.type === "problem") {
        if (problem[area.area].length === 0) {
          return { kind: "area", ...area };
        }
        if (options.chromeResolvesToProblem) {
          return { kind: "unit", id: area.problemId };
        }
        const host = target.closest<HTMLElement>(PROBLEM_AREA_SELECTOR);
        const nearest = host ? areaBlockIdNearY(host, clientY, index) : null;
        return nearest ? { kind: "unit", id: nearest } : { kind: "unit", id: area.problemId };
      }
    }
  }
  return null;
}

function nearestColumnSection(
  document: SigmaDocument,
  info: DragUnitInfo,
): { id: string; childId: string } | null {
  const chain = [...info.ancestors, info.id];
  for (let depth = chain.length - 2; depth >= 0; depth -= 1) {
    const block = findBlock(document, chain[depth]);
    if (block?.type === "layoutSection") {
      return block.layout.columnCount > 1 ? { id: block.id, childId: chain[depth + 1] } : null;
    }
  }
  return null;
}

function measureSectionChildren(
  canvas: HTMLElement,
  document: SigmaDocument,
  sectionId: string,
): { id: string; box: DragBox }[] {
  const section = findBlock(document, sectionId);
  if (section?.type !== "layoutSection") {
    return [];
  }
  const measured: { id: string; box: DragBox }[] = [];
  for (const child of section.children) {
    const box = unionBox(canvas, blockElements(canvas, child.id));
    if (box) {
      measured.push({ id: child.id, box });
    }
  }
  return measured;
}

function columnBoxOf(children: readonly { id: string; box: DragBox }[], childId: string): DragBox | null {
  const anchor = children.find((child) => child.id === childId);
  if (!anchor) {
    return null;
  }
  const column = children.filter((child) => Math.abs(child.box.left - anchor.box.left) <= 4);
  return column.reduce<DragBox>((acc, child) => ({
    top: Math.min(acc.top, child.box.top),
    bottom: Math.max(acc.bottom, child.box.bottom),
    left: Math.min(acc.left, child.box.left),
    right: Math.max(acc.right, child.box.right),
  }), { ...anchor.box });
}

function buildAncestors(canvas: HTMLElement, index: DragIndex, info: DragUnitInfo, clientY: number): DragHitAncestor[] {
  const ancestors: DragHitAncestor[] = [];
  for (const id of [...info.ancestors].reverse()) {
    const ancestor = index.anchors.get(id);
    if (!ancestor) {
      continue;
    }
    const geometry = measureDragUnit(canvas, id, ancestor.type, clientY);
    if (geometry) {
      ancestors.push({ id, box: geometry.box });
    }
  }
  return ancestors;
}

function toDragHit(
  canvas: HTMLElement,
  document: SigmaDocument,
  index: DragIndex,
  raw: RawHit,
  gapEdge: "top" | "bottom" | null,
  clientY: number,
): DragHit | null {
  if (raw.kind === "area") {
    const host = liveElements(canvas, `[data-problem-id="${CSS.escape(raw.problemId)}"][data-problem-area="${raw.area}"]`);
    const box = unionBox(canvas, host);
    return box ? { kind: "area", problemId: raw.problemId, area: raw.area, box } : null;
  }
  const info = index.units.get(raw.id);
  if (!info) {
    return null;
  }
  const geometry = measureDragUnit(canvas, raw.id, info.type, clientY);
  if (!geometry) {
    return null;
  }
  const section = nearestColumnSection(document, info);
  const columnBox = section ? columnBoxOf(measureSectionChildren(canvas, document, section.id), section.childId) : null;
  const listContainerKind: DragContainerKind | undefined = info.type === "listItem" && info.container.ownerId
    ? index.anchors.get(info.container.ownerId)?.container.kind
    : undefined;
  return {
    kind: "unit",
    id: raw.id,
    type: info.type,
    box: geometry.box,
    ownBox: geometry.ownBox,
    containerKind: info.container.kind,
    isFirstInContainer: info.index === 0,
    isLastInContainer: info.index === info.siblingCount - 1,
    ancestors: buildAncestors(canvas, index, info, clientY),
    section: section && columnBox ? { ...section, columnBox } : null,
    listContainerKind,
    gapEdge,
  };
}

/** ホバー用: ポインタの下の掴む単位の id と箱。落とし先の解決ほどの情報は要らない。 */
export function resolveHoverDragUnitAt(
  canvas: HTMLElement,
  document: SigmaDocument,
  index: DragIndex,
  clientX: number,
  clientY: number,
): {
  id: string;
  box: DragBox;
  ownBox: DragBox;
  insideProblemArea: boolean;
  resolvedFromContainer: boolean;
  hasVisibleEnd?: boolean;
} | null {
  const raw = rawHitAt(canvas, document, index, clientX, clientY, { chromeResolvesToProblem: true });
  if (!raw || raw.kind !== "unit") {
    return null;
  }
  const info = index.units.get(raw.id);
  const geometry = info ? measureDragUnit(canvas, raw.id, info.type, clientY) : null;
  if (!info || !geometry) {
    return null;
  }
  const descendant = (
    info.type === "boxBlock" || info.type === "problem" || info.type === "layoutSection" || info.type === "listItem"
  )
    ? resolveDescendantHoverUnitAt(canvas, index, info.id, geometry, clientX, clientY)
    : null;
  if (descendant) {
    return descendant;
  }
  const insideProblemArea = info.type !== "problem"
    && info.ancestors.some((ancestorId) => index.anchors.get(ancestorId)?.type === "problem");
  return { id: raw.id, box: geometry.box, ownBox: geometry.ownBox, insideProblemArea, resolvedFromContainer: false, hasVisibleEnd: geometry.hasVisibleEnd };
}

const CONTAINER_TOP_BAND_PX = 6;

/**
 * Container chrome may be the topmost hit even over its editable body. Below its first child,
 * choose the deepest same-row unit. The first-child edge (or at least 6px) remains owned by the
 * box/problem/section itself, so the container still has a stable drag target.
 */
function resolveDescendantHoverUnitAt(
  canvas: HTMLElement,
  index: DragIndex,
  ownerId: string,
  ownerGeometry: DragUnitGeometry,
  clientX: number,
  clientY: number,
): {
  id: string;
  box: DragBox;
  ownBox: DragBox;
  insideProblemArea: boolean;
  resolvedFromContainer: boolean;
  hasVisibleEnd?: boolean;
} | null {
  const point = toCanvasPoint(canvas, clientX, clientY);
  const candidates = Array.from(index.units.values()).flatMap((candidate) => {
    if (!candidate.ancestors.includes(ownerId)) return [];
    const geometry = measureDragUnit(canvas, candidate.id, candidate.type, clientY);
    if (!geometry || point.y < geometry.ownBox.top || point.y >= geometry.ownBox.bottom) return [];
    return [{ candidate, geometry }];
  });
  if (candidates.length === 0) return null;
  const firstChildTop = Math.min(...candidates.map(({ geometry }) => geometry.ownBox.top));
  const innerStart = Math.max(ownerGeometry.box.top + CONTAINER_TOP_BAND_PX, firstChildTop);
  if (point.y < innerStart) return null;
  const matchId = resolveDeepestDescendantHoverCandidate(ownerId, candidates.map(({ candidate, geometry }) => ({
    id: candidate.id,
    ancestors: candidate.ancestors,
    order: candidate.order,
    left: geometry.ownBox.left,
    right: geometry.ownBox.right,
  })), point.x);
  const match = candidates.find(({ candidate }) => candidate.id === matchId);
  if (!match) return null;
  const insideProblemArea = match.candidate.ancestors.some(
    (ancestorId) => index.anchors.get(ancestorId)?.type === "problem",
  );
  return {
    id: match.candidate.id,
    box: match.geometry.box,
    ownBox: match.geometry.ownBox,
    insideProblemArea,
    resolvedFromContainer: true,
    hasVisibleEnd: match.geometry.hasVisibleEnd,
  };
}

/** True only for the actual 12px DOM hit rectangles; column geometry is never reconstructed. */
export function pointHitsLayoutColumnResizeHandle(
  root: ParentNode,
  clientX: number,
  clientY: number,
): boolean {
  return Array.from(root.querySelectorAll<HTMLElement>(".layout-section-column-resize-handle"))
    .some((handle) => {
      const rect = handle.getBoundingClientRect();
      return rect.width > 0
        && rect.height > 0
        && clientX >= rect.left
        && clientX <= rect.right
        && clientY >= rect.top
        && clientY <= rect.bottom;
    });
}

/**
 * Resolve the pointer's outer lane first, then descend only through grids hosted by that lane.
 * This prevents a narrower nested grid in a sibling lane from winning by proximity.
 */
export function resolveInnerAffordanceProbe(
  owner: HTMLElement,
  clientX: number,
  clientY: number,
): { probeX: number; laneLeft: number; firstColumn: boolean } | null {
  const gridSelector = ".layout-section-independent-columns";
  const allGrids = Array.from(owner.querySelectorAll<HTMLElement>(gridSelector));
  const candidatesInside = (container: HTMLElement, parentGrid: HTMLElement | null) => (
    allGrids
      .filter((grid) => container.contains(grid) && grid.parentElement?.closest(gridSelector) === parentGrid)
      .map((grid) => ({ grid, rect: grid.getBoundingClientRect() }))
      .filter(({ rect }) => clientY >= rect.top && clientY <= rect.bottom && rect.width > 0)
      .sort((a, b) => (
        horizontalDistanceToRect(a.rect, clientX) - horizontalDistanceToRect(b.rect, clientX)
        || a.rect.width - b.rect.width
      ))
  );

  let current = candidatesInside(owner, null)[0]?.grid ?? null;
  let resolved: { probeX: number; laneLeft: number; firstColumn: boolean } | null = null;
  let resolvedColumn: HTMLElement | null = null;
  while (current) {
    const columns = Array.from(current.children)
      .filter((child): child is HTMLElement => (
        child instanceof HTMLElement && child.classList.contains("layout-section-independent-column")
      ));
    if (columns.length === 0) break;
    const boxes = columns.map((column) => column.getBoundingClientRect());
    const lane = resolveInnerLaneProbe(boxes, clientX, resolved?.firstColumn ?? true);
    if (!lane) break;
    const column = columns[lane.laneIndex];
    resolved = { probeX: lane.probeX, laneLeft: lane.laneLeft, firstColumn: lane.firstColumn };
    resolvedColumn = column;
    current = candidatesInside(column, current)[0]?.grid ?? null;
  }
  if (resolved && resolvedColumn) {
    const list = resolveListProbeInside(resolvedColumn, clientX, clientY);
    return list ? { ...list, firstColumn: resolved.firstColumn } : resolved;
  }

  const list = resolveListProbeInside(owner, clientX, clientY);
  if (list) return { ...list, firstColumn: true };
  const editors = editorsAtY(owner, clientY, clientX);
  return editors[0]?.rect
    ? {
        probeX: editors[0].rect.left + Math.min(8, editors[0].rect.width / 2),
        laneLeft: editors[0].rect.left,
        firstColumn: true,
      }
    : null;
}

function editorsAtY(root: HTMLElement, clientY: number, clientX: number) {
  return Array.from(root.querySelectorAll<HTMLElement>(".ProseMirror"))
    .flatMap((editor) => {
      const rect = visibleBlockClientRect(editor);
      return rect ? [{ editor, rect }] : [];
    })
    .filter(({ rect }) => clientY >= rect.top && clientY <= rect.bottom && rect.width > 0)
    .sort((a, b) => (
      horizontalDistanceToRect(a.rect, clientX) - horizontalDistanceToRect(b.rect, clientX)
      || a.rect.width - b.rect.width
    ));
}

function resolveListProbeInside(root: HTMLElement, clientX: number, clientY: number) {
  for (const { editor } of editorsAtY(root, clientY, clientX)) {
    const probe = resolveListItemAffordanceProbe(editor, clientX, clientY);
    if (probe) return probe;
  }
  return null;
}

function horizontalDistanceToRect(rect: Pick<DOMRect, "left" | "right">, clientX: number): number {
  if (clientX < rect.left) return rect.left - clientX;
  if (clientX > rect.right) return clientX - rect.right;
  return 0;
}

/**
 * ポインタ位置の落とし先候補。直下 → 段の左端のプローブ → 上下の隙間の順に拾う
 * (グリップのホバーと同じ順序で、同じ相手に解決する)。
 */
export function resolveDragHitAt(
  canvas: HTMLElement,
  document: SigmaDocument,
  index: DragIndex,
  clientX: number,
  clientY: number,
  columnProbeClientX: number,
): DragHit | null {
  const direct = rawHitAt(canvas, document, index, clientX, clientY)
    ?? rawHitAt(canvas, document, index, columnProbeClientX, clientY);
  if (direct) {
    return toDragHit(canvas, document, index, direct, null, clientY);
  }
  const gap = GAP_PROBE_PX * canvasLayoutScale(canvas);
  const above = rawHitAt(canvas, document, index, columnProbeClientX, clientY - gap);
  if (above) {
    return toDragHit(canvas, document, index, above, "bottom", clientY - gap);
  }
  const below = rawHitAt(canvas, document, index, columnProbeClientX, clientY + gap);
  return below ? toDragHit(canvas, document, index, below, "top", clientY + gap) : null;
}


const GHOST_STRIPPED_ATTRIBUTES = [
  "id",
  "data-sigma-doc-id",
  "data-problem-id",
  "data-flow-unit-id",
  "data-layout-section-id",
  "data-page-block",
  "contenteditable",
  "tabindex",
];

/**
 * 掴んだ単位の写し。本文の DOM を複製して紙面の中に置くので、フォントも数式もそのまま出る。
 * id と `data-sigma-doc-id` は落とす — 残すと計測やキャレットの経路が写しを本物と取り違える。
 */
export function createDragGhost(
  ownerDocument: Document,
  geometries: readonly DragUnitGeometry[],
): HTMLElement {
  const ghost = ownerDocument.createElement("div");
  ghost.className = "page-block-drag-ghost ProseMirror";
  ghost.setAttribute("aria-hidden", "true");
  const stripIds = (root: HTMLElement) => {
    for (const node of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]) {
      for (const attribute of GHOST_STRIPPED_ATTRIBUTES) {
        node.removeAttribute(attribute);
      }
      node.classList.remove("selected", "has-focus", "ProseMirror-focused");
    }
  };
  /** 連続する項目は元のリストの殻 (マーカーの種類・番号) ごと 1 つのリストに載せる。 */
  let listShell: { source: HTMLElement; clone: HTMLElement } | null = null;
  for (const geometry of geometries.slice(0, GHOST_UNIT_LIMIT)) {
    for (const element of geometry.elements) {
      const clone = element.cloneNode(true) as HTMLElement;
      clone.removeAttribute("style");
      stripIds(clone);
      const parentList = element.tagName === "LI" ? element.parentElement : null;
      if (parentList && (parentList.tagName === "OL" || parentList.tagName === "UL")) {
        if (!listShell || listShell.source !== parentList) {
          const shell = parentList.cloneNode(false) as HTMLElement;
          shell.removeAttribute("style");
          stripIds(shell);
          const position = Array.from(parentList.children).indexOf(element);
          if (parentList.tagName === "OL") {
            const start = Number.parseInt(parentList.getAttribute("start") ?? "1", 10);
            shell.setAttribute("start", String((Number.isFinite(start) ? start : 1) + Math.max(0, position)));
          }
          listShell = { source: parentList, clone: shell };
          ghost.append(shell);
        }
        listShell.clone.append(clone);
      } else {
        listShell = null;
        ghost.append(clone);
      }
    }
  }
  if (geometries.length > GHOST_UNIT_LIMIT) {
    ghost.dataset.more = String(geometries.length - GHOST_UNIT_LIMIT);
  }
  return ghost;
}
