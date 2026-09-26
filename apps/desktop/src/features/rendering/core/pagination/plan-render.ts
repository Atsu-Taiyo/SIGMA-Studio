import type { BuiltFlowModel, BuiltUnit } from "./build-flow-model";
import { type FlowLine, type FlowPlacement, type PlacedLine, type Region } from "./model";

/**
 * 配置結果を描画の指示へ写す。
 *
 * - ユニット (フローの直下の要素) には絶対の変位、編集面の最上位ブロックにはユニットからの
 *   相対の変位を与える。どちらも兄弟のレイアウトに影響しない相対配置のずらしで描く。
 * - 1 つの最上位ブロックの行が複数の領域に分かれたら、正本を最初の帯でクリップし、
 *   残りを続きの複製 (断片) で描く。帯の切れ目は行と行の間にしか来ない。
 * - 枠付き問題文が分かれたら、領域ごとの枠片を描く (切れ目の辺は開く)。
 */

export interface FlowDisplacement {
  dx: number;
  dy: number;
}

export interface FlowFragmentSource {
  visibleHeight: number;
  origin: { x: number; y: number; width: number };
  totalHeight: number;
}

export interface FlowFragmentReplica {
  blockId: string;
  fragmentIndex: number;
  sourceOffsetY: number;
  height: number;
  x: number;
  y: number;
  width: number;
  totalHeight: number;
}

/** 枠片。座標はユニット (描かれた位置) の padding box 左上からの相対値。 */
export interface FlowFramePiece {
  x: number;
  y: number;
  width: number;
  height: number;
  openTop: boolean;
  openBottom: boolean;
}

export interface FlowRenderPlan {
  unitDisplacements: Record<string, FlowDisplacement>;
  /** ユニットからの相対。値が 0 のブロックも入れる (新しいブロックは前のブロックの値を継ぐ)。 */
  nodeDisplacements: Record<string, FlowDisplacement>;
  fragmentSources: Record<string, FlowFragmentSource>;
  fragmentReplicas: Record<string, FlowFragmentReplica[]>;
  framePieces: Record<string, FlowFramePiece[]>;
  /**
   * 複数の領域に分かれたユニットの、描かれた内容の末尾 (ユニット上端からの相対 y)。
   * サイド注の括弧とリサイズつまみを、自然配置の高さではなく実際に描いた末尾に合わせる。
   */
  visualEnds: Record<string, number>;
  /**
   * 手動改ページの印の変位 (その印を描く要素からの相対)。印は改ページする前のページの末尾、
   * つまり直前に置いた行と同じ場所に描く。キーはユニット単位の改ページならユニット id、
   * ブロックの改ページならブロック id。
   */
  markerDisplacements: Record<string, FlowDisplacement>;
  pageCount: number;
}

interface Group {
  regionIndex: number;
  dx: number;
  dy: number;
  lines: FlowLine[];
}

const ZERO: FlowDisplacement = { dx: 0, dy: 0 };

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function sameDisplacement(a: PlacedLine, b: { regionIndex: number; dx: number; dy: number }): boolean {
  return a.regionIndex === b.regionIndex && Math.round(a.dy) === b.dy && Math.round(a.dx) === b.dx;
}

export function planFlowRender(built: BuiltFlowModel, placement: FlowPlacement): FlowRenderPlan {
  const plan: FlowRenderPlan = {
    unitDisplacements: {},
    nodeDisplacements: {},
    fragmentSources: {},
    fragmentReplicas: {},
    framePieces: {},
    visualEnds: {},
    markerDisplacements: {},
    pageCount: placement.pageCount,
  };
  const regionOf = (index: number): Region | undefined => placement.regions[index];
  let previousUnit: FlowDisplacement = ZERO;
  /** 文書順で直前に置いた行の変位 (改ページの印を描く場所)。 */
  let lastPlaced: FlowDisplacement = ZERO;

  for (const unit of built.units) {
    const unitDisplacement = firstDisplacement(unit, built, placement) ?? previousUnit;
    plan.unitDisplacements[unit.id] = { dx: round(unitDisplacement.dx), dy: round(unitDisplacement.dy) };
    if (unit.breakBefore) plan.markerDisplacements[unit.id] = relative(lastPlaced, unitDisplacement);
    previousUnit = unitDisplacement;
    let previousNode = unitDisplacement;

    for (const node of unit.nodes) {
      const groups = groupLines(node.lineKeys, built, placement);
      if (node.breakBefore) plan.markerDisplacements[node.id] = relative(lastPlaced, unitDisplacement);
      if (groups.length === 0) {
        plan.nodeDisplacements[node.id] = relative(previousNode, unitDisplacement);
        continue;
      }
      lastPlaced = { dx: groups[groups.length - 1].dx, dy: groups[groups.length - 1].dy };
      const first = groups[0];
      previousNode = { dx: first.dx, dy: first.dy };
      plan.nodeDisplacements[node.id] = relative(previousNode, unitDisplacement);
      if (groups.length === 1) continue;

      const totalHeight = node.bottom - node.top;
      const clipEnd = (index: number): number => {
        const group = groups[index];
        const lastLine = group.lines[group.lines.length - 1];
        const next = groups[index + 1];
        if (!next) return node.bottom;
        const region = regionOf(group.regionIndex);
        const regionBottomNatural = region ? region.bottom - group.dy : lastLine.fitBottom;
        return Math.max(lastLine.fitBottom, Math.min(next.lines[0].top, regionBottomNatural));
      };
      plan.fragmentSources[node.id] = {
        visibleHeight: round(clipEnd(0) - node.top),
        origin: { x: round(node.left + first.dx), y: round(node.top + first.dy), width: round(node.width) },
        totalHeight: round(totalHeight),
      };
      plan.fragmentReplicas[node.id] = groups.slice(1).map((group, offset) => {
        const index = offset + 1;
        const start = group.lines[0].top;
        const end = clipEnd(index);
        return {
          blockId: node.id,
          fragmentIndex: index,
          sourceOffsetY: round(start - node.top),
          height: round(Math.max(1, end - start)),
          x: Math.round(node.left + group.dx),
          y: Math.round(start + group.dy),
          width: Math.round(node.width),
          totalHeight: round(totalHeight),
        };
      });
      const last = groups[groups.length - 1];
      previousNode = { dx: last.dx, dy: last.dy };
    }

    if (unit.reservationKey) {
      const blank = built.blanks.get(unit.reservationKey);
      const pieces = placement.blanks.filter((piece) => piece.key === unit.reservationKey);
      if (blank && pieces.length > 0) {
        const last = pieces[pieces.length - 1];
        const naturalTop = blank.top + pieces.slice(0, -1).reduce((sum, piece) => sum + piece.height, 0);
        lastPlaced = { dx: Math.round(placement.regions[last.regionIndex]?.dx ?? 0), dy: Math.round(last.y - naturalTop) };
      }
    }
    planFramePieces(unit, built, placement, unitDisplacement, plan);
  }
  return plan;
}

function relative(value: FlowDisplacement, base: FlowDisplacement): FlowDisplacement {
  return { dx: round(value.dx - base.dx), dy: round(value.dy - base.dy) };
}

function firstDisplacement(unit: BuiltUnit, built: BuiltFlowModel, placement: FlowPlacement): FlowDisplacement | null {
  let best: { top: number; displacement: FlowDisplacement } | null = null;
  for (const key of unit.itemKeys) {
    const placed = placement.lines.get(key);
    const line = built.lines.get(key);
    if (placed && line) {
      if (!best || line.top < best.top) best = { top: line.top, displacement: { dx: Math.round(placed.dx), dy: Math.round(placed.dy) } };
      continue;
    }
    const blank = built.blanks.get(key);
    if (!blank) continue;
    const piece = placement.blanks.find((candidate) => candidate.key === key);
    if (piece && (!best || blank.top < best.top)) {
      const region = placement.regions[piece.regionIndex];
      best = { top: blank.top, displacement: { dx: Math.round(region?.dx ?? 0), dy: Math.round(piece.y - blank.top) } };
    }
  }
  return best?.displacement ?? null;
}

function groupLines(keys: readonly string[], built: BuiltFlowModel, placement: FlowPlacement): Group[] {
  const groups: Group[] = [];
  for (const key of keys) {
    const line = built.lines.get(key);
    const placed = placement.lines.get(key);
    if (!line || !placed) continue;
    const last = groups.at(-1);
    if (last && sameDisplacement(placed, last)) {
      last.lines.push(line);
    } else {
      // 変位は整数 px にする。レイアウトの丸め (1/64 px) の上で「表示位置 − 変位 = 自然位置」が
      // 厳密に成り立ち、次の計測が同じ自然配置を読む (端数の変位は計測のたびに揺れる)。
      groups.push({ regionIndex: placed.regionIndex, dx: Math.round(placed.dx), dy: Math.round(placed.dy), lines: [line] });
    }
  }
  return groups;
}

function planFramePieces(
  unit: BuiltUnit,
  built: BuiltFlowModel,
  placement: FlowPlacement,
  unitDisplacement: FlowDisplacement,
  plan: FlowRenderPlan,
): void {
  const byRegion = new Map<number, { top: number; bottom: number; x: number }>();
  const note = (regionIndex: number, top: number, bottom: number, x: number) => {
    const region = placement.regions[regionIndex];
    const key = region?.parentIndex ?? regionIndex;
    const existing = byRegion.get(key);
    if (existing) {
      existing.top = Math.min(existing.top, top);
      existing.bottom = Math.max(existing.bottom, bottom);
    } else {
      byRegion.set(key, { top, bottom, x });
    }
  };
  for (const key of unit.itemKeys) {
    const line = built.lines.get(key);
    const placed = placement.lines.get(key);
    if (line && placed) {
      note(placed.regionIndex, line.top + Math.round(placed.dy), line.fitBottom + Math.round(placed.dy), Math.round(placed.dx));
      continue;
    }
    const blank = built.blanks.get(key);
    if (!blank) continue;
    for (const piece of placement.blanks) {
      if (piece.key !== key) continue;
      const region = placement.regions[piece.regionIndex];
      note(piece.regionIndex, piece.y, piece.y + piece.height + (blank.closingChrome ?? 0), region?.dx ?? 0);
    }
  }
  const segments = [...byRegion.entries()].sort(([a], [b]) => a - b).map(([, extent]) => extent);
  if (segments.length <= 1) return;
  const unitTop = unit.top + unitDisplacement.dy;
  plan.visualEnds[unit.id] = round(Math.max(...segments.map((segment) => segment.bottom)) - unitTop);
  if (!unit.frame) return;
  plan.framePieces[unit.id] = segments.map((segment, index) => {
    const isFirst = index === 0;
    const isLast = index === segments.length - 1;
    const top = isFirst && unit.frame!.first ? Math.min(segment.top, unitTop) : segment.top;
    return {
      x: round(segment.x - unitDisplacement.dx - unit.frame!.borderLeft),
      y: round(top - unitTop - unit.frame!.borderTop),
      width: round(unit.width),
      height: round(Math.max(1, segment.bottom - top)),
      openTop: !(isFirst && unit.frame!.first),
      openBottom: !(isLast && unit.frame!.last),
    };
  });
}

/** 描画計画が空 (どこにも変位・断片が無い) か。 */
export function isIdentityRenderPlan(plan: FlowRenderPlan): boolean {
  return Object.values(plan.unitDisplacements).every((value) => value.dx === 0 && value.dy === 0)
    && Object.values(plan.nodeDisplacements).every((value) => value.dx === 0 && value.dy === 0)
    && Object.keys(plan.fragmentReplicas).length === 0;
}


