import {
  findMeasurableContainerId,
  isEditorOnlyBlockElement,
  measureElementLineBoxes,
  type MeasuredBlock,
  type MeasuredLine,
} from "@/components/editor/overlay-canvas/anchor";
import type { OverlayShape } from "@/components/editor/overlay-canvas/types";
import type { TextFlowBoxFragmentSourceLayout } from "@/components/editor/text-flow/types";
import { countPerformanceEvent } from "@/lib/performance";
import {
  canCarrySegments,
  composeFlowMeasurement,
  isSameBlockGeometry,
  patchFlowMeasurement,
  type FlowMeasurement,
  type FlowMeasurementSegment,
  type MeasuredBlockEntry,
  type MeasureScope,
} from "./incremental-layout";
import type { EditorBoxBlockFragmentLayout, FlowUnitLayout } from "./types";

interface LineMeasureCacheEntry {
  contentRevision: string;
  element: HTMLElement;
  zoomFactor: number;
  width: number;
  height: number;
  relLines: MeasuredLine[];
}

export type LineMeasureCache = Map<string, LineMeasureCacheEntry>;

const LINE_CACHE_EPSILON_PX = 0.5;

/** Anything that carries block geometry: body blocks plus non-text flow units. */
const MEASURABLE_BLOCK_SELECTOR = "[data-sigma-doc-id], [data-page-block]";

/**
 * The subset that pagination walks. A flow unit is a direct child of some
 * ProseMirror root (top-level body blocks, and the blocks of a problem area or
 * layout section, which each render their own editor) or a `[data-page-block]`
 * wrapper. Blocks nested deeper — list items, and the children of a box block —
 * are measured too, but they are laid out by their container, never paginated
 * on their own.
 */
const FLOW_UNIT_SELECTOR = ".ProseMirror > [data-sigma-doc-id], [data-page-block]";
/** 本文ユニットの入れ物。増分計測の単位はこれ (紙面全体でも数十件)。 */
const FLOW_UNIT_ID_ATTRIBUTE = "data-flow-unit-id";
const FLOW_UNIT_CONTAINER_SELECTOR = `[${FLOW_UNIT_ID_ATTRIBUTE}]`;

/**
 * Overlay and body flow are independent layers. Older SigmaDoc files may still
 * carry `anchor.reserveSpace`, but moving or resizing those shapes must not
 * reflow body text. Keep this compatibility helper while returning no body
 * gaps so every existing call site resolves overlays without layout coupling.
 */
export function calculateReserveSpaceGaps(
  shapes: readonly OverlayShape[],
  marginPx?: number,
): Record<string, number> {
  void shapes;
  void marginPx;
  return {};
}

/**
 * Block geometry for the whole body.
 *
 * `ordered` is the pagination flow: only blocks the page walk may break
 * between. `tops`/`rects`/`extents`/`anchorable` also cover blocks nested
 * inside a flow unit (list items, box-block children), because an overlay
 * figure can be anchored to any of them — the anchor picker measures the same
 * `[data-sigma-doc-id]` set (see `measureBlockTops`). Leaving a nested block
 * out of `rects` silently freezes every figure anchored to it: resolution
 * falls back to the shape's cached `y`, so it stops following text reflow.
 */
/**
 * どこまで測り直すか (`incremental-layout.ts` の `resolveMeasureScope` が決める)。
 *
 * - `all`: 全ブロック (初回・ズーム・用紙・フォント・幅の変化)。
 * - `fromUnit`: そのユニット以降だけ。打鍵で位置が動くのは打った場所より下だけなので、上の
 *   ブロックは前回の実測がそのまま正しい。1,500 段落では 1 打鍵あたりの
 *   `getBoundingClientRect` が 2 桁減る。
 * - `carry`: 1 つも測り直さない。前回の計測以降どこも汚れていない (打鍵も伸縮も無い) ときの
 *   再計算 — 別の理由で走った描画に相乗りしただけなので、幾何は前回のままでよい。
 *
 * いずれの場合も**前回に無かったブロックは必ず測る**ので、新しく現れた要素が漏れることはない。
 */
export interface MeasureFlowBlocksOptions {
  scope?: MeasureScope;
  /** 前回の**文書全体**の計測。測り直さなかったブロックの出どころ。 */
  previous?: FlowMeasurement | null;
}

export function measureFlowBlocks(
  flow: HTMLElement,
  zoomFactor: number,
  marginTopPx: number,
  cache?: LineMeasureCache,
  options: MeasureFlowBlocksOptions = {},
): FlowMeasurement {
  const flowRect = flow.getBoundingClientRect();
  const contentOriginY = flowRect.top + marginTopPx * zoomFactor;
  const previous = options.previous ?? null;
  const requestedScope: MeasureScope = previous ? options.scope ?? { kind: "all" } : { kind: "all" };

  // ユニットの入れ物だけを 1 回列挙する (本文 1,500 段落でも 40 件ほど)。増分パスではこの
  // 40 件しか DOM を触らない — ブロックの列挙は汚れたユニットの中だけで済ませる。
  const unitElements = Array.from(flow.querySelectorAll<HTMLElement>(FLOW_UNIT_CONTAINER_SELECTOR));
  const unitIds = unitElements.map((element) => element.getAttribute(FLOW_UNIT_ID_ATTRIBUTE) ?? "");
  const carryable = canCarrySegments(previous, unitIds);
  const startIndex = requestedScope.kind === "fromUnit" || requestedScope.kind === "dirtyUnit"
    ? unitIds.indexOf(requestedScope.unitId)
    : -1;
  // 前回の列挙が使えない / 開始ユニットが見つからないときは全部測り直す (安全側)。
  const measureAll = !carryable
    || requestedScope.kind === "all"
    || ((requestedScope.kind === "fromUnit" || requestedScope.kind === "dirtyUnit") && startIndex < 0);

  const seen = new Set<string>();
  /** 測り直したブロック。前回と同じ位置なら、並べ替え無しで差し替えられる。 */
  const measuredBlocks: MeasuredBlock[] = [];
  let geometryChanged = false;

  const measureElement = (el: HTMLElement, isFlowUnit: boolean, into: MeasuredBlockEntry[]): void => {
    const id = el.getAttribute("data-sigma-doc-id") ?? el.id;
    if (!id || seen.has(id)) {
      return;
    }
    seen.add(id);
    const containerId = findMeasurableContainerId(el, id);
    const rect = el.getBoundingClientRect();
    const top = (rect.top - contentOriginY) / zoomFactor + marginTopPx;
    const left = (rect.left - flowRect.left) / zoomFactor;
    const width = rect.width / zoomFactor;
    const height = rect.height / zoomFactor;

    // Equal outer dimensions do not imply equal line boundaries (math/font edits).
    const contentRevision = el.closest<HTMLElement>(".ProseMirror")?.dataset.flowMeasureRevision ?? "0";
    const cached = cache?.get(id);
    let lines: MeasuredLine[];
    if (
      cached
      && cached.element === el
      && cached.contentRevision === contentRevision
      && cached.zoomFactor === zoomFactor
      && Math.abs(cached.width - width) <= LINE_CACHE_EPSILON_PX
      && Math.abs(cached.height - height) <= LINE_CACHE_EPSILON_PX
    ) {
      // Reuse cached line boxes, re-anchored to this block's current position.
      lines = cached.relLines.map((line) => ({
        index: line.index,
        top: top + line.top,
        left: left + (line.left ?? 0),
        width: line.width,
        height: line.height,
      }));
    } else {
      countPerformanceEvent("PageCanvasEditor.lineBoxMeasure");
      lines = measureElementLineBoxes(el, flowRect, 1 / zoomFactor, 1 / zoomFactor);
      cache?.set(id, {
        contentRevision,
        element: el,
        zoomFactor,
        width,
        height,
        relLines: lines.map((line) => ({
          index: line.index,
          top: line.top - top,
          left: (line.left ?? left) - left,
          width: line.width,
          height: line.height,
        })),
      });
    }

    const measured = {
      id,
      top,
      left,
      width,
      height,
      lines,
      ...(containerId ? { containerId } : {}),
      ...(isEditorOnlyBlockElement(el, id) ? { derived: true } : {}),
    };
    if (!isSameBlockGeometry(measured, previous?.rects.get(id))) {
      // 位置か高さが変わったブロックが 1 つでもあれば、並びが変わりうる。
      geometryChanged = true;
    }
    measuredBlocks.push(measured);
    into.push({ block: measured, isFlowUnit });
  };

  /** ある入れ物の中を測る。フローユニットを先に測るのは下のコメントのとおり。 */
  const measureWithin = (root: ParentNode, into: MeasuredBlockEntry[]): void => {
    // Flow units first, so a block rendered both as a flow unit and (as part of a
    // clipped box fragment) deeper in the tree still reports its flow geometry.
    root.querySelectorAll<HTMLElement>(FLOW_UNIT_SELECTOR).forEach((el) => measureElement(el, true, into));
    root.querySelectorAll<HTMLElement>(MEASURABLE_BLOCK_SELECTOR).forEach((el) => measureElement(el, false, into));
  };

  const segments: FlowMeasurementSegment[] = [];

  if (measureAll) {
    // 全部測り直す。ユニットの外にいるブロック (running region など) も拾うため、
    // 従来どおり紙面全体を 2 周する。
    const byUnit = new Map<string | null, MeasuredBlockEntry[]>();
    const entryFor = (el: HTMLElement): MeasuredBlockEntry[] => {
      const unitId = el.closest<HTMLElement>(FLOW_UNIT_CONTAINER_SELECTOR)?.getAttribute(FLOW_UNIT_ID_ATTRIBUTE) ?? null;
      const existing = byUnit.get(unitId);
      if (existing) {
        return existing;
      }
      const created: MeasuredBlockEntry[] = [];
      byUnit.set(unitId, created);
      return created;
    };
    flow.querySelectorAll<HTMLElement>(FLOW_UNIT_SELECTOR).forEach((el) => measureElement(el, true, entryFor(el)));
    flow.querySelectorAll<HTMLElement>(MEASURABLE_BLOCK_SELECTOR).forEach((el) => measureElement(el, false, entryFor(el)));
    for (const unitId of unitIds) {
      segments.push({ unitId, entries: byUnit.get(unitId) ?? [] });
    }
    const outside = byUnit.get(null);
    if (outside) {
      segments.push({ unitId: null, entries: outside });
    }
  } else {
    // 増分パス。`carryable` が真なのでユニットの並びは前回と同じ = 前回の列挙をそのまま
    // 使える。測り直すのは、汚れたユニット (と、そこが動いていたなら以降のユニット) だけ。
    const previousByUnitId = new Map(previous!.segments.map((segment) => [segment.unitId, segment]));
    let downstreamDirty = false;
    unitElements.forEach((unitElement, index) => {
      const unitId = unitIds[index];
      const isStartUnit = index === startIndex;
      const shouldMeasure = requestedScope.kind === "carry"
        ? false
        : requestedScope.kind === "fromUnit"
          ? index >= startIndex
          : isStartUnit || (index > startIndex && downstreamDirty);
      if (!shouldMeasure) {
        const carried = previousByUnitId.get(unitId);
        if (carried) {
          for (const entry of carried.entries) {
            seen.add(entry.block.id);
          }
          segments.push(carried);
          return;
        }
      }
      const entries: MeasuredBlockEntry[] = [];
      const geometryChangedBefore = geometryChanged;
      measureWithin(unitElement, entries);
      const previousEntries = previousByUnitId.get(unitId)?.entries ?? [];
      const membershipChanged = entries.length !== previousEntries.length
        || entries.some((entry, entryIndex) => entry.block.id !== previousEntries[entryIndex]?.block.id);
      if (membershipChanged) geometryChanged = true;
      if (isStartUnit && (membershipChanged || geometryChanged !== geometryChangedBefore)) {
        // 末尾の行を削除しても残った行の位置・高さは変わらない。所属の変化も
        // 下流を測り直す条件に含め、削除前の本文位置から spacer を算出しない。
        downstreamDirty = true;
      }
      segments.push({ unitId, entries });
    });
    // ユニットの外のブロックは、この経路では前回のまま (動く原因 — 用紙設定・ズーム・
    // フォント — はすべて全体計測に倒れる)。
    const outside = previousByUnitId.get(null);
    if (outside) {
      for (const entry of outside.entries) {
        seen.add(entry.block.id);
      }
      segments.push(outside);
    }
  }

  // Drop cache entries for blocks no longer present (e.g. deleted) so the cache
  // tracks the live document instead of growing without bound.
  if (cache) {
    for (const key of cache.keys()) {
      if (!seen.has(key)) {
        cache.delete(key);
      }
    }
  }

  // 持ち越しと測り直しを合わせて、**文書全体**の計測に戻す。下流 (ページ割り・図形の
  // 再アンカー・古い測定の検出) はどれも全体のマップを前提にしている。
  //
  // ブロックの増減が無く、測り直した分も 1px も動いていないなら、並びは前回と同じ。
  // 1,500 ブロックの Map 構築と 2 回の並べ替えを丸ごと省ける (打鍵の大半がこの形)。
  //
  // 件数一致で集合一致が言えるのは、**前回に無い id は必ず測られる**から: 測った結果は
  // `isSameBlockGeometry(x, undefined) === false` で `geometryChanged` を立てるので、
  // ここへ来た時点で「今回見た id ⊆ 前回の id」かつ件数が同じ = 同じ集合。
  if (previous && !geometryChanged && seen.size === previous.rects.size) {
    return patchFlowMeasurement(previous, measuredBlocks);
  }
  return composeFlowMeasurement(segments);
}

export function measureBoxLayoutSectionSideNotes(
  flow: HTMLElement,
  zoomFactor: number,
  boxFragmentSourceLayouts: Readonly<Record<string, TextFlowBoxFragmentSourceLayout>> = {},
): Record<string, FlowUnitLayout> {
  const flowRect = flow.getBoundingClientRect();
  const layouts: Record<string, FlowUnitLayout> = {};

  flow.querySelectorAll<HTMLElement>(".sigma-doc-layout-section-block").forEach((element) => {
    const id = element.getAttribute("data-sigma-doc-id");
    let boxElement = element.closest<HTMLElement>(".sigma-doc-box-block");
    if (!id || layouts[id] || !boxElement) {
      return;
    }
    const rect = element.getBoundingClientRect();
    let visibleTop = rect.top;
    let visibleBottom = rect.bottom;

    while (boxElement) {
      const boxId = boxElement.getAttribute("data-sigma-doc-id");
      const fragmentSource = boxId ? boxFragmentSourceLayouts[boxId] : undefined;
      if (fragmentSource && fragmentSource.totalHeight > fragmentSource.visibleHeight + 0.5) {
        const boxRect = boxElement.getBoundingClientRect();
        visibleTop = Math.max(visibleTop, boxRect.top);
        visibleBottom = Math.min(
          visibleBottom,
          boxRect.top + fragmentSource.visibleHeight * zoomFactor,
        );
        if (visibleBottom <= visibleTop) {
          return;
        }
      }
      boxElement = boxElement.parentElement?.closest<HTMLElement>(".sigma-doc-box-block") ?? null;
    }
    layouts[id] = roundFlowUnitLayout({
      x: (rect.left - flowRect.left) / zoomFactor,
      y: (visibleTop - flowRect.top) / zoomFactor,
      width: rect.width / zoomFactor,
      height: (visibleBottom - visibleTop) / zoomFactor,
    });
  });

  return layouts;
}

export function roundFlowUnitLayout(layout: FlowUnitLayout): FlowUnitLayout {
  return {
    x: Math.round(layout.x),
    y: Math.round(layout.y),
    width: Math.round(layout.width),
    ...(typeof layout.height === "number" ? { height: Math.round(layout.height) } : {}),
  };
}

export function roundEditorBoxBlockFragmentLayout(layout: EditorBoxBlockFragmentLayout): EditorBoxBlockFragmentLayout {
  const roundFragmentPx = (value: number) => Math.round(value * 100) / 100;
  return {
    ...layout,
    fragmentIndex: Math.round(layout.fragmentIndex),
    x: Math.round(layout.x),
    y: Math.round(layout.y),
    width: Math.round(layout.width),
    height: roundFragmentPx(layout.height),
    sourceOffsetY: roundFragmentPx(layout.sourceOffsetY),
    totalHeight: roundFragmentPx(layout.totalHeight),
  };
}

export { roundTextFlowColumnBlockLayout } from "@/features/rendering/core";

export function getMeasuredColumnItemHeight(element: HTMLElement | undefined, zoomFactor: number): number {
  if (!element) {
    return 0;
  }
  return element.getBoundingClientRect().height / zoomFactor;
}

export function collectTextFlowBlockElements(unitElement: HTMLElement | undefined): Map<string, HTMLElement> {
  const elements = new Map<string, HTMLElement>();
  if (!unitElement || typeof unitElement.querySelectorAll !== "function") {
    return elements;
  }

  unitElement.querySelectorAll<HTMLElement>("[data-sigma-doc-id]").forEach((element) => {
    const blockId = element.getAttribute("data-sigma-doc-id");
    if (blockId) {
      elements.set(blockId, element);
    }
  });
  return elements;
}
