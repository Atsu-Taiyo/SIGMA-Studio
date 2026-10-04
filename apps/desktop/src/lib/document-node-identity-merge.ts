import { mergeEntity3, type ThreeWayMergeReport } from "@/features/document";
import { areStructurallyEqual } from "@/lib/structural-equality";

// `lib/document-block-merge.ts` の `"merge-both"` 専用。単位ごとに合成した結果で、同じノードid
// (ブロック・リスト項目・数式など `id` と `type` を持つもの) が入力のどちらよりも多く現れたとき
// (片方が単位の外へ移し、もう片方が元の場所で直した、など) に、1つへ戻す。
//
// 規則: その id を「動かした側」(base と違う入れ物に置いた側) の位置に1つだけ残し、もう一方の編集は
// `mergeEntity3(base の値, 人間の値, AIの値)` で残す方へ合成する。両方が別々の場所へ動かしたときは
// AI の位置。合成した結果が検証を通らなければ、残す位置の内容のまま (もう一方の編集は落ちる)。
// 入れ物から外すと入れ物が検証を通らない・残す位置を特定できない、などで重複を解けなければ null。

/** 文書の先頭の並び (本文直下・overlay図形の列) を表す入れ物。 */
const ROOT_CONTAINER = "^";

type PathKey = string | number;

type NodeRecord = Record<string, unknown> & { id: string; type: string };

interface NodeOccurrence {
  /** 一番近い id を持つ親の id と、そこからのキー (`q.blocks`、本文直下は `^`)。 */
  container: string;
  /** 単位の列からの位置。 */
  path: PathKey[];
}

interface IndexedNode {
  count: number;
  container: string;
  value: NodeRecord;
}

export interface NodeIdResolution {
  id: string;
  /** どちらの側の位置に残したか。 */
  keptAt: "mine" | "theirs";
  /** 人間 / AI が、その id を base と違う入れ物へ移していたか。 */
  mineMoved: boolean;
  theirsMoved: boolean;
  /** 両方の編集を合成して残せたときの、カーネルの報告と三者の値。 */
  merged: {
    kernel: ThreeWayMergeReport;
    base: unknown;
    mine: unknown;
    theirs: unknown;
    value: unknown;
  } | null;
  /** 合成できず、残した位置の内容のままにしたため落ちた側の編集 (両方あったときだけ)。 */
  droppedContent: "human" | "ai" | null;
}

export function resolveRepeatedNodeIds<T extends { id: string }>(
  units: T[],
  sides: { base: readonly T[]; mine: readonly T[]; theirs: readonly T[] },
  isValidUnit: (unit: unknown) => boolean,
): { units: T[]; resolutions: NodeIdResolution[] } | null {
  const mergedCounts = countNodeIds(units);
  if (![...mergedCounts.values()].some((count) => count > 1)) {
    return { units, resolutions: [] };
  }
  const indexes = {
    base: indexNodes(sides.base),
    mine: indexNodes(sides.mine),
    theirs: indexNodes(sides.theirs),
  };
  const allowed = (id: string) => Math.max(1, indexes.mine.get(id)?.count ?? 0, indexes.theirs.get(id)?.count ?? 0);
  let current = units;
  const resolutions: NodeIdResolution[] = [];
  // 1回で少なくとも1つの重複を消す。合成で別のidが入ることもあるので、上限で打ち切る。
  const limit = [...mergedCounts.values()].reduce((sum, count) => sum + count, 0) + 8;
  for (let step = 0; step < limit; step += 1) {
    const target = findOutermostRepeatedId(current, allowed);
    if (!target) {
      return { units: current, resolutions };
    }
    if (allowed(target.id) > 1) {
      // 入力がすでに同じidを複数持っている (壊れた教材)。どれを残すか決められない。
      return null;
    }
    const resolved = resolveRepeatedNodeId(current, target.id, target.occurrences, indexes, isValidUnit);
    if (!resolved) {
      return null;
    }
    current = resolved.units;
    resolutions.push(resolved.resolution);
  }
  return null;
}

function findOutermostRepeatedId(
  units: readonly unknown[],
  allowed: (id: string) => number,
): { id: string; occurrences: NodeOccurrence[] } | null {
  const occurrencesById = new Map<string, NodeOccurrence[]>();
  visitNodes(units, (node, occurrence) => {
    occurrencesById.set(node.id, [...(occurrencesById.get(node.id) ?? []), occurrence]);
  });
  let target: { id: string; occurrences: NodeOccurrence[]; depth: number } | null = null;
  for (const [id, occurrences] of occurrencesById) {
    if (occurrences.length <= allowed(id)) {
      continue;
    }
    const depth = Math.min(...occurrences.map((occurrence) => occurrence.path.length));
    if (!target || depth < target.depth) {
      target = { id, occurrences, depth };
    }
  }
  return target;
}

function resolveRepeatedNodeId<T extends { id: string }>(
  units: T[],
  id: string,
  occurrences: NodeOccurrence[],
  indexes: { base: Map<string, IndexedNode>; mine: Map<string, IndexedNode>; theirs: Map<string, IndexedNode> },
  isValidUnit: (unit: unknown) => boolean,
): { units: T[]; resolution: NodeIdResolution } | null {
  const base = indexes.base.get(id);
  const mine = indexes.mine.get(id);
  const theirs = indexes.theirs.get(id);
  const mineMoved = mine !== undefined && mine.container !== base?.container;
  const theirsMoved = theirs !== undefined && theirs.container !== base?.container;
  // 動かした側の位置を採る。両方が動かしたらAI (カーネルの「両方が変えた値はAI」と同じ)。
  const preferred: Array<["mine" | "theirs", IndexedNode | undefined]> = mineMoved && !theirsMoved
    ? [["mine", mine], ["theirs", theirs]]
    : [["theirs", theirs], ["mine", mine]];
  const kept = preferred.flatMap(([side, node]) => {
    const matches = node ? occurrences.filter((occurrence) => occurrence.container === node.container) : [];
    return matches.length === 1 ? [{ side, occurrence: matches[0]! }] : [];
  })[0];
  if (!kept) {
    return null;
  }

  const content = mine && theirs ? mergeNodeContent(id, base?.value, mine.value, theirs.value) : null;
  const touchedUnitIds = [...new Set(occurrences.map((occurrence) => units[occurrence.path[0] as number]!.id))];
  const apply = (withContent: boolean): T[] | null => {
    let next: unknown = units;
    if (withContent && content) {
      next = setAtPath(next, kept.occurrence.path, content.value);
    }
    // 後ろから外すと、外したことで前の位置がずれない。
    for (const occurrence of [...occurrences].reverse()) {
      if (occurrence !== kept.occurrence) {
        next = setAtPath(next, occurrence.path, REMOVE);
      }
    }
    const nextUnits = next as T[];
    const valid = touchedUnitIds.every((unitId) => {
      const unit = nextUnits.find((candidate) => candidate.id === unitId);
      return unit === undefined || isValidUnit(unit);
    });
    return valid ? nextUnits : null;
  };

  const resolution = { id, keptAt: kept.side, mineMoved, theirsMoved };
  const withContent = content ? apply(true) : null;
  if (withContent && content) {
    return {
      units: withContent,
      resolution: {
        ...resolution,
        merged: { kernel: content.kernel, base: base?.value, mine: mine!.value, theirs: theirs!.value, value: content.value },
        droppedContent: null,
      },
    };
  }
  const withoutContent = apply(false);
  if (!withoutContent) {
    return null;
  }
  const dropped = !mine || !theirs
    ? null
    : kept.side === "mine"
      ? (areStructurallyEqual(theirs.value, base?.value) ? null : "ai")
      : (areStructurallyEqual(mine.value, base?.value) ? null : "human");
  return { units: withoutContent, resolution: { ...resolution, merged: null, droppedContent: dropped } };
}

function mergeNodeContent(
  id: string,
  base: NodeRecord | undefined,
  mine: NodeRecord,
  theirs: NodeRecord,
): { value: NodeRecord; kernel: ThreeWayMergeReport } | null {
  const merge = mergeEntity3<unknown>(structuredClone(base), structuredClone(mine), structuredClone(theirs));
  const value = merge.value;
  if (merge.report.duplicateIds.length > 0 || !isNode(value) || value.id !== id) {
    return null;
  }
  return { value, kernel: merge.report };
}

const REMOVE = Symbol("remove");

/** `path` の位置を置き換える (`REMOVE` なら配列から外す)。通った入れ物だけを作り直す。 */
function setAtPath(container: unknown, path: readonly PathKey[], value: unknown): unknown {
  const [head, ...rest] = path;
  if (Array.isArray(container)) {
    const index = head as number;
    if (rest.length === 0 && value === REMOVE) {
      return [...container.slice(0, index), ...container.slice(index + 1)];
    }
    return container.map((element, at) => (
      at === index ? (rest.length === 0 ? value : setAtPath(element, rest, value)) : element
    ));
  }
  const record = container as Record<string, unknown>;
  const key = head as string;
  return { ...record, [key]: rest.length === 0 ? value : setAtPath(record[key], rest, value) };
}

function indexNodes(units: readonly unknown[]): Map<string, IndexedNode> {
  const index = new Map<string, IndexedNode>();
  visitNodes(units, (node, occurrence) => {
    const known = index.get(node.id);
    if (known) {
      known.count += 1;
    } else {
      index.set(node.id, { count: 1, container: occurrence.container, value: node });
    }
  });
  return index;
}

/** 文書順にノードを訪ねる。入れ物は一番近い id を持つ親の id と、そこからのキーで表す。 */
function visitNodes(units: readonly unknown[], visit: (node: NodeRecord, occurrence: NodeOccurrence) => void): void {
  const walk = (value: unknown, container: string, path: PathKey[]) => {
    if (Array.isArray(value)) {
      value.forEach((element, index) => {
        const elementPath = [...path, index];
        if (isNode(element)) {
          visit(element, { container, path: elementPath });
        }
        walk(element, container, elementPath);
      });
      return;
    }
    if (!isPlainRecord(value)) {
      return;
    }
    const owner = typeof value.id === "string" ? value.id : null;
    for (const key of Object.keys(value)) {
      walk(value[key], owner !== null ? `${owner}.${key}` : `${container}.${key}`, [...path, key]);
    }
  };
  walk(units, ROOT_CONTAINER, []);
}

/** 値の中で、ノードのidが現れる回数。 */
export function countNodeIds(value: unknown): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (current: unknown) => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!isPlainRecord(current)) {
      return;
    }
    if (isNode(current)) {
      counts.set(current.id, (counts.get(current.id) ?? 0) + 1);
    }
    Object.values(current).forEach(visit);
  };
  visit(value);
  return counts;
}

function isNode(value: unknown): value is NodeRecord {
  return isPlainRecord(value) && typeof value.id === "string" && typeof value.type === "string";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
