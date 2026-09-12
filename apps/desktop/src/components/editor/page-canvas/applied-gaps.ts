/**
 * 一度の DOM 走査で「今そこに描かれている gap」を引けるようにする索引。
 *
 * 再ページ割りは walk する項目ごとに「その上に実際に描かれている隙間」を必要とする。
 * 従来はその都度 `flow.querySelector(...)` していたため、1500 ブロックの文書では 1 回の
 * recompute で 1500 回の部分木走査が走っていた (打鍵ごとに rAF で数十 ms)。走査を 1 パスに
 * まとめても、**値は DOM から読む**という設計は変えていない — state から読むと、state と
 * DOM がずれた瞬間に `topNat` が gap-free でなくなり、同じ文書に自己整合なレイアウトが
 * 複数生まれる (PageCanvasEditor の walk 側コメント参照)。
 *
 * `offsetHeight` と computed margin はレイアウト値なので、キャンバスの transform には
 * 影響されない。
 */

export interface AppliedGapIndex {
  /** `data-page-break-spacer` の高さ。marker widget は同じ block id を持つが含めない。 */
  readonly spacerHeightByBlockId: ReadonlyMap<string, number>;
  readonly unitElementByUnitId: ReadonlyMap<string, HTMLElement>;
  /**
   * フローユニット内部に描かれている spacer の高さ合計。
   *
   * ユニットの矩形高さには前パスで内部に入った spacer が含まれるので、それを引かないと
   * 「高さがページに収まるか」の判定が自分の出力に依存する (収まらない → 分割 → 内部に
   * spacer → さらに高くなる、の閉ループ)。
   */
  readonly innerSpacerHeightByUnitId: ReadonlyMap<string, number>;
  /** `getComputedStyle` は強制同期レイアウトを起こすので、必要になった unit だけ測る。 */
  readonly unitMarginTopByUnitId: Map<string, number>;
}

export type AppliedGapItem =
  | { kind: "block"; id: string }
  | { kind: "unit"; unitId: string };

export function buildAppliedGapIndex(flow: HTMLElement): AppliedGapIndex {
  const spacerHeightByBlockId = new Map<string, number>();
  const innerSpacerHeightByUnitId = new Map<string, number>();
  // セレクタから `[data-page-break-spacer]` を落とすと改ページ marker まで拾い、同じ
  // 改ページの gap を二重に数える。
  for (const element of flow.querySelectorAll<HTMLElement>("[data-page-break-spacer][data-page-break-block-id]")) {
    const height = element.offsetHeight;
    // ユニット内部の合計は「実際にそこにある高さ」なので、同じ block id が 2 つあっても両方数える。
    const ownerUnitId = element.closest<HTMLElement>("[data-flow-unit-id]")
      ?.getAttribute("data-flow-unit-id");
    if (ownerUnitId) {
      innerSpacerHeightByUnitId.set(ownerUnitId, (innerSpacerHeightByUnitId.get(ownerUnitId) ?? 0) + height);
    }
    const blockId = element.getAttribute("data-page-break-block-id");
    // 最初の 1 件を採るのは querySelector と同じ意味にするため。
    if (!blockId || spacerHeightByBlockId.has(blockId)) {
      continue;
    }
    spacerHeightByBlockId.set(blockId, height);
  }

  const unitElementByUnitId = new Map<string, HTMLElement>();
  for (const element of flow.querySelectorAll<HTMLElement>("[data-flow-unit-id]")) {
    const unitId = element.getAttribute("data-flow-unit-id");
    if (!unitId || unitElementByUnitId.has(unitId)) {
      continue;
    }
    unitElementByUnitId.set(unitId, element);
  }

  return {
    spacerHeightByBlockId,
    innerSpacerHeightByUnitId,
    unitElementByUnitId,
    unitMarginTopByUnitId: new Map(),
  };
}

/** 指定の unit の内部に今描かれている spacer の高さ合計 (px)。 */
export function readInnerSpacerHeightPx(index: AppliedGapIndex, unitId: string): number {
  return index.innerSpacerHeightByUnitId.get(unitId) ?? 0;
}

/** 指定の unit に今かかっている marginTop (px)。同じ unit の再測定はしない。 */
export function readUnitMarginTopPx(index: AppliedGapIndex, unitId: string): number {
  const cached = index.unitMarginTopByUnitId.get(unitId);
  if (cached !== undefined) {
    return cached;
  }
  const element = index.unitElementByUnitId.get(unitId);
  if (!element) {
    return 0;
  }
  const marginTop = Number.parseFloat(window.getComputedStyle(element).marginTop);
  const value = Number.isFinite(marginTop) ? marginTop : 0;
  index.unitMarginTopByUnitId.set(unitId, value);
  return value;
}

/**
 * walk 中の項目の上に実際に描かれている gap (px)。
 *
 * ブロックの gap は ProseMirror の spacer widget、エリアの gap はフローユニットの margin。
 */
export function readAppliedGapPx(index: AppliedGapIndex, item: AppliedGapItem): number {
  if (item.kind === "block") {
    return index.spacerHeightByBlockId.get(item.id) ?? 0;
  }
  return readUnitMarginTopPx(index, item.unitId);
}
