import type { BlockExtent, MeasuredBlock } from "../overlay-canvas/anchor";
import type { TextFlowBoxFragmentSourceLayout, TextFlowColumnBlockLayout } from "../text-flow/types";
import type { SigmaDocument } from "@/features/document";
import type { FlowDisplacement } from "@/features/rendering/core";
import type { EditorBoxBlockFragmentLayout, FlowUnitLayout, ProblemAreaColumnLayout, ProblemAreaFrameFragmentLayout } from "./types";

/** Identity of the committed layout inputs; never persisted in SigmaDoc. */
export interface PageLayoutInput {
  documentId: string;
  content: SigmaDocument["content"];
  geometry: object;
  zoom: number;
  fontSize: number;
}

/** One publication for content, frame, interaction, caret and output geometry. */
export interface PageLayoutSnapshot {
  input: PageLayoutInput | null;
  fontRevision: number;
  blockAnchorable: MeasuredBlock[];
  blockExtents: Map<string, BlockExtent>;
  blockRects: Map<string, MeasuredBlock>;
  boxLayoutSectionSideNoteLayouts: Record<string, FlowUnitLayout>;
  boxBlockFragmentLayouts: Record<string, EditorBoxBlockFragmentLayout[]>;
  boxFragmentSourceLayouts: Record<string, TextFlowBoxFragmentSourceLayout>;
  frameFragmentLayouts: Record<string, ProblemAreaFrameFragmentLayout[]>;
  gaps: Record<string, number>;
  paginationMarkerLayouts: Record<string, FlowUnitLayout>;
  pageCount: number;
  problemAreaColumnLayouts: Record<string, ProblemAreaColumnLayout>;
  revision: number;
  textFlowBlockLayouts: Record<string, TextFlowColumnBlockLayout>;
  totalHeight: number;
  unitLayouts: Record<string, FlowUnitLayout>;
  /** フロー直下のユニットの変位 (レイアウトに影響しない translate)。 */
  unitDisplacements: Record<string, FlowDisplacement>;
  /** 編集面の最上位ブロックの、ユニットからの相対変位。 */
  nodeDisplacements: Record<string, FlowDisplacement>;
  /** 複数の領域に分かれたユニットの、描かれた内容の末尾 (サイド注・リサイズつまみの位置)。 */
  visualEnds: Record<string, number>;
  /** 分かれたユニットのサイド注の見出しの位置 (最初の片の中ほど)。 */
  sideNoteLabelYs: Record<string, number>;
  /** 手動改ページの印の変位 (印を描く要素からの相対)。 */
  markerDisplacements: Record<string, FlowDisplacement>;
}

export type FragmentGeometrySnapshot = Pick<PageLayoutSnapshot,
  "revision" | "boxFragmentSourceLayouts" | "boxBlockFragmentLayouts">;

const snapshots = new WeakMap<HTMLElement, FragmentGeometrySnapshot>();

/** Publish only after React committed the matching content/frame DOM. */
export function publishLayoutSnapshot(canvas: HTMLElement, snapshot: FragmentGeometrySnapshot): () => void {
  snapshots.set(canvas, snapshot);
  return () => {
    if (snapshots.get(canvas) === snapshot) snapshots.delete(canvas);
  };
}

export function readFragmentClientRect(element: HTMLElement, blockId: string, fragmentIndex: number): DOMRect | null {
  const canvas = element.closest<HTMLElement>(".page-canvas");
  const snapshot = canvas && snapshots.get(canvas);
  if (!canvas || !snapshot) return null;
  const source = snapshot.boxFragmentSourceLayouts[blockId];
  const fragment = fragmentIndex === 0
    ? source?.origin && { ...source.origin, height: source.visibleHeight }
    : snapshot.boxBlockFragmentLayouts[blockId]?.find((item) => item.fragmentIndex === fragmentIndex);
  if (!fragment) return null;
  const bounds = canvas.getBoundingClientRect();
  // offsetWidth is integer-rounded. Its ratio drifts by pixels on later pages.
  const zoom = Number.parseFloat(getComputedStyle(canvas).getPropertyValue("--editor-zoom"));
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom
    : canvas.offsetWidth > 0 ? bounds.width / canvas.offsetWidth : 1;
  return new DOMRect(bounds.left + fragment.x * scale, bounds.top + fragment.y * scale,
    fragment.width * scale, fragment.height * scale);
}
