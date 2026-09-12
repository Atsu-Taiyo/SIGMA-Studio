import type { BlockExtent, MeasuredBlock } from "@/components/editor/overlay-canvas/anchor";

import type { RenderUnit } from "./types";

/**
 * 本文の実測 1 パス分。`measureFlowBlocks` の戻り値そのもの。
 *
 * `ordered` はページ割りが歩く単位、`anchorable` は図形が張り付けるブロック (入れ子を含む)。
 * どちらも **常に文書全体**を表す: 部分計測にすると図形の再アンカー基準
 * (`latestMeasureRef`) と全文の配置 snapshot が壊れる。
 */
export interface FlowMeasurement {
  ordered: MeasuredBlock[];
  anchorable: MeasuredBlock[];
  tops: Map<string, number>;
  rects: Map<string, MeasuredBlock>;
  extents: Map<string, BlockExtent>;
  /**
   * ユニットごとに分けた実測。**次のパスで「列挙ごと」持ち越す**ための単位。
   *
   * これが無いと、測らないブロックも「どのブロックが居るか」を知るためだけに DOM を全件
   * 列挙する羽目になる (1,500 ブロックの `querySelectorAll` + 属性読み)。ユニット単位で
   * 覚えておけば、汚れていないユニットは DOM に触らずそのまま使える。
   */
  segments: FlowMeasurementSegment[];
}

/** 1 ユニット分の実測 (文書順)。`unitId` が null のものはユニットの外 (running region 等)。 */
export interface FlowMeasurementSegment {
  unitId: string | null;
  entries: MeasuredBlockEntry[];
}

/** 文書順に並んだ、今このパスで存在するブロック。測り直したものと前回のものが混ざる。 */
export interface MeasuredBlockEntry {
  block: MeasuredBlock;
  isFlowUnit: boolean;
}

/**
 * 測り直した分と前回分を合わせて、**文書全体の**計測に戻す。
 *
 * 打鍵で位置が変わるのは打った場所より下だけなので、上のブロックは前回の値をそのまま使える。
 * ただし下流 (ページ割り・図形の再アンカー・古い測定の検出) はどれも全体のマップを前提に
 * しているので、ここで必ず埋め直す。
 */
export function composeFlowMeasurement(segments: readonly FlowMeasurementSegment[]): FlowMeasurement {
  const entries = segments.flatMap((segment) => segment.entries);
  const tops = new Map<string, number>();
  const rects = new Map<string, MeasuredBlock>();
  const extents = new Map<string, BlockExtent>();
  const ordered: MeasuredBlock[] = [];
  const anchorable: MeasuredBlock[] = [];

  for (const { block, isFlowUnit } of entries) {
    tops.set(block.id, block.top);
    rects.set(block.id, block);
    extents.set(block.id, { top: block.top, height: block.height ?? 0 });
    anchorable.push(block);
    if (isFlowUnit) {
      ordered.push(block);
    }
  }

  ordered.sort(byTop);
  anchorable.sort(byTop);
  return { ordered, anchorable, tops, rects, extents, segments: [...segments] };
}

function byTop(a: MeasuredBlock, b: MeasuredBlock): number {
  return a.top - b.top;
}

/**
 * 位置が動いていないパスの合成。**並べ替えをしない**のが肝。
 *
 * 1 文字打っても行が増えなければ、動いたブロックは 1 つも無い (測り直したブロックも同じ位置・
 * 同じ高さ)。それでも下流は文書全体のマップを要求するので、前回のマップを写して、測り直した
 * ぶんだけ差し替える。1,500 ブロックの並べ替えを毎打鍵やらないだけで実測が半分以下になる。
 *
 * 使ってよいのは「順序が変わらないと分かっているとき」だけ (`isSameBlockGeometry` で確認済み)。
 */
export function patchFlowMeasurement(
  previous: FlowMeasurement,
  changed: readonly MeasuredBlock[],
): FlowMeasurement {
  if (changed.length === 0) {
    return previous;
  }
  const changedById = new Map(changed.map((block) => [block.id, block]));
  const replace = (blocks: MeasuredBlock[]): MeasuredBlock[] => (
    blocks.map((block) => changedById.get(block.id) ?? block)
  );
  const tops = new Map(previous.tops);
  const rects = new Map(previous.rects);
  const extents = new Map(previous.extents);
  for (const block of changed) {
    tops.set(block.id, block.top);
    rects.set(block.id, block);
    extents.set(block.id, { top: block.top, height: block.height ?? 0 });
  }
  return {
    ordered: replace(previous.ordered),
    anchorable: replace(previous.anchorable),
    tops,
    rects,
    extents,
    // 位置が動いていないパスなので、ブロックの並び (= 列挙結果) も前回のまま。
    segments: previous.segments.map((segment) => ({
      unitId: segment.unitId,
      entries: segment.entries.map((entry) => {
        const next = changedById.get(entry.block.id);
        return next ? { block: next, isFlowUnit: entry.isFlowUnit } : entry;
      }),
    })),
  };
}

/**
 * 前回の列挙をそのまま使ってよいか。
 *
 * 使えるのは「ユニットの並びが 1 つも変わっていない」ときだけ。チャンクの切り直しでブロックが
 * 隣のユニットへ移ると、移った先のユニット id (= 先頭ブロック id) が変わるので、ここで弾ける。
 * 弾いた場合は全部列挙し直す (安全側)。
 */
export function canCarrySegments(
  previous: FlowMeasurement | null,
  unitIds: readonly string[],
): previous is FlowMeasurement {
  if (!previous) {
    return false;
  }
  const previousUnitIds = previous.segments
    .filter((segment) => segment.unitId !== null)
    .map((segment) => segment.unitId);
  return previousUnitIds.length === unitIds.length
    && previousUnitIds.every((unitId, index) => unitId === unitIds[index]);
}

/**
 * このパスでどこまで測り直すか。
 *
 * - 汚れたユニットが複数あるときは**描画順で一番上**から。下のユニットだけ測り直すと、その上に
 *   ある汚れたユニットの高さ変化が反映されず、以降のページ割りが古い位置のまま進む。
 * - 知らないユニット id (作り直しで消えた等) が混ざっていたら安全側に倒して全体を測り直す。
 * - 前回の計測以降どこも汚れていないなら、幾何は前回のまま (`carry`)。別の理由で走った
 *   再計算に相乗りしただけなので、測り直す理由が無い。
 */
export function resolveMeasureScope({
  dirtyUnitIds,
  fullDirty,
  hasPrevious,
  incrementalEligible,
  unitsChangedSinceMeasure,
  units,
}: {
  dirtyUnitIds: ReadonlySet<string>;
  fullDirty: boolean;
  hasPrevious: boolean;
  /** 増分計測を許してよい紙面か (`canMeasureIncrementally`)。 */
  incrementalEligible: boolean;
  /** 前回の計測以降に描画ユニットの並びが変わったか。 */
  unitsChangedSinceMeasure: boolean;
  units: readonly RenderUnit[];
}): MeasureScope {
  if (fullDirty || !hasPrevious || !incrementalEligible) {
    return { kind: "all" };
  }
  if (dirtyUnitIds.size === 0) {
    // 汚れの申告は**最適化のヒント**であって正しさの前提ではない。申告が無いのに紙面の中身が
    // 変わっている (ユニットの並びが違う) なら、誰かが申告を忘れている — 黙って前回の幾何で
    // ページを割ると、例外もログも出ないまま 1 フレーム前の紙面が出る。安全側に倒す。
    return unitsChangedSinceMeasure ? { kind: "all" } : { kind: "carry" };
  }
  const known = new Set<string>();
  for (const unit of units) {
    known.add(unit.id);
  }
  for (const id of dirtyUnitIds) {
    if (!known.has(id)) {
      return { kind: "all" };
    }
  }
  // 汚れたユニットが 1 つなら「そのユニットだけ測って、動いていなければ下流は前回のまま」。
  // 複数あるときは一番上から下を全部測り直す (間の非汚染ユニットも動きうるため)。
  const dirtyUnits = units.filter((unit) => dirtyUnitIds.has(unit.id));
  if (dirtyUnits.length === 1) {
    return { kind: "dirtyUnit", unitId: dirtyUnits[0].id };
  }
  const first = dirtyUnits[0];
  return first ? { kind: "fromUnit", unitId: first.id } : { kind: "all" };
}

/**
 * 増分計測に載せてよい紙面か。
 *
 * 載せるのは**本文だけの 1 段組**に限る。問題エリア・段組みセクション・2 段組は、1 ブロックの
 * 変化がまわりのユニットの配置 (エリアの高さ・段の割り付け・枠の分割) まで動かすので、
 * 「打った場所より下だけ」という前提が成り立たない。実測でも、これらを増分にすると 1 打鍵
 * あたりのレイアウト確定パスが 4.9 → 9.5 回に増えた (пass が互いを呼び合って収束が遅れる)。
 * 安全側 = 全部測り直す。
 */
export function canMeasureIncrementally(
  units: readonly RenderUnit[],
  isColumnFlow: boolean,
): boolean {
  return !isColumnFlow && units.every((unit) => unit.type === "textFlow");
}

/** `layout-measure.ts` が読む実測範囲。 */
export type MeasureScope =
  | { kind: "all" }
  | { kind: "carry" }
  | { kind: "dirtyUnit"; unitId: string }
  | { kind: "fromUnit"; unitId: string };

/** 同じブロックとして扱える誤差 (サブピクセルのゆらぎ)。 */
const BLOCK_GEOMETRY_EPSILON_PX = 0.05;

/**
 * 増分計測を続けてよい回数。
 *
 * 増分は「前回との差」で判断するので、持ち越した値に乗った 1px 未満の丸めがそのまま次の基準に
 * なる。1 回ぶんは無視できても、打鍵の間ずっと持ち越すと積み上がって図形の位置やページ割りが
 * 静かにずれる。一定回数で全部測り直し、累積を切る (打鍵 1 回 ≒ 1〜2 パスなので、体感には
 * 出ない頻度)。
 */
export const MAX_CONSECUTIVE_INCREMENTAL_MEASURES = 40;

/**
 * 測り直した結果が前回と同じ場所・同じ高さか。
 *
 * ここが「汚れたユニットだけ測って、下流は前回のまま使ってよい」の判定。1 文字打っても行が
 * 増えなければユニットの高さは変わらず、下のブロックは 1px も動かない — 実測の 99% はこの形。
 */
export function isSameBlockGeometry(
  measured: MeasuredBlock,
  previous: MeasuredBlock | undefined,
): boolean {
  return previous !== undefined
    && Math.abs(measured.top - previous.top) <= BLOCK_GEOMETRY_EPSILON_PX
    && Math.abs((measured.height ?? 0) - (previous.height ?? 0)) <= BLOCK_GEOMETRY_EPSILON_PX;
}
