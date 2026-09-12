import {
  normalizeOverlaySnapshot,
  type OverlayShape,
  type OverlaySnapshot,
  type PageLayout,
  type SigmaDocument,
} from "@/features/document";
import { createTranslator, DEFAULT_LOCALE, type Translate } from "@/lib/i18n";
import { areStructurallyEqual } from "@/lib/structural-equality";

// renderer (EditorShell.tsx) 専用のブロック単位3-wayマージ。electron/mcp 専用の
// sigma-doc-block-hash.ts (node:crypto使用) はブラウザバンドルに入れられないため、ここでは
// オブジェクトのキー順に依存しない構造比較を使う。
//
// 粒度についての判断: 本文ブロックは「document.content 直下のトップレベルブロックID」単位で
// 3-wayマージする。同じトップレベルブロック(例えば1つのproblemブロック)の中で人間とAIが
// 別々のエリア(prompt/solutionなど)を編集した場合でも、このブロックは「両方が変更」した扱いに
// なる。1階層深いネスト単位(problemのエリア別、list項目別など)までの部分木差し替えは、正しく
// 行うには十分なテストを伴う複雑な木構造編集ロジックが必要になり、今回のスコープでは
// 「誤マージだけは絶対に避ける」という要件に対してリスクに見合わないと判断し、あえて
// トップレベルブロック単位に留めている。
//
// 並び順 (ID列) は、両側が構成を変えた場合もアンカー基準で3-wayマージする。承認IPCの往復中に
// ユーザーが改行で段落を足し、AIも別の位置へブロックを挿す「同時挿入」は競合ではなく、
// 両方を残すのが正しい。判断できないケース(同じIDを両側が新規追加した、並べ替えが食い違う)
// だけは諦める。
//
// タイムスタンプ (`document.updatedAt`, `pageLayout.overlay.updatedAt`) は競合判定から外す。
// 保存経路もキー入力も「内容は同じで updatedAt だけ違うコピー」を作るため、これを内容差分と
// して数えると、承認のたびにメタ競合で必ずマージが失敗していた。

/** 内容ではなく「最後に書いた時刻」を記録するだけのフィールド。競合判定から外す。 */
const VOLATILE_DOCUMENT_FIELDS = ["updatedAt"] as const;

export type MergeConflictResolution = "fail" | "prefer-theirs";

export interface MergeExternalDocumentChangeOptions {
  /**
   * 解決できない競合をどう扱うか。
   *
   * - `"fail"` (既定): 誤マージを避けて諦める。呼び出し側は全文リロードなどへフォールバックする。
   * - `"prefer-theirs"`: 競合した単位だけ theirs (承認済みAI正本/ディスク正本) を採り、
   *   競合していない mine の編集はそのまま残す。ユーザーが「適用」を押したAI承認経路で使う —
   *   競合を理由に教材ファイルを増やさず、同じ1ファイルを編集し続けるための決定。
   *   採用の直前に現在の文書をundoスタックへ積むのは呼び出し側の責務。
   */
  resolution?: MergeConflictResolution;
  t?: Translate<"editor">;
}

export type MergeExternalDocumentChangeResult =
  | { ok: true; merged: SigmaDocument; resolvedConflicts?: string[] }
  | { ok: false; reason: string };

/**
 * base (rendererが最後にディスクと同期した時点の文書) を基準に、mine (人間の未保存編集を
 * 含む現在のエディタ状態) と theirs (ディスク上の新しい文書、例: AI提案の承認で保存された
 * もの) を3-wayマージする。既定は保守的で、同じ対象を両方が変更していたら ok:false を返す。
 * `resolution: "prefer-theirs"` を渡した場合は、その競合単位だけ theirs を採用して続行する。
 */
export function mergeExternalDocumentChange(
  base: SigmaDocument,
  mine: SigmaDocument,
  theirs: SigmaDocument,
  options: MergeExternalDocumentChangeOptions = {},
): MergeExternalDocumentChangeResult {
  const t = options.t ?? createTranslator(DEFAULT_LOCALE, "editor");
  const resolution = options.resolution ?? "fail";

  if (areStructurallyEqual(mine, base)) {
    // 人間の未保存編集が無い (mineはbaseから何も変わっていない) 単純なケース。
    return { ok: true, merged: theirs };
  }
  if (areStructurallyEqual(mine, theirs)) {
    // 人間の編集がたまたま theirs と完全に一致している (defensive: 実際にはほぼ起きない)。
    return { ok: true, merged: theirs };
  }

  const resolvedConflicts: string[] = [];

  const metaResult = mergeDocumentMeta(base, mine, theirs, t, resolution, resolvedConflicts);
  if (!metaResult.ok) {
    return metaResult;
  }

  const contentResult = mergeIdentifiedUnits(
    base.content,
    mine.content,
    theirs.content,
    resolution,
    resolvedConflicts,
    blockMergeMessages(t),
  );
  if (!contentResult.ok) {
    return contentResult;
  }

  const shapesResult = mergeOverlayShapes(base, mine, theirs, t, resolution, resolvedConflicts);
  if (!shapesResult.ok) {
    return shapesResult;
  }

  const mergedPageLayout = applyMergedShapesToPageLayout(metaResult.pageLayout, shapesResult.units);

  return {
    ok: true,
    merged: {
      ...metaResult.rest,
      content: contentResult.units,
      ...(mergedPageLayout !== undefined ? { pageLayout: mergedPageLayout } : {}),
    },
    ...(resolvedConflicts.length > 0 ? { resolvedConflicts } : {}),
  };
}

// ----- ドキュメントレベルのメタ (content / overlay図形以外のトップレベルフィールド) -----

type DocumentMetaMergeResult =
  | { ok: true; rest: Omit<SigmaDocument, "content" | "pageLayout">; pageLayout: PageLayout | undefined }
  | { ok: false; reason: string };

function mergeDocumentMeta(
  base: SigmaDocument,
  mine: SigmaDocument,
  theirs: SigmaDocument,
  t: Translate<"editor">,
  resolution: MergeConflictResolution,
  resolvedConflicts: string[],
): DocumentMetaMergeResult {
  const baseMeta = extractMetaForComparison(base);
  const mineMeta = extractMetaForComparison(mine);
  const theirsMeta = extractMetaForComparison(theirs);

  const mineChanged = !areStructurallyEqual(mineMeta, baseMeta);
  const theirsChanged = !areStructurallyEqual(theirsMeta, baseMeta);
  const conflicted = mineChanged && theirsChanged && !areStructurallyEqual(mineMeta, theirsMeta);

  if (conflicted) {
    if (resolution !== "prefer-theirs") {
      return { ok: false, reason: t("merge.metadata") };
    }
    resolvedConflicts.push(t("merge.metadata"));
  }

  // theirsが変更していれば(mineが無変更、または両方が同じ変更なら)theirsを、mineだけが変更して
  // いればmineを、どちらも無変更ならbase(≒どちらとも同じ)を採用する。
  const source = theirsChanged ? theirs : mineChanged ? mine : base;
  const rest = omitContentAndPageLayout(source);
  return {
    ok: true,
    // 記録用フィールドはディスク正本 (theirs) の値へ揃える。採用結果が内容としてディスクと
    // 同じなら「保存済み」と判定できるようにするため、ここで mine 側の古い時刻を残さない。
    rest: withVolatileFieldsFrom(rest, theirs),
    pageLayout: mergeOverlayTimestamp(source.pageLayout, theirs.pageLayout),
  };
}

function omitContentAndPageLayout(document: SigmaDocument): Omit<SigmaDocument, "content" | "pageLayout"> {
  const rest: Partial<SigmaDocument> = { ...document };
  delete rest.content;
  delete rest.pageLayout;
  return rest as Omit<SigmaDocument, "content" | "pageLayout">;
}

function omitShapes(overlaySnapshot: OverlaySnapshot): Omit<OverlaySnapshot, "shapes"> {
  const rest: Partial<OverlaySnapshot> = { ...overlaySnapshot };
  delete rest.shapes;
  return rest as Omit<OverlaySnapshot, "shapes">;
}

function omitVolatileFields<T extends Record<string, unknown>>(value: T): Partial<T> {
  const rest: Partial<T> = { ...value };
  for (const field of VOLATILE_DOCUMENT_FIELDS) {
    delete rest[field as keyof T];
  }
  return rest;
}

function withVolatileFieldsFrom<T extends Omit<SigmaDocument, "content" | "pageLayout">>(
  target: T,
  source: SigmaDocument,
): T {
  return { ...target, updatedAt: source.updatedAt };
}

/** overlayの `updatedAt` も「最後に書いた時刻」なので、採用結果はディスク正本の値へ揃える。 */
function mergeOverlayTimestamp(
  pageLayout: PageLayout | undefined,
  theirsPageLayout: PageLayout | undefined,
): PageLayout | undefined {
  if (!pageLayout?.overlay) {
    return pageLayout;
  }
  return {
    ...pageLayout,
    overlay: { ...pageLayout.overlay, updatedAt: theirsPageLayout?.overlay?.updatedAt },
  };
}

function extractMetaForComparison(document: SigmaDocument): unknown {
  const rest = omitVolatileFields(omitContentAndPageLayout(document) as Record<string, unknown>);
  const pageLayout = document.pageLayout;
  if (!pageLayout) {
    return rest;
  }
  const overlay = pageLayout.overlay;
  if (!overlay) {
    return { ...rest, pageLayout };
  }
  // overlay図形 (shapes) だけは別軸で3-wayマージするため、メタ比較からは除外する。
  // overlay自身の updatedAt も内容ではないので比較しない。
  return {
    ...rest,
    pageLayout: {
      ...pageLayout,
      overlay: {
        ...omitVolatileFields(overlay as unknown as Record<string, unknown>),
        ...(overlay.overlaySnapshot
          ? { overlaySnapshot: omitShapes(overlay.overlaySnapshot) }
          : {}),
      },
    },
  };
}

function applyMergedShapesToPageLayout(pageLayout: PageLayout | undefined, shapes: OverlayShape[]): PageLayout | undefined {
  if (!pageLayout) {
    return pageLayout;
  }
  const overlay = pageLayout.overlay;
  if (!overlay?.overlaySnapshot && shapes.length === 0) {
    // overlayを持たない教材に空のsnapshotを生やさない。生やすと「マージ結果がディスク正本と
    // 違う」と判定され、内容が同じでも毎回保存し直すことになる。
    return pageLayout;
  }
  const overlaySnapshot = normalizeOverlaySnapshot(overlay?.overlaySnapshot);
  return {
    ...pageLayout,
    overlay: {
      ...overlay,
      overlaySnapshot: {
        ...overlaySnapshot,
        shapes,
      },
    },
  };
}

// ----- ID を持つ単位 (本文トップレベルブロック / overlay図形) の共通3-wayマージ -----

interface UnitMergeMessages {
  /** 並びを3-wayマージできなかった。 */
  structure: () => string;
  /** 到達しないはずの構成 (安全側に倒す)。 */
  unsafe: () => string;
  /** 同じ単位を両側が変更した。 */
  conflict: (ids: string) => string;
  /** 片側が削除し、もう片側が編集した。 */
  deleted: (ids: string) => string;
}

function blockMergeMessages(t: Translate<"editor">): UnitMergeMessages {
  return {
    structure: () => t("merge.structure"),
    unsafe: () => t("merge.blocksUnsafe"),
    conflict: (ids) => t("merge.blockConflict", { ids }),
    deleted: (ids) => t("merge.blockDeleted", { ids }),
  };
}

function shapeMergeMessages(t: Translate<"editor">): UnitMergeMessages {
  return {
    structure: () => t("merge.shapeStructure"),
    unsafe: () => t("merge.shapesUnsafe"),
    conflict: (ids) => t("merge.shapeConflict", { ids }),
    deleted: (ids) => t("merge.shapeDeleted", { ids }),
  };
}

type UnitsMergeResult<T> =
  | { ok: true; units: T[] }
  | { ok: false; reason: string };

/**
 * ID を持つ単位の並びと中身を3-wayマージする。
 *
 * 1. 削除の決定 (片側だけが消したものは消す。編集と衝突したら resolution に従う)
 * 2. 並びの決定 (片側だけが構成を変えたならその並び、両側なら挿入位置をアンカーでマージ)
 * 3. 中身の決定 (片側だけが変えたならその中身、両側が変えたら resolution に従う)
 */
function mergeIdentifiedUnits<T extends { id: string }>(
  base: T[],
  mine: T[],
  theirs: T[],
  resolution: MergeConflictResolution,
  resolvedConflicts: string[],
  messages: UnitMergeMessages,
): UnitsMergeResult<T> {
  const preferTheirs = resolution === "prefer-theirs";
  const baseById = indexById(base);
  const mineById = indexById(mine);
  const theirsById = indexById(theirs);
  const baseIds = base.map((unit) => unit.id);
  const mineIds = mine.map((unit) => unit.id);
  const theirsIds = theirs.map((unit) => unit.id);

  // 1. 削除の決定。
  const removedIds = new Set<string>();
  for (const id of baseIds) {
    const baseUnit = baseById.get(id)!;
    const mineUnit = mineById.get(id);
    const theirsUnit = theirsById.get(id);
    if (mineUnit && theirsUnit) {
      continue;
    }
    if (!mineUnit && !theirsUnit) {
      removedIds.add(id);
      continue;
    }
    // 片側だけが削除した。もう片側がその単位を編集していたら「編集 vs 削除」の競合。
    const survivor = mineUnit ?? theirsUnit!;
    if (!areStructurallyEqual(survivor, baseUnit)) {
      if (!preferTheirs) {
        return { ok: false, reason: messages.deleted(id) };
      }
      resolvedConflicts.push(messages.deleted(id));
      // theirs の判断を採る: theirs が消していれば消し、theirs が編集していれば残す。
      if (!theirsUnit) {
        removedIds.add(id);
      }
      continue;
    }
    removedIds.add(id);
  }

  // 2. 並びの決定。
  const order = mergeIdOrder(baseIds, mineIds, theirsIds, removedIds);
  let orderedIds: string[];
  if (order.ok) {
    orderedIds = order.ids;
  } else {
    if (!preferTheirs) {
      return { ok: false, reason: messages.structure() };
    }
    resolvedConflicts.push(messages.structure());
    orderedIds = theirsIds;
  }

  // 3. 中身の決定。
  const merged: T[] = [];
  for (const id of orderedIds) {
    const baseUnit = baseById.get(id);
    const mineUnit = mineById.get(id);
    const theirsUnit = theirsById.get(id);
    if (!baseUnit) {
      // baseに存在しない = どちらかが新規追加した単位。
      const insertedUnit = theirsUnit ?? mineUnit;
      if (!insertedUnit) {
        // 理論上到達しないはずだが、念のため安全側に倒す。
        return { ok: false, reason: messages.unsafe() };
      }
      merged.push(insertedUnit);
      continue;
    }
    if (!mineUnit || !theirsUnit) {
      // 片側が削除したのに残す判断になった単位 (編集 vs 削除を解決した結果)。
      const survivor = theirsUnit ?? mineUnit;
      if (!survivor) {
        return { ok: false, reason: messages.unsafe() };
      }
      merged.push(survivor);
      continue;
    }

    const mineChanged = !areStructurallyEqual(mineUnit, baseUnit);
    const theirsChanged = !areStructurallyEqual(theirsUnit, baseUnit);
    if (mineChanged && theirsChanged) {
      if (areStructurallyEqual(mineUnit, theirsUnit)) {
        merged.push(mineUnit);
        continue;
      }
      if (!preferTheirs) {
        return { ok: false, reason: messages.conflict(id) };
      }
      resolvedConflicts.push(messages.conflict(id));
      merged.push(theirsUnit);
      continue;
    }
    merged.push(mineChanged ? mineUnit : theirsChanged ? theirsUnit : baseUnit);
  }

  return { ok: true, units: merged };
}

type IdOrderMergeResult =
  | { ok: true; ids: string[] }
  | { ok: false };

const ORDER_HEAD = Symbol("head");

type InsertionAnchor = string | typeof ORDER_HEAD;

/**
 * 残す単位の並びを3-wayマージする。base に残る単位の相対順は「並べ替えた側」の順を採り、
 * 新規追加はそれぞれの側の直前の生存単位をアンカーにして差し込む。
 */
function mergeIdOrder(
  baseIds: string[],
  mineIds: string[],
  theirsIds: string[],
  removedIds: Set<string>,
): IdOrderMergeResult {
  const baseIdSet = new Set(baseIds);
  const survivors = baseIds.filter((id) => !removedIds.has(id));
  const keepsSurvivor = (id: string) => baseIdSet.has(id) && !removedIds.has(id);
  const mineSurvivorOrder = mineIds.filter(keepsSurvivor);
  const theirsSurvivorOrder = theirsIds.filter(keepsSurvivor);

  // 「並べ替えた」と言えるのは、残す単位を全部持っている側だけ。片側が消した単位を残す判断に
  // なった場合 (編集 vs 削除の解決)、その側の並びには欠けがあるので基準にはできない。
  const mineReordered = mineSurvivorOrder.length === survivors.length
    && !idArraysEqual(mineSurvivorOrder, survivors);
  const theirsReordered = theirsSurvivorOrder.length === survivors.length
    && !idArraysEqual(theirsSurvivorOrder, survivors);
  if (mineReordered && theirsReordered && !idArraysEqual(mineSurvivorOrder, theirsSurvivorOrder)) {
    return { ok: false };
  }
  const spine = theirsReordered ? theirsSurvivorOrder : mineReordered ? mineSurvivorOrder : survivors;
  const spineSet = new Set(spine);

  const collectInsertions = (ids: string[]): Map<InsertionAnchor, string[]> => {
    const byAnchor = new Map<InsertionAnchor, string[]>();
    let anchor: InsertionAnchor = ORDER_HEAD;
    for (const id of ids) {
      if (spineSet.has(id)) {
        anchor = id;
        continue;
      }
      if (baseIdSet.has(id)) {
        // 削除が決まった既存単位。アンカーは動かさない。
        continue;
      }
      const inserted = byAnchor.get(anchor);
      if (inserted) {
        inserted.push(id);
      } else {
        byAnchor.set(anchor, [id]);
      }
    }
    return byAnchor;
  };

  const theirsInsertions = collectInsertions(theirsIds);
  const mineInsertions = collectInsertions(mineIds);
  const theirsInsertedIds = new Set([...theirsInsertions.values()].flat());
  for (const id of [...mineInsertions.values()].flat()) {
    if (theirsInsertedIds.has(id)) {
      // 同じIDを両側が新規追加している。どちらの中身を採るか決められない。
      return { ok: false };
    }
  }

  const ids: string[] = [];
  const emitInsertions = (anchor: InsertionAnchor) => {
    // AIの追加を先に、人間の追加を後に並べる (どちらも同じアンカーへ挿した場合の決定的な順序)。
    ids.push(...(theirsInsertions.get(anchor) ?? []));
    ids.push(...(mineInsertions.get(anchor) ?? []));
  };

  emitInsertions(ORDER_HEAD);
  for (const id of spine) {
    ids.push(id);
    emitInsertions(id);
  }
  return { ok: true, ids };
}

function indexById<T extends { id: string }>(units: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const unit of units) {
    map.set(unit.id, unit);
  }
  return map;
}

function idArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((id, index) => id === b[index]);
}

// ----- overlay図形 (表・グラフ・通常図形) -----

function mergeOverlayShapes(
  base: SigmaDocument,
  mine: SigmaDocument,
  theirs: SigmaDocument,
  t: Translate<"editor">,
  resolution: MergeConflictResolution,
  resolvedConflicts: string[],
): UnitsMergeResult<OverlayShape> {
  const baseShapes = normalizeOverlaySnapshot(base.pageLayout?.overlay?.overlaySnapshot).shapes;
  const mineShapes = normalizeOverlaySnapshot(mine.pageLayout?.overlay?.overlaySnapshot).shapes;
  const theirsShapes = normalizeOverlaySnapshot(theirs.pageLayout?.overlay?.overlaySnapshot).shapes;

  // shapes の配列順は重なり(描画)順に影響しうるため、本文ブロックと同じく順序込みで扱う。
  return mergeIdentifiedUnits(
    baseShapes,
    mineShapes,
    theirsShapes,
    resolution,
    resolvedConflicts,
    shapeMergeMessages(t),
  );
}
