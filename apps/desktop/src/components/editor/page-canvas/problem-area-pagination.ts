import {
  getSafeProblemAreaMinHeightPx,
  hasManualBreakInside,
  isProblemAreaFlowEligible,
  type ProblemAreaFlowEligibilityBlock,
} from "@/features/rendering/core";
import { readInnerSpacerHeightPx, type AppliedGapIndex } from "./applied-gaps";
import { isProblemFrameArea } from "./block-ops";
import { getProblemAreaUnitGapKey } from "./render-units";
import type { RenderUnit } from "./types";

export interface AtomicProblemAreaItem {
  /** The first problem area carries its gap on the problem id (see ProblemAreaFlowUnit). */
  gapKey: string;
  /** The unit whose margin renders the area gap. */
  firstUnitId: string;
  /** Top of the area, unzoomed, relative to the flow top. */
  top: number;
  /** Gap-free rendered area height, including its reserved minHeight blank space. */
  height: number;
  /** 論理予約高のうち、現在の area DOM がまだ占有していない高さ。 */
  reservedHeightDeficitPx: number;
  ownedBlockIds: string[];
}

export interface ReservedProblemAreaEndItem {
  /** 現在の DOM におけるエリア末尾。DOM順の比較には補正前の実測値を使う。 */
  top: number;
  /** min-height に吸収された spacer / DOM に未実現の予約高を natural 化時だけ戻す。 */
  naturalTopAdjustmentPx: number;
  /** pagination result には書き出さない仮想キー。 */
  gapKey: string;
}

export interface ProblemAreaPaginationItems {
  atomicItems: AtomicProblemAreaItem[];
  reservedAreaEnds: ReservedProblemAreaEndItem[];
  splitFrameUnits: Array<{ unitId: string; blockIds: string[] }>;
}

type NestedProblemAreaEligibilityBlock = ProblemAreaFlowEligibilityBlock & {
  children?: readonly unknown[];
  blocks?: readonly unknown[];
};

function flattenProblemAreaEligibilityBlocks(
  blocks: readonly unknown[],
): ProblemAreaFlowEligibilityBlock[] {
  const flattened: ProblemAreaFlowEligibilityBlock[] = [];
  const visit = (candidate: unknown) => {
    if (!candidate || typeof candidate !== "object") {
      return;
    }
    const block = candidate as NestedProblemAreaEligibilityBlock;
    flattened.push(block);
    block.children?.forEach(visit);
    block.blocks?.forEach(visit);
  };
  blocks.forEach(visit);
  return flattened;
}

/**
 * 1 段組で問題エリアを丸ごと送るか、内部ブロックを通常フローへ戻すかの純粋な判定。
 *
 * `gapFreeHeightPx` は DOM 実測から、そのエリア内に現在描かれている spacer を除いた高さだけを
 * 渡す。前パスの出力を入力へ混ぜないことで、atomic と block walk が毎フレーム入れ替わる
 * 閉ループを作らない。
 */
export function shouldKeepProblemAreaAtomic({
  flowEligible,
  gapFreeHeightPx,
  contentHeightPx,
  minHeightMm,
  hasManualBreak,
}: {
  /** `isProblemAreaFlowEligible` の結果。false は枠付き prompt / full-span を表す。 */
  flowEligible: boolean;
  gapFreeHeightPx: number;
  contentHeightPx: number;
  minHeightMm: number;
  /** エリア先頭以外に明示的な改ページがあるか。 */
  hasManualBreak: boolean;
}): boolean {
  // 明示的な改ページは、枠/full-spanだけでなくminHeightの自動keep-togetherにも必ず勝つ。
  if (hasManualBreak) {
    return false;
  }
  if (!flowEligible) {
    return gapFreeHeightPx <= contentHeightPx + 0.5;
  }

  // minHeight の予約空白はブロック自身の高さには現れない。エリアの実測ごと 1 ページに
  // 収まる間だけ keep-together にし、収まらない長いエリアは通常のブロック分割へ戻す。
  return minHeightMm > 0 && gapFreeHeightPx <= contentHeightPx + 0.5;
}

/**
 * Problem areas that automatic pagination must keep whole.
 *
 * The shared eligibility predicate keeps the same semantic granularity as the page-column
 * and print engines: framed prompt/full-span areas are atomic unless the user inserted a
 * manual break. Separately, a `minHeightMm` reservation that fits one page is kept with its
 * content. A taller ordinary area falls back to the block walk, so its content can paginate.
 */
export function collectProblemAreaPaginationItems(
  appliedGaps: AppliedGapIndex,
  flowRect: DOMRect,
  units: RenderUnit[],
  zoomFactor: number,
  contentHeightPx: number,
): ProblemAreaPaginationItems {
  const unitElements = appliedGaps.unitElementByUnitId;
  type AreaUnit = Extract<RenderUnit, { type: "problemArea" | "problemLayoutSection" }>;
  const byArea = new Map<string, AreaUnit[]>();
  for (const unit of units) {
    if (unit.type !== "problemArea" && unit.type !== "problemLayoutSection") {
      continue;
    }
    const key = `${unit.problem.id}\u0000${unit.area}`;
    const existing = byArea.get(key);
    if (existing) {
      existing.push(unit);
    } else {
      byArea.set(key, [unit]);
    }
  }

  const atomicItems: AtomicProblemAreaItem[] = [];
  const reservedAreaEnds: ReservedProblemAreaEndItem[] = [];
  const splitFrameUnits: ProblemAreaPaginationItems["splitFrameUnits"] = [];
  for (const areaUnits of byArea.values()) {
    const problem = areaUnits[0].problem;
    const area = areaUnits[0].area;

    let firstUnit: AreaUnit | null = null;
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    // Summed, not bottom-minus-top: the span between units may include a previous pass's
    // margin. Feeding that span back into classification would make atomic/block alternate.
    let height = 0;
    const ownedBlockIds: string[] = [];
    for (const unit of areaUnits) {
      const element = unitElements.get(unit.id);
      if (!element) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      const unitTop = (rect.top - flowRect.top) / zoomFactor;
      const unitBottom = unitTop + rect.height / zoomFactor;
      if (unitTop < top) {
        top = unitTop;
        firstUnit = unit;
      }
      bottom = Math.max(bottom, unitBottom);
      // rect はズーム込み、spacer はレイアウト値。座標系を揃えてから前パスの出力を引く。
      height += rect.height / zoomFactor - readInnerSpacerHeightPx(appliedGaps, unit.id);
      if (unit.type === "problemLayoutSection") {
        ownedBlockIds.push(unit.section.id);
      }
      for (const block of unit.blocks) {
        ownedBlockIds.push(block.id);
      }
    }
    if (!firstUnit || !Number.isFinite(top) || !Number.isFinite(bottom) || height <= 0) {
      continue;
    }

    const rawMinHeightMm = problem.areaLayout?.[area]?.minHeightMm ?? 0;
    const minHeightPx = getSafeProblemAreaMinHeightPx(rawMinHeightMm, contentHeightPx);
    const minHeightMm = minHeightPx > 0 ? rawMinHeightMm : 0;
    // A spacer can be absorbed by CSS min-height without increasing getBoundingClientRect().
    // Subtracting the whole spacer would then erase part of the reservation, so retain its
    // explicit floor after making the measured contribution gap-free.
    const gapFreeHeight = Math.max(height, minHeightPx);
    // problemArea は自身の CSS min-height、layout-section-only は専用レンダラで予約高を
    // 実DOMに持つ。そこへ吸収された旧 spacer を deficit として再出力してはいけない。
    // DOM側に予約キャリアが無い複数layout-section構成だけ、spacerを除いた自然高との差を補う。
    const domReservesMinHeight = areaUnits.some((unit) => unit.type === "problemArea")
      || (areaUnits.length === 1 && areaUnits[0].type === "problemLayoutSection");
    // layoutSection / boxBlock の子にある手動改ページも area 全体の atomic 判定より
    // 先に効かせる。section 自身を先頭に含めることで、その第1子も area 内の break になる。
    const eligibilityBlocks = flattenProblemAreaEligibilityBlocks(areaUnits.flatMap((unit) => (
      unit.type === "problemLayoutSection" ? [unit.section] : unit.blocks
    )));
    const flowEligible = isProblemAreaFlowEligible({
      isFullSpan: problem.areaLayout?.[area]?.columnSpan === "full",
      isFramedArea: problem.frame?.enabled === true && isProblemFrameArea(area),
      blocks: eligibilityBlocks,
      gapFreeHeightPx: gapFreeHeight,
      segmentHeightPx: contentHeightPx,
    });
    const manualBreakInside = hasManualBreakInside(eligibilityBlocks);
    const keepAtomic = shouldKeepProblemAreaAtomic({
      flowEligible,
      gapFreeHeightPx: gapFreeHeight,
      contentHeightPx,
      minHeightMm,
      hasManualBreak: manualBreakInside,
    });
    if (!keepAtomic) {
      if (problem.frame?.enabled === true && isProblemFrameArea(area)) {
        for (const unit of areaUnits) {
          if (unit.type === "problemArea" && unit.blocks.length > 0) {
            splitFrameUnits.push({
              unitId: unit.id,
              blockIds: unit.blocks.map((block) => block.id),
            });
          }
        }
      }
      if (minHeightMm > 0) {
        // CSS min-height が作った長い自然座標を通常 block walk が「単なる飛び」として
        // 引き戻さないよう、エリア末尾で通過済みページ数を確定する仮想境界を置く。
        // 補正を実測 top に足すと直後ブロックより後へ sort されるため、natural 化時だけ使う。
        // DOM が min-height を持つ場合は spacer の吸収分、持たない複数 section の場合は
        // 未実現予約高になり、どちらも同じ gap-free 差分で表せる。
        reservedAreaEnds.push({
          top: bottom,
          naturalTopAdjustmentPx: Math.max(0, gapFreeHeight - height),
          gapKey: `problem-area-end:${problem.id}:${area}`,
        });
      }
      continue;
    }

    const gapKey = getProblemAreaUnitGapKey(firstUnit);
    atomicItems.push({
      gapKey,
      firstUnitId: firstUnit.id,
      top,
      height: gapFreeHeight,
      reservedHeightDeficitPx: domReservesMinHeight ? 0 : Math.max(0, gapFreeHeight - height),
      ownedBlockIds,
    });
  }
  return { atomicItems, reservedAreaEnds, splitFrameUnits };
}
