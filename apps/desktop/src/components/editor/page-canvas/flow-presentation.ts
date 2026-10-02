import { type PageMetrics } from "@/features/document";
import { type FlowColumnRulePiece,type FlowDisplacement } from "@/features/rendering/core";
import { type TextFlowBlock } from "@/features/text-editing";
import type { CSSProperties } from "react";
import { FLOW_DX_ATTRIBUTE,FLOW_DY_ATTRIBUTE } from "./flow-probe";
import { type PageLayoutSnapshot } from "./layout-snapshot";
import { isFullSpanUnit } from "./render-units";
import type { RenderUnit } from "./types";

/**
 * そのフローユニットの面が **自分で描く** ブロックの id。
 *
 * 定義は下端つまみが `resolveHoverDragUnitAt` で拾う編集単位と同じ。ここが食い違うと、
 * 掴めるのに追従しないブロックが出る。
 */
export const EMPTY_SPACE_AFTER_FOLLOWER_UNITS: ReadonlySet<string> = new Set();

export function getFlowUnitBlockIds(unit: RenderUnit): string[] {
  return unit.type === "block" ? [unit.block.id] : unit.blocks.map((block) => block.id);
}

export function readFlowDisplacementSignature(flow: HTMLElement): string {
  let signature = "";
  flow.querySelectorAll<HTMLElement>(`[${FLOW_DY_ATTRIBUTE}], [${FLOW_DX_ATTRIBUTE}]`).forEach((element) => {
    signature += `${element.getAttribute(FLOW_DX_ATTRIBUTE) ?? 0},${element.getAttribute(FLOW_DY_ATTRIBUTE) ?? 0};`;
  });
  return signature;
}

/** 印の変位は同じ表に `marker:<id>` で入れて運ぶ (編集面の装飾が 1 つの表だけを読むため)。 */
export function pickUnitNodeDisplacements(
  blocks: readonly TextFlowBlock[],
  displacements: Readonly<Record<string, FlowDisplacement>> | undefined,
  markerDisplacements?: Readonly<Record<string, FlowDisplacement>>,
): Record<string, FlowDisplacement> | undefined {
  if (!displacements) return undefined;
  const picked: Record<string, FlowDisplacement> = {};
  for (const block of blocks) {
    const value = displacements[block.id];
    if (value) picked[block.id] = value;
    const marker = markerDisplacements?.[block.id];
    if (marker) picked[`marker:${block.id}`] = marker;
  }
  return picked;
}

export function getNodeDisplacementsKey(displacements: Readonly<Record<string, FlowDisplacement>> | undefined): string {
  if (!displacements) return "";
  return Object.entries(displacements).map(([id, value]) => `${id}:${value.dx}:${value.dy}`).join("|");
}

export function sameColumnRulePieces(
  current: Record<string, FlowColumnRulePiece[]>,
  next: Record<string, FlowColumnRulePiece[]>,
): boolean {
  const keys = Object.keys(next);
  return keys.length === Object.keys(current).length && keys.every(key => {
    const a = current[key];
    const b = next[key];
    return a?.length === b.length && b.every((piece, index) => (
      a[index].x === piece.x && a[index].y === piece.y && a[index].height === piece.height
    ));
  });
}

export function sameDisplacementMap(
  a: Readonly<Record<string, FlowDisplacement>>,
  b: Readonly<Record<string, FlowDisplacement>>,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => {
    const other = b[key];
    return other !== undefined && other.dx === a[key].dx && other.dy === a[key].dy;
  });
}

/**
 * ユニットの置き方のうち、変位以外のもの。段組のページでは本文は段幅の自然フローに置くので、
 * 全幅のエリアだけは本文幅を明示する (段幅の帯から右へはみ出すが、変位と同じくレイアウトには
 * 影響しない)。紙面外のサイド注は、段へ動いたユニットでも紙面の左余白に出す。
 */
export function getFlowUnitPlacementStyle(
  unit: RenderUnit,
  displacement: FlowDisplacement | undefined,
  metrics: PageMetrics,
  isColumnPage: boolean,
): CSSProperties | undefined {
  const style: Record<string, string> = {};
  if (isColumnPage && isFullSpanUnit(unit)) {
    style.width = `${metrics.content.widthPx}px`;
  }
  if (displacement && displacement.dx !== 0) {
    style["--problem-area-page-x"] = `${metrics.margins.leftPx + displacement.dx}px`;
  }
  return Object.keys(style).length > 0 ? (style as CSSProperties) : undefined;
}

/**
 * 複数の領域に分かれたユニットのサイド注 (括弧) とリサイズつまみを、描かれた内容の末尾まで伸ばし、
 * 見出しは最初の片の中ほどに置く (括弧全体の中ほどだとページの間に浮く)。
 * 分かれていないユニットは自然配置の高さのまま (CSS の既定値)。
 */
export function getVisualEndStyle(visualEnd: number | undefined, labelY: number | undefined): Record<string, string> {
  if (typeof visualEnd !== "number") return {};
  return {
    "--flow-unit-visual-height": `${visualEnd}px`,
    "--problem-area-resize-y": `${visualEnd - 5}px`,
    ...(typeof labelY === "number" ? { "--problem-area-side-note-y": `${labelY}px` } : {}),
  };
}

export function mergeFlowUnitStyle(
  base: CSSProperties | undefined,
  displacement: FlowDisplacement | undefined,
): CSSProperties | undefined {
  const { style } = getFlowDisplacementProps(displacement);
  if (!style) return base;
  return base ? { ...base, ...style } : style;
}

/** ユニットの変位を描く style と、計測が差し引くための属性。0 のときは何も付けない。 */
export function getFlowDisplacementProps(displacement: FlowDisplacement | undefined): {
  style: CSSProperties | undefined;
  attributes: Record<string, string>;
} {
  if (!displacement || (displacement.dx === 0 && displacement.dy === 0)) {
    return { style: undefined, attributes: {} };
  }
  return {
    // 相対配置のずらし。translate と同じく兄弟のレイアウトに影響しないが、ブラウザ自身の
    // キャレット追従 (入力時の reveal) は transform を正しく扱わず紙面を跳ばすので使わない。
    style: { position: "relative", top: `${displacement.dy}px`, left: `${displacement.dx}px` },
    attributes: {
      [FLOW_DX_ATTRIBUTE]: String(displacement.dx),
      [FLOW_DY_ATTRIBUTE]: String(displacement.dy),
    },
  };
}

export function createInitialPageLayoutSnapshot(pageHeightPx: number): PageLayoutSnapshot {
  return {
    input: null,
    fontRevision: 0,
    blockAnchorable: [],
    blockExtents: new Map(),
    blockRects: new Map(),
    boxLayoutSectionSideNoteLayouts: {},
    boxBlockFragmentLayouts: {},
    boxFragmentSourceLayouts: {},
    frameFragmentLayouts: {},
    gaps: {},
    paginationMarkerLayouts: {},
    pageCount: 1,
    problemAreaColumnLayouts: {},
    revision: 0,
    textFlowBlockLayouts: {},
    totalHeight: pageHeightPx,
    unitLayouts: {},
    unitDisplacements: {},
    nodeDisplacements: {},
    visualEnds: {},
    sideNoteLabelYs: {},
    markerDisplacements: {},
  };
}
