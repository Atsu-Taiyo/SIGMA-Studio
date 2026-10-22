import type { BuiltFlowModel } from "./pagination/build-flow-model";
import type { FlowPlacement, PlacedBlankPiece, PlacedLine, PlacementSegment, Region } from "./pagination/model";
import { planFlowRender, type FlowDisplacement, type FlowRenderPlan, type PlanFlowRenderOptions } from "./pagination/plan-render";

/**
 * 紙面の並べ方 (表示だけの設定。文書には保存しない)。
 *
 * - `single`: 従来どおりページを縦 1 列に並べる。
 * - `spread`: 2 ページずつ横に並べる (1|2 / 3|4 / …)。
 *
 * 文書の座標 (モデル座標) は並べ方に関係なく常に縦 1 列のまま: ページ p の上端は
 * `p * (pageHeight + pageGap)`。ページ割り・図形の座標・アンカー・保存する値はすべてモデル座標で、
 * 2 列はそれを **描くときだけ** ページごとにずらす表示変換 (`shift`) で作る。
 *
 * - モデル → 表示 (`modelToDisplay`) は描く場所でだけ使う。
 * - 表示 → モデル (`displayToModel`) はポインタや描かれた矩形を紙面座標へ読み戻す場所でだけ使う。
 *
 * 1 列ではすべての関数が恒等写像になる (ずらしは常に 0)。
 *
 * ずらしは整数 px にする。本文の変位は整数 px で描き、計測は「描かれた位置 − 変位 = 自然位置」を
 * 厳密に読む (MISS.md R14)。端数のずらしを足すと丸めで 1px 未満ずつ揺れる。
 */
export type PageArrangementMode = "single" | "spread";

export interface PageArrangementInput {
  mode: PageArrangementMode;
  pageWidth: number;
  pageHeight: number;
  pageGap: number;
  /** 横に並べたページの間隔。省略時は縦の間隔と同じ。 */
  columnGap?: number;
}

export interface PageArrangement {
  readonly mode: PageArrangementMode;
  /** 1 行に並ぶページ数。 */
  readonly columns: 1 | 2;
  readonly pageWidth: number;
  readonly pageHeight: number;
  readonly pageGap: number;
  /** モデル座標でのページの縦の刻み (`pageHeight + pageGap`)。 */
  readonly stride: number;
  /** 表示での列の横の刻み (整数 px)。1 列では 0。 */
  readonly columnPitch: number;
}

export interface ArrangementPoint {
  x: number;
  y: number;
}

export interface ArrangementRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export const IDENTITY_PAGE_SHIFT: Readonly<ArrangementPoint> = Object.freeze({ x: 0, y: 0 });

export function createPageArrangement(input: PageArrangementInput): PageArrangement {
  const columns = input.mode === "spread" ? 2 : 1;
  return {
    mode: columns === 2 ? "spread" : "single",
    columns,
    pageWidth: input.pageWidth,
    pageHeight: input.pageHeight,
    pageGap: input.pageGap,
    stride: input.pageHeight + input.pageGap,
    columnPitch: columns === 2 ? Math.round(input.pageWidth + (input.columnGap ?? input.pageGap)) : 0,
  };
}

/** 1 列 (すべての変換が恒等写像) か。 */
export function isIdentityArrangement(arrangement: PageArrangement | null | undefined): boolean {
  return !arrangement || arrangement.columns === 1;
}

export function arrangementPageColumn(arrangement: PageArrangement, page: number): number {
  return arrangement.columns === 1 ? 0 : ((page % 2) + 2) % 2;
}

export function arrangementPageRow(arrangement: PageArrangement, page: number): number {
  return arrangement.columns === 1 ? page : Math.floor(page / 2);
}

/** モデル座標の y が載るページ (間隔はその上のページに属する)。 */
export function pageIndexForModelY(arrangement: PageArrangement, y: number): number {
  if (!(arrangement.stride > 0) || !Number.isFinite(y)) return 0;
  return Math.max(0, Math.floor(y / arrangement.stride));
}

/** ページ p の中身をモデル座標から表示座標へ動かす量。1 列では常に 0。 */
export function pageShift(arrangement: PageArrangement, page: number): ArrangementPoint {
  if (arrangement.columns === 1 || page <= 0) return IDENTITY_PAGE_SHIFT;
  const row = arrangementPageRow(arrangement, page);
  return {
    x: arrangementPageColumn(arrangement, page) * arrangement.columnPitch,
    y: -Math.round((page - row) * arrangement.stride),
  };
}

/** ページ p の左上の表示座標。 */
export function pageOrigin(arrangement: PageArrangement, page: number): ArrangementPoint {
  const shift = pageShift(arrangement, page);
  return { x: shift.x, y: page * arrangement.stride + shift.y };
}

/** 表示に必要な行数。 */
export function arrangementRowCount(arrangement: PageArrangement, pageCount: number): number {
  const count = Math.max(1, pageCount);
  return arrangement.columns === 1 ? count : Math.ceil(count / 2);
}

/** 紙面の表示の寸法 (ページの外の図形のはみ出しは含まない)。 */
export function displayCanvasSize(arrangement: PageArrangement, pageCount: number): { width: number; height: number } {
  const count = Math.max(1, pageCount);
  if (arrangement.columns === 1) {
    return { width: arrangement.pageWidth, height: (count - 1) * arrangement.stride + arrangement.pageHeight };
  }
  let bottom = arrangement.pageHeight;
  for (let page = Math.max(0, count - 2); page < count; page += 1) {
    bottom = Math.max(bottom, pageOrigin(arrangement, page).y + arrangement.pageHeight);
  }
  return { width: arrangement.columnPitch + arrangement.pageWidth, height: bottom };
}

/**
 * 表示座標の点が載るページ。ページの間 (縦・横の間隔) は近いほうのページに属する。
 * 空いている最後の行の右側は「次のページ」を返す (縦 1 列で最後のページの下を指したときと同じ)。
 */
export function pageIndexAtDisplayPoint(arrangement: PageArrangement, point: ArrangementPoint): number {
  if (arrangement.columns === 1) return pageIndexForModelY(arrangement, point.y);
  const row = Math.max(0, Math.floor((point.y + arrangement.pageGap / 2) / arrangement.stride));
  const column = point.x >= arrangement.pageWidth + (arrangement.columnPitch - arrangement.pageWidth) / 2 ? 1 : 0;
  return row * 2 + column;
}

/** 表示座標の点 → モデル座標 (と、その点が属するページ)。 */
export function displayToModel(
  arrangement: PageArrangement,
  point: ArrangementPoint,
  page?: number,
): ArrangementPoint & { page: number } {
  const resolvedPage = page ?? pageIndexAtDisplayPoint(arrangement, point);
  const shift = pageShift(arrangement, resolvedPage);
  return { x: point.x - shift.x, y: point.y - shift.y, page: resolvedPage };
}

/** モデル座標の点 → 表示座標。`page` を省くと点の y が載るページで動かす。 */
export function modelToDisplay(arrangement: PageArrangement, point: ArrangementPoint, page?: number): ArrangementPoint {
  const shift = pageShift(arrangement, page ?? pageIndexForModelY(arrangement, point.y));
  return shift === IDENTITY_PAGE_SHIFT ? point : { x: point.x + shift.x, y: point.y + shift.y };
}

/**
 * 描かれた矩形 (表示座標) → モデル座標。矩形の左上が載るページのずらしを引く。
 * 正本のクリップされた続き (隠れた行) も同じずらしで読むので、縦 1 列のときと同じ値になる。
 */
export function displayRectToModel<T extends ArrangementRect>(arrangement: PageArrangement, rect: T): T {
  if (arrangement.columns === 1) return rect;
  const shift = pageShift(arrangement, pageIndexAtDisplayPoint(arrangement, { x: rect.left + 1, y: rect.top + 1 }));
  if (shift === IDENTITY_PAGE_SHIFT) return rect;
  return { ...rect, top: rect.top - shift.y, left: rect.left - shift.x };
}

/**
 * 表示座標で縦の範囲 [top, bottom] に見えているページ (先頭と末尾の番号)。
 * 2 列では行単位で数える (同じ行の 2 ページは一緒に見える)。
 */
export function visiblePageSpanForDisplayRange(
  arrangement: PageArrangement,
  top: number,
  bottom: number,
  pageCount: number,
): { start: number; end: number } {
  const last = Math.max(0, pageCount - 1);
  const stride = arrangement.stride > 0 ? arrangement.stride : 1;
  const firstRow = Math.max(0, Math.floor(top / stride));
  const lastRow = Math.max(firstRow, Math.floor(Math.max(top, bottom) / stride));
  const perRow = arrangement.columns;
  return {
    start: Math.min(last, firstRow * perRow),
    end: Math.min(last, lastRow * perRow + perRow - 1),
  };
}

/**
 * 配置結果を表示座標へ写す。各領域 (と、そこに置いた行・空白) を、その領域のページのずらしだけ動かす。
 * 描画の指示 (`planFlowRender`) にこれを渡すと、ユニット・ブロックの変位・断片・枠片が表示の位置になる。
 * 自然配置 (行の `top` など) には触れないので、計測は従来どおり変位を引いて同じ自然配置を読む。
 */
export function arrangeFlowPlacement(placement: FlowPlacement, arrangement: PageArrangement): FlowPlacement {
  if (arrangement.columns === 1) return placement;
  const shifts = placement.regions.map((region) => pageShift(arrangement, region.page));
  const regions: Region[] = placement.regions.map((region, index) => {
    const shift = shifts[index];
    return {
      ...region,
      x: region.x + shift.x,
      dx: region.dx + shift.x,
      top: region.top + shift.y,
      bottom: region.bottom + shift.y,
    };
  });
  const shiftOf = (regionIndex: number) => shifts[regionIndex] ?? IDENTITY_PAGE_SHIFT;
  const lines = new Map<string, PlacedLine>();
  for (const [key, line] of placement.lines) {
    const shift = shiftOf(line.regionIndex);
    lines.set(key, { ...line, y: line.y + shift.y, dx: line.dx + shift.x, dy: line.dy + shift.y });
  }
  const blanks: PlacedBlankPiece[] = placement.blanks.map((piece) => ({ ...piece, y: piece.y + shiftOf(piece.regionIndex).y }));
  const segments: PlacementSegment[] = placement.segments.map((segment) => {
    const shift = shiftOf(segment.regionIndex);
    return { ...segment, dx: segment.dx + shift.x, dy: segment.dy + shift.y };
  });
  return {
    ...placement,
    regions,
    lines,
    blanks,
    segments,
    diagnostics: {
      ...placement.diagnostics,
      balancedTails: placement.diagnostics.balancedTails.map((tail) => ({
        ...tail,
        top: tail.top + pageShift(arrangement, tail.page).y,
      })),
    },
  };
}

export interface ArrangedFlowRenderPlan {
  /** 描く指示 (表示座標)。1 列では `model` と同じオブジェクト。 */
  display: FlowRenderPlan;
  /** モデル座標の描画計画。ユニットがどの段に置かれたか (サイド注の位置) はこちらで判断する。 */
  model: FlowRenderPlan;
}

/**
 * 描画計画をページの並びに合わせて作る。表示の変位には、その要素が載るページのずらし
 * (`pageShiftX/Y`) を書き添える。計測はそれを引いてモデル座標を読む。
 */
export function planArrangedFlowRender(
  built: BuiltFlowModel,
  placement: FlowPlacement,
  arrangement: PageArrangement,
  options: PlanFlowRenderOptions = {},
): ArrangedFlowRenderPlan {
  const model = planFlowRender(built, placement, options);
  if (arrangement.columns === 1) return { display: model, model };
  const display = planFlowRender(built, arrangeFlowPlacement(placement, arrangement), options);
  const annotate = (value: FlowDisplacement, shiftX: number, shiftY: number): FlowDisplacement => (
    shiftX === 0 && shiftY === 0 ? value : { ...value, pageShiftX: shiftX, pageShiftY: shiftY }
  );
  for (const unit of built.units) {
    const displayUnit = display.unitDisplacements[unit.id];
    const modelUnit = model.unitDisplacements[unit.id];
    if (!displayUnit || !modelUnit) continue;
    display.unitDisplacements[unit.id] = annotate(displayUnit, displayUnit.dx - modelUnit.dx, displayUnit.dy - modelUnit.dy);
    for (const node of unit.nodes) {
      const displayNode = display.nodeDisplacements[node.id];
      const modelNode = model.nodeDisplacements[node.id];
      // 相対の変位が 0 のブロックは描くときに何も付かない (ユニットと同じページにある)。
      if (!displayNode || !modelNode || (displayNode.dx === 0 && displayNode.dy === 0)) continue;
      display.nodeDisplacements[node.id] = annotate(
        displayNode,
        Math.round(displayUnit.dx + displayNode.dx - modelUnit.dx - modelNode.dx),
        Math.round(displayUnit.dy + displayNode.dy - modelUnit.dy - modelNode.dy),
      );
    }
  }
  return { display, model };
}
