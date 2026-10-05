import {
  isOverlayShape,
  mergeEntity3,
  normalizeOverlaySnapshot,
  type OverlayShape,
  type OverlaySnapshot,
  type PageLayout,
  type SigmaDocument,
  type ThreeWayMergeReport,
} from "@/features/document";
import { resolveRepeatedNodeIds } from "@/lib/document-node-identity-merge";
import { createTranslator, DEFAULT_LOCALE, type Translate } from "@/lib/i18n";
import { SigmaBlockSchema, SigmaDocumentSchema } from "@/lib/sigma-doc-schema";
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
//
// `resolution: "merge-both"` (AI承認の採用だけが使う) では、両方が変えた単位 (トップレベル
// ブロック・overlay図形・教材全体の情報) を諦めずに三者マージカーネル `mergeEntity3` で合成する。
// 単位の中まで文字単位・キー単位で合成するので、同じ段落の別の位置への入力も両方残る。並べ替えも
// カーネルと同じ規則で合成する。合成した単位が検証を通らなければ、その単位だけ theirs を採る
// (`report.invalidAfterMerge`)。合成で同じノードidが2か所に入ったら (片方が単位の外へ移し、
// もう片方が元の場所で直した)、移した側の位置に1つだけ残してもう一方の編集をそこへ合成する
// (`document-node-identity-merge.ts`)。それもできなければ文書全体を theirs にする。

/** 内容ではなく「最後に書いた時刻」を記録するだけのフィールド。競合判定から外す。 */
const VOLATILE_DOCUMENT_FIELDS = ["updatedAt"] as const;

/** `report.mergedUnits` で、教材全体の情報 (題名・ページ設定・コメントなど) を表す単位。 */
export const DOCUMENT_SETTINGS_UNIT = "$";

/** `report.droppedHumanEdits` で、文書全体を theirs にしたことを表すパス。 */
export const WHOLE_DOCUMENT_PATH = "$";

export type MergeConflictResolution = "fail" | "prefer-theirs" | "merge-both";

export interface MergeExternalDocumentChangeOptions {
  /**
   * 解決できない競合をどう扱うか。
   *
   * - `"fail"` (既定): 誤マージを避けて諦める。呼び出し側は全文リロードなどへフォールバックする。
   * - `"prefer-theirs"`: 競合した単位だけ theirs (承認済みAI正本/ディスク正本) を採り、
   *   競合していない mine の編集はそのまま残す。自動承認された外部書き込みの取り込みで使う。
   * - `"merge-both"`: 両方が変えた単位を三者マージで合成し、両方の編集を残す。同じ位置への挿入は
   *   mine (人間) → theirs (AI) の順。両方が同じ値を違う値に変えたところは theirs。合成結果が
   *   検証を通らない単位だけ theirs を採る。結果の中で同じノードidは入力より多く現れない。
   *   ユーザーが「適用」を押したAI承認の採用で使う。
   *
   * どれでも、競合を理由に教材ファイルを増やさず同じ1ファイルを編集し続ける。採用の直前に現在の
   * 文書をundoスタックへ積むのは呼び出し側の責務。
   */
  resolution?: MergeConflictResolution;
  t?: Translate<"editor">;
}

/**
 * `"merge-both"` のマージが決めたこと (MISS R3: 退避は数えられるようにする)。両方が同じ単位を
 * 変えていなければ、すべて空・0。パスは単位ごとに `#<id>.<カーネルのパス>`、教材全体の情報と
 * 並び順は文書のパス (`$.metadata.title`, `$.content`)。
 */
export interface DocumentMergeReport {
  /** 両方が変えて、三者マージで合成した単位 (`DOCUMENT_SETTINGS_UNIT` は教材全体の情報)。 */
  mergedUnits: string[];
  /** 両方が同じところを変えた: 同じ位置への挿入 (両方残す) か、違う値・並び (theirs を採る)。 */
  overlaps: string[];
  /** 大きすぎて粗い単位で合成した文字列があるか。 */
  capped: boolean;
  cappedPaths: string[];
  /** 合成で振り直した数式id。 */
  reidentified: number;
  /** 片方が消し、もう片方が編集したので編集を残した単位・値。 */
  editBeatsDelete: string[];
  /** 合成で2か所に入ったため、1か所に戻したノードid。 */
  duplicateIds: string[];
  /** 合成結果が検証を通らず theirs を採った単位の数 (文書全体を theirs にしたときは 1)。 */
  invalidAfterMerge: number;
  /**
   * 人間の入力がAIの内容で置き換わったところ (両方が違う値にした値・並び、検証を通らずAI側を採った
   * 単位、人間が消したのにAIの編集で残した単位、`WHOLE_DOCUMENT_PATH` は文書全体)。
   */
  droppedHumanEdits: string[];
  /** 承認したAIの編集が反映されなかったところ (人間が単位の種類を変えた、人間の編集が削除に勝った)。 */
  droppedAiEdits: string[];
}

export type MergeExternalDocumentChangeResult =
  | {
      ok: true;
      merged: SigmaDocument;
      resolvedConflicts?: string[];
      /** `"merge-both"` のときだけ付く。 */
      report?: DocumentMergeReport;
    }
  | { ok: false; reason: string };

export function createEmptyDocumentMergeReport(): DocumentMergeReport {
  return {
    mergedUnits: [],
    overlaps: [],
    capped: false,
    cappedPaths: [],
    reidentified: 0,
    editBeatsDelete: [],
    duplicateIds: [],
    invalidAfterMerge: 0,
    droppedHumanEdits: [],
    droppedAiEdits: [],
  };
}

/** 1回のマージで各段が共有する状態。`report` は `"merge-both"` のときだけある。 */
interface MergeState {
  resolution: MergeConflictResolution;
  resolvedConflicts: string[];
  report: DocumentMergeReport | null;
}

/**
 * base (rendererが最後にディスクと同期した時点の文書) を基準に、mine (人間の未保存編集を
 * 含む現在のエディタ状態) と theirs (ディスク上の新しい文書、例: AI提案の承認で保存された
 * もの) を3-wayマージする。既定は保守的で、同じ対象を両方が変更していたら ok:false を返す。
 * `resolution: "prefer-theirs"` を渡した場合は、その競合単位だけ theirs を採用して続行する。
 * `resolution: "merge-both"` を渡した場合は、その単位を三者マージで合成する (失敗しない)。
 */
export function mergeExternalDocumentChange(
  base: SigmaDocument,
  mine: SigmaDocument,
  theirs: SigmaDocument,
  options: MergeExternalDocumentChangeOptions = {},
): MergeExternalDocumentChangeResult {
  const t = options.t ?? createTranslator(DEFAULT_LOCALE, "editor");
  const state: MergeState = {
    resolution: options.resolution ?? "fail",
    resolvedConflicts: [],
    report: options.resolution === "merge-both" ? createEmptyDocumentMergeReport() : null,
  };
  const withReport = state.report ? { report: state.report } : {};

  if (areStructurallyEqual(mine, base)) {
    // 人間の未保存編集が無い (mineはbaseから何も変わっていない) 単純なケース。
    return { ok: true, merged: theirs, ...withReport };
  }
  if (areStructurallyEqual(mine, theirs)) {
    // 人間の編集がたまたま theirs と完全に一致している (defensive: 実際にはほぼ起きない)。
    return { ok: true, merged: theirs, ...withReport };
  }

  const metaResult = mergeDocumentMeta(base, mine, theirs, t, state);
  if (!metaResult.ok) {
    return metaResult;
  }

  const contentResult = mergeIdentifiedUnits(
    base.content,
    mine.content,
    theirs.content,
    state,
    blockUnitAxis(t),
  );
  if (!contentResult.ok) {
    return state.report ? adoptTheirsWhole(theirs, contentResult.reason) : contentResult;
  }

  const shapesResult = mergeOverlayShapes(base, mine, theirs, t, state);
  if (!shapesResult.ok) {
    return state.report ? adoptTheirsWhole(theirs, shapesResult.reason) : shapesResult;
  }

  const mergedPageLayout = applyMergedShapesToPageLayout(metaResult.pageLayout, shapesResult.units);

  return {
    ok: true,
    merged: {
      ...metaResult.rest,
      content: contentResult.units,
      ...(mergedPageLayout !== undefined ? { pageLayout: mergedPageLayout } : {}),
    },
    ...(state.resolvedConflicts.length > 0 ? { resolvedConflicts: state.resolvedConflicts } : {}),
    ...withReport,
  };
}

/**
 * `"merge-both"` でも単位の合成からidの重複を解けなかった。教材を増やさず、承認された文書
 * そのもの (theirs) を採る。人間の入力は呼び出し側が積むundoエントリから戻せる。
 */
function adoptTheirsWhole(theirs: SigmaDocument, reason: string): MergeExternalDocumentChangeResult {
  return {
    ok: true,
    merged: theirs,
    resolvedConflicts: [reason],
    report: {
      ...createEmptyDocumentMergeReport(),
      invalidAfterMerge: 1,
      droppedHumanEdits: [WHOLE_DOCUMENT_PATH],
    },
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
  state: MergeState,
): DocumentMetaMergeResult {
  const baseMeta = extractMetaForComparison(base);
  const mineMeta = extractMetaForComparison(mine);
  const theirsMeta = extractMetaForComparison(theirs);

  const mineChanged = !areStructurallyEqual(mineMeta, baseMeta);
  const theirsChanged = !areStructurallyEqual(theirsMeta, baseMeta);
  const conflicted = mineChanged && theirsChanged && !areStructurallyEqual(mineMeta, theirsMeta);

  if (conflicted) {
    if (state.report) {
      const merged = mergeDocumentSettings({ base: baseMeta, mine: mineMeta, theirs: theirsMeta }, theirs, state.report);
      if (merged.droppedEdits.length > 0) {
        state.resolvedConflicts.push(t("merge.metadata"));
      }
      if (merged.settings) {
        return { ok: true, ...merged.settings };
      }
    } else if (state.resolution !== "prefer-theirs") {
      return { ok: false, reason: t("merge.metadata") };
    } else {
      state.resolvedConflicts.push(t("merge.metadata"));
    }
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

/**
 * 教材全体の情報 (content と overlay図形を除いた部分) を、両方が変えたので三者マージする。
 * 検証を通らなければ `settings` は null (呼び出し側は theirs を採る)。記録用の時刻は theirs に揃える。
 * どちらの側の変更が落ちたかを `report` に足し、`droppedEdits` でも返す。
 */
function mergeDocumentSettings(
  meta: { base: Record<string, unknown>; mine: Record<string, unknown>; theirs: Record<string, unknown> },
  theirs: SigmaDocument,
  report: DocumentMergeReport,
): {
  settings: { rest: Omit<SigmaDocument, "content" | "pageLayout">; pageLayout: PageLayout | undefined } | null;
  droppedEdits: DroppedEdit[];
} {
  const merge = mergeEntity3(structuredClone(meta.base), structuredClone(meta.mine), structuredClone(meta.theirs));
  const { pageLayout: mergedPageLayout, ...mergedRest } = merge.value;
  const rest = withVolatileFieldsFrom(mergedRest as Omit<SigmaDocument, "content" | "pageLayout">, theirs);
  const pageLayout = mergeOverlayTimestamp(
    restoreShapesSlot(mergedPageLayout as PageLayout | undefined),
    theirs.pageLayout,
  );
  const valid = merge.report.duplicateIds.length === 0
    && SigmaDocumentSchema.safeParse({
      ...rest,
      content: [],
      ...(pageLayout !== undefined ? { pageLayout } : {}),
    }).success;
  if (!valid) {
    // 人間が変えた項目 (トップレベルのキー) はすべてAI側の値になる。
    report.invalidAfterMerge += 1;
    const droppedEdits = Object.keys({ ...meta.base, ...meta.mine })
      .filter((key) => !areStructurallyEqual(meta.mine[key], meta.base[key]))
      .map((key): DroppedEdit => ({ side: "human", record: `$.${key}` }));
    recordDroppedEdits(report, droppedEdits);
    return { settings: null, droppedEdits };
  }
  addKernelReport(report, merge.report, DOCUMENT_SETTINGS_UNIT);
  appendUnique(report.mergedUnits, [DOCUMENT_SETTINGS_UNIT]);
  const droppedEdits = classifyDroppedEdits(
    merge.report,
    { mine: meta.mine, theirs: meta.theirs, merged: merge.value },
    unitRecordPrefix(DOCUMENT_SETTINGS_UNIT),
  );
  recordDroppedEdits(report, droppedEdits);
  return { settings: { rest, pageLayout }, droppedEdits };
}

/**
 * 比較用に外した overlay の `shapes` を空で戻す。図形は別軸でマージした結果を
 * `applyMergedShapesToPageLayout` が入れる (`shapes` が無い snapshot は空扱いになり assets を失う)。
 */
function restoreShapesSlot(pageLayout: PageLayout | undefined): PageLayout | undefined {
  const overlaySnapshot = pageLayout?.overlay?.overlaySnapshot;
  if (!pageLayout || !overlaySnapshot) {
    return pageLayout;
  }
  return {
    ...pageLayout,
    overlay: { ...pageLayout.overlay, overlaySnapshot: { ...overlaySnapshot, shapes: [] } },
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

function extractMetaForComparison(document: SigmaDocument): Record<string, unknown> {
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

/** 本文ブロック・overlay図形それぞれの、マージの文言・検証・並びのパス。 */
interface UnitAxis {
  messages: UnitMergeMessages;
  /** 合成した単位がこの軸の単位として成り立つか (`"merge-both"` だけが使う)。 */
  isValid: (value: unknown) => boolean;
  /** 並び順の重なりを報告するときのパス。 */
  path: string;
}

function blockUnitAxis(t: Translate<"editor">): UnitAxis {
  return {
    messages: {
      structure: () => t("merge.structure"),
      unsafe: () => t("merge.blocksUnsafe"),
      conflict: (ids) => t("merge.blockConflict", { ids }),
      deleted: (ids) => t("merge.blockDeleted", { ids }),
    },
    isValid: (value) => SigmaBlockSchema.safeParse(value).success,
    path: "$.content",
  };
}

function shapeUnitAxis(t: Translate<"editor">): UnitAxis {
  return {
    messages: {
      structure: () => t("merge.shapeStructure"),
      unsafe: () => t("merge.shapesUnsafe"),
      conflict: (ids) => t("merge.shapeConflict", { ids }),
      deleted: (ids) => t("merge.shapeDeleted", { ids }),
    },
    isValid: isOverlayShape,
    path: "$.pageLayout.overlay.overlaySnapshot.shapes",
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
  state: MergeState,
  axis: UnitAxis,
): UnitsMergeResult<T> {
  if (state.report) {
    return mergeIdentifiedUnitsKeepingBoth(base, mine, theirs, state, state.report, axis);
  }
  const { messages } = axis;
  const preferTheirs = state.resolution === "prefer-theirs";
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
      state.resolvedConflicts.push(messages.deleted(id));
      // theirs の判断を採る: theirs が消していれば消し、theirs が編集していれば残す。
      if (!theirsUnit) {
        removedIds.add(id);
      }
      continue;
    }
    removedIds.add(id);
  }

  // 2. 並びの決定。
  const order = mergeIdOrder(baseIds, mineIds, theirsIds, removedIds, false);
  let orderedIds: string[];
  if (order.ok) {
    orderedIds = order.ids;
  } else {
    if (!preferTheirs) {
      return { ok: false, reason: messages.structure() };
    }
    state.resolvedConflicts.push(messages.structure());
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
      state.resolvedConflicts.push(messages.conflict(id));
      merged.push(theirsUnit);
      continue;
    }
    merged.push(mineChanged ? mineUnit : theirsChanged ? theirsUnit : baseUnit);
  }

  return { ok: true, units: merged };
}

/** どちらの側の変更が結果に入らなかったか (`human` は人間の入力、`ai` は承認したAIの編集)。 */
interface DroppedEdit {
  side: "human" | "ai";
  record: string;
}

/**
 * `"merge-both"` の単位マージ。
 *
 * 1. 削除の決定: 片側が消し、もう片側が編集した単位は残す (カーネルと同じく編集が削除に勝つ)。
 *    片方が別の単位へ移していただけのこともあるので、どちらの削除が落ちたかの記録は 4 の後。
 * 2. 並びの決定: カーネルと同じく、残す単位を片側が持っていなくても並べ替えを読み取って合成する。
 *    両方が違う並べ替えをしたらAIの並び (人間の並べ替えは落ちたと記録する)。
 * 3. 中身の決定: 両方が変えた単位は `mergeEntity3` で合成する。検証を通らなければAIの単位。
 * 4. 合成で2か所に入ったノードidを1つへ戻す (`resolveRepeatedNodeIds`)。戻せなければ失敗を返し、
 *    呼び出し側が文書全体を theirs にする。
 */
function mergeIdentifiedUnitsKeepingBoth<T extends { id: string }>(
  base: T[],
  mine: T[],
  theirs: T[],
  state: MergeState,
  report: DocumentMergeReport,
  axis: UnitAxis,
): UnitsMergeResult<T> {
  const baseById = indexById(base);
  const mineById = indexById(mine);
  const theirsById = indexById(theirs);
  const baseIds = base.map((unit) => unit.id);
  const droppedEdits: DroppedEdit[] = [];

  // 1. 削除の決定。値は「編集を残した側」。
  const removedIds = new Set<string>();
  const keptEdits = new Map<string, "mine" | "theirs">();
  for (const id of baseIds) {
    const mineUnit = mineById.get(id);
    const theirsUnit = theirsById.get(id);
    if (mineUnit && theirsUnit) {
      continue;
    }
    const survivor = mineUnit ?? theirsUnit;
    if (!survivor || areStructurallyEqual(survivor, baseById.get(id))) {
      removedIds.add(id);
      continue;
    }
    keptEdits.set(id, mineUnit ? "mine" : "theirs");
  }

  // 2. 並びの決定。
  const order = mergeIdOrder(baseIds, mine.map((unit) => unit.id), theirs.map((unit) => unit.id), removedIds, true);
  if (!order.ok) {
    return { ok: false, reason: axis.messages.structure() };
  }
  if (order.reorderConflict) {
    appendUnique(report.overlaps, [axis.path]);
    addDroppedEdit(droppedEdits, { side: "human", record: axis.path });
  }

  // 3. 中身の決定。
  const merged: T[] = [];
  for (const id of order.ids) {
    const baseUnit = baseById.get(id);
    const mineUnit = mineById.get(id);
    const theirsUnit = theirsById.get(id);
    const bothChanged = mineUnit !== undefined
      && theirsUnit !== undefined
      && !areStructurallyEqual(mineUnit, theirsUnit)
      && (baseUnit === undefined
        || (!areStructurallyEqual(mineUnit, baseUnit) && !areStructurallyEqual(theirsUnit, baseUnit)));
    if (bothChanged) {
      merged.push(synthesizeUnit(id, baseUnit, mineUnit, theirsUnit, axis, report, droppedEdits));
      continue;
    }
    const unit = mineUnit && theirsUnit
      ? (baseUnit && !areStructurallyEqual(mineUnit, baseUnit) ? mineUnit : theirsUnit)
      : theirsUnit ?? mineUnit;
    if (!unit) {
      return { ok: false, reason: axis.messages.unsafe() };
    }
    merged.push(unit);
  }

  // 4. 合成で2か所に入ったノードid。
  const reconciled = resolveRepeatedNodeIds(merged, { base, mine, theirs }, axis.isValid);
  if (!reconciled) {
    return { ok: false, reason: axis.messages.unsafe() };
  }
  for (const resolution of reconciled.resolutions) {
    // 「削除」「編集が削除に勝った」として記録したものは、移動だったので記録し直す。
    forgetNodeRecords(report, droppedEdits, resolution.id);
    keptEdits.delete(resolution.id);
    appendUnique(report.duplicateIds, [resolution.id]);
    const record = `#${resolution.id}`;
    if (resolution.merged) {
      appendUnique(report.mergedUnits, [resolution.id]);
      addKernelReport(report, resolution.merged.kernel, resolution.id);
      const { kernel, mine: mineValue, theirs: theirsValue, value } = resolution.merged;
      for (const dropped of classifyDroppedEdits(
        kernel,
        { mine: mineValue, theirs: theirsValue, merged: value },
        unitRecordPrefix(resolution.id),
      )) {
        addDroppedEdit(droppedEdits, dropped);
      }
    } else if (resolution.droppedContent) {
      addDroppedEdit(droppedEdits, { side: resolution.droppedContent, record });
    }
    if (resolution.mineMoved && resolution.theirsMoved) {
      appendUnique(report.overlaps, [record]);
    }
    if (resolution.mineMoved && resolution.keptAt !== "mine") {
      addDroppedEdit(droppedEdits, { side: "human", record });
    }
    if (resolution.theirsMoved && resolution.keptAt !== "theirs") {
      addDroppedEdit(droppedEdits, { side: "ai", record });
    }
  }

  // 1 で残した編集のうち、移動ではなかったもの: 消した側の削除が落ちた。
  for (const [id, keptSide] of keptEdits) {
    appendUnique(report.editBeatsDelete, [`#${id}`]);
    addDroppedEdit(droppedEdits, { side: keptSide === "theirs" ? "human" : "ai", record: `#${id}` });
  }

  recordDroppedEdits(report, droppedEdits);
  state.resolvedConflicts.push(...droppedEditMessages(droppedEdits, keptEdits, axis));
  return { ok: true, units: reconciled.units };
}

/**
 * 両方が変えた単位を三者マージする。検証を通れば合成結果、通らなければ theirs
 * (`report.invalidAfterMerge`、人間のその単位への編集は落ちる)。同じidが単位の内外で2か所に
 * 入るのは、ここでは咎めず 4 で1つへ戻す。
 */
function synthesizeUnit<T extends { id: string }>(
  id: string,
  baseUnit: T | undefined,
  mineUnit: T,
  theirsUnit: T,
  axis: UnitAxis,
  report: DocumentMergeReport,
  droppedEdits: DroppedEdit[],
): T {
  // カーネルは入力どうしがオブジェクトを共有しない前提 (数式の出どころを同一性で見る)。画面の
  // 文書と承認開始時の文書は変わっていない部分を共有しているので、ここで切り離す。
  const merge = mergeEntity3(
    structuredClone(baseUnit) as T,
    structuredClone(mineUnit),
    structuredClone(theirsUnit),
  );
  const value = merge.value as T & { type?: unknown };
  if (!isPlainRecord(value) || value.id !== id || !axis.isValid(value)) {
    report.invalidAfterMerge += 1;
    addDroppedEdit(droppedEdits, { side: "human", record: `#${id}` });
    return theirsUnit;
  }
  addKernelReport(report, merge.report, id);
  for (const dropped of classifyDroppedEdits(
    merge.report,
    { mine: mineUnit, theirs: theirsUnit, merged: value },
    unitRecordPrefix(id),
  )) {
    addDroppedEdit(droppedEdits, dropped);
  }
  if (value.type === (mineUnit as T & { type?: unknown }).type) {
    // AIが単位の種類を変えたときは、カーネルがAIの単位をそのまま採っている (合成ではない)。
    appendUnique(report.mergedUnits, [id]);
  }
  return value;
}

/**
 * カーネルが「両方が変えた」と報告したところで、どちらの側の変更が結果に入らなかったかを分ける。
 *
 * - 値・並び・ノードの種類: 結果がAIの値と同じなら人間の入力が、人間の値と同じならAIの編集が
 *   落ちた。どちらとも違えば両方が残っている (同じ位置への両方の挿入など)。
 * - 編集が削除に勝ったところ: 消した側の削除が落ちた。
 *
 * 既知の制約: 文字列の中の書式だけが食い違ったところは、その文字列全体が両方と違うので、
 * 落ちた側として数えない (カーネルの報告は文字列単位)。
 */
function classifyDroppedEdits(
  kernel: ThreeWayMergeReport,
  sides: { mine: unknown; theirs: unknown; merged: unknown },
  prefix: (path: string) => string,
): DroppedEdit[] {
  const dropped: DroppedEdit[] = [];
  for (const path of kernel.overlaps) {
    const mineValue = comparableAtPath(sides.mine, path);
    const theirsValue = comparableAtPath(sides.theirs, path);
    if (areStructurallyEqual(mineValue, theirsValue)) {
      continue;
    }
    const mergedValue = comparableAtPath(sides.merged, path);
    if (areStructurallyEqual(mergedValue, theirsValue)) {
      dropped.push({ side: "human", record: prefix(path) });
    } else if (areStructurallyEqual(mergedValue, mineValue)) {
      dropped.push({ side: "ai", record: prefix(path) });
    }
  }
  for (const path of kernel.editBeatsDelete) {
    if (valueAtKernelPath(sides.mine, path) === undefined) {
      dropped.push({ side: "human", record: prefix(path) });
    } else if (valueAtKernelPath(sides.theirs, path) === undefined) {
      dropped.push({ side: "ai", record: prefix(path) });
    }
  }
  return dropped;
}

/** id を持つ要素の配列 (並べ替えの重なり) は id の並びで比べる。 */
function comparableAtPath(root: unknown, path: string): unknown {
  const value = valueAtKernelPath(root, path);
  const identified = Array.isArray(value)
    && value.length > 0
    && value.every((element) => isPlainRecord(element) && typeof element.id === "string" && element.type !== "mathInline");
  return identified ? value.map((element) => (element as { id: string }).id) : value;
}

const KERNEL_PATH_SEGMENT = /\.([^.[\]]+)|\[(\d+)\]|\[#([^\]]+)\]/g;

/** カーネルのパス (`$.props.color`, `$.blocks[#id].children`, `$.cells[2]`) の値。 */
function valueAtKernelPath(root: unknown, path: string): unknown {
  let current = root;
  for (const match of path.slice(1).matchAll(KERNEL_PATH_SEGMENT)) {
    if (match[1] !== undefined) {
      current = isPlainRecord(current) ? current[match[1]] : undefined;
    } else if (match[2] !== undefined) {
      current = Array.isArray(current) ? current[Number(match[2])] : undefined;
    } else {
      current = Array.isArray(current)
        ? current.find((element) => isPlainRecord(element) && element.id === match[3])
        : undefined;
    }
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

/** カーネルのパスを単位の記録のパスにする (教材全体の情報は文書のパスのまま)。 */
function unitRecordPrefix(unitId: string): (path: string) => string {
  return unitId === DOCUMENT_SETTINGS_UNIT
    ? (path) => path
    : (path) => `#${unitId}${path.slice(1)}`;
}

/** 移動として1つに戻したノードについて、単位の合成で付けた記録を消す。 */
function forgetNodeRecords(report: DocumentMergeReport, droppedEdits: DroppedEdit[], id: string): void {
  const refersTo = (record: string) => record === `#${id}`
    || record.startsWith(`#${id}.`)
    || record.startsWith(`#${id}[`)
    || record.includes(`[#${id}]`);
  report.overlaps = report.overlaps.filter((record) => !refersTo(record));
  report.editBeatsDelete = report.editBeatsDelete.filter((record) => !refersTo(record));
  const kept = droppedEdits.filter((dropped) => !refersTo(dropped.record));
  droppedEdits.splice(0, droppedEdits.length, ...kept);
}

function addDroppedEdit(droppedEdits: DroppedEdit[], dropped: DroppedEdit): void {
  if (!droppedEdits.some((known) => known.side === dropped.side && known.record === dropped.record)) {
    droppedEdits.push(dropped);
  }
}

function recordDroppedEdits(report: DocumentMergeReport, droppedEdits: readonly DroppedEdit[]): void {
  for (const dropped of droppedEdits) {
    appendUnique(dropped.side === "human" ? report.droppedHumanEdits : report.droppedAiEdits, [dropped.record]);
  }
}

/** どちらかの変更が落ちた単位ごとに1つ、従来の競合の説明を作る。 */
function droppedEditMessages(
  droppedEdits: readonly DroppedEdit[],
  keptEdits: ReadonlyMap<string, "mine" | "theirs">,
  axis: UnitAxis,
): string[] {
  const seen = new Set<string>();
  const messages: string[] = [];
  for (const { record } of droppedEdits) {
    const unitId = record === axis.path ? record : record.slice(1).split(/[.[]/)[0]!;
    if (seen.has(unitId)) {
      continue;
    }
    seen.add(unitId);
    messages.push(record === axis.path
      ? axis.messages.structure()
      : keptEdits.has(unitId) ? axis.messages.deleted(unitId) : axis.messages.conflict(unitId));
  }
  return messages;
}

/** カーネルの報告を、単位のidを前に付けて足す (教材全体の情報は文書のパスのまま)。 */
function addKernelReport(report: DocumentMergeReport, kernel: ThreeWayMergeReport, unitId: string): void {
  const prefix = unitRecordPrefix(unitId);
  appendUnique(report.overlaps, kernel.overlaps.map(prefix));
  report.capped ||= kernel.capped;
  appendUnique(report.cappedPaths, kernel.cappedPaths.map(prefix));
  report.reidentified += kernel.reidentified;
  appendUnique(report.editBeatsDelete, kernel.editBeatsDelete.map(prefix));
}

function appendUnique(target: string[], values: readonly string[]): void {
  for (const value of values) {
    if (!target.includes(value)) {
      target.push(value);
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type IdOrderMergeResult =
  | { ok: true; ids: string[]; reorderConflict: boolean }
  | { ok: false };

const ORDER_HEAD = Symbol("head");

type InsertionAnchor = string | typeof ORDER_HEAD;

/**
 * 残す単位の並びを3-wayマージする。base に残る単位の相対順は「並べ替えた側」の順を採り、
 * 新規追加はそれぞれの側の直前の生存単位をアンカーにして差し込む。
 *
 * `mergeBoth` (カーネルと同じ規則) では諦めない。
 * - 並べ替えは、残す単位の一部を持っていない側 (削除が編集に負けた側) からも読み取る。持って
 *   いない単位は、その側の並びで base の直前の単位の後ろに置く。
 * - 両方が違う並べ替えをしたら theirs の並び (`reorderConflict`)。
 * - 同じidを両方が追加したら1回だけ並べる。同じアンカーへの追加は mine (人間) → theirs (AI) の順。
 * それ以外では従来どおり (残す単位を全部持つ側だけが並べ替えたと見なし、追加は theirs → mine)。
 */
function mergeIdOrder(
  baseIds: string[],
  mineIds: string[],
  theirsIds: string[],
  removedIds: Set<string>,
  mergeBoth: boolean,
): IdOrderMergeResult {
  const baseIdSet = new Set(baseIds);
  const survivors = baseIds.filter((id) => !removedIds.has(id));
  const keepsSurvivor = (id: string) => baseIdSet.has(id) && !removedIds.has(id);
  const mineSurvivorOrder = mineIds.filter(keepsSurvivor);
  const theirsSurvivorOrder = theirsIds.filter(keepsSurvivor);

  let spine: string[];
  let reorderConflict = false;
  if (mergeBoth) {
    const mineReordered = isReordered(mineSurvivorOrder, survivors);
    const theirsReordered = isReordered(theirsSurvivorOrder, survivors);
    const mineOrder = completeOrder(mineSurvivorOrder, survivors);
    const theirsOrder = completeOrder(theirsSurvivorOrder, survivors);
    reorderConflict = mineReordered && theirsReordered && !idArraysEqual(mineOrder, theirsOrder);
    spine = theirsReordered ? theirsOrder : mineReordered ? mineOrder : survivors;
  } else {
    // 「並べ替えた」と言えるのは、残す単位を全部持っている側だけ。片側が消した単位を残す判断に
    // なった場合 (編集 vs 削除の解決)、その側の並びには欠けがあるので基準にはできない。
    const mineReordered = mineSurvivorOrder.length === survivors.length
      && !idArraysEqual(mineSurvivorOrder, survivors);
    const theirsReordered = theirsSurvivorOrder.length === survivors.length
      && !idArraysEqual(theirsSurvivorOrder, survivors);
    if (mineReordered && theirsReordered && !idArraysEqual(mineSurvivorOrder, theirsSurvivorOrder)) {
      return { ok: false };
    }
    spine = theirsReordered ? theirsSurvivorOrder : mineReordered ? mineSurvivorOrder : survivors;
  }
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
  if (!mergeBoth) {
    for (const id of [...mineInsertions.values()].flat()) {
      if (theirsInsertedIds.has(id)) {
        // 同じIDを両側が新規追加している。どちらの中身を採るか決められない。
        return { ok: false };
      }
    }
  }

  // 同じアンカーへ両側が挿した場合の決定的な順序。`"merge-both"` はカーネルと同じ人間→AI、
  // それ以外 (他者の書き込みの取り込み) は従来どおりAI→人間。
  const [firstInsertions, secondInsertions] = mergeBoth
    ? [mineInsertions, theirsInsertions]
    : [theirsInsertions, mineInsertions];
  const ids: string[] = [];
  const emitted = new Set<string>();
  const emitInsertions = (anchor: InsertionAnchor) => {
    for (const id of [...(firstInsertions.get(anchor) ?? []), ...(secondInsertions.get(anchor) ?? [])]) {
      if (!emitted.has(id)) {
        emitted.add(id);
        ids.push(id);
      }
    }
  };

  emitInsertions(ORDER_HEAD);
  for (const id of spine) {
    ids.push(id);
    emitInsertions(id);
  }
  return { ok: true, ids, reorderConflict };
}

/** その側が、持っている生存単位どうしの相対順を変えたか (持っていない単位は数えない)。 */
function isReordered(sideOrder: readonly string[], survivors: readonly string[]): boolean {
  const present = new Set(sideOrder);
  return !idArraysEqual([...sideOrder], survivors.filter((id) => present.has(id)));
}

/**
 * その側の生存単位の並びに、その側が持っていない生存単位 (削除が編集に負けて残すもの) を足す。
 * それぞれ、base で直前にある生存単位の後ろへ置く (カーネルの `completeOrder` と同じ)。
 */
function completeOrder(sideOrder: readonly string[], survivors: readonly string[]): string[] {
  const order = [...sideOrder];
  const present = new Set(sideOrder);
  survivors.forEach((id, index) => {
    if (present.has(id)) {
      return;
    }
    let position = 0;
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      const at = order.indexOf(survivors[previous]!);
      if (at >= 0) {
        position = at + 1;
        break;
      }
    }
    order.splice(position, 0, id);
    present.add(id);
  });
  return order;
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
  state: MergeState,
): UnitsMergeResult<OverlayShape> {
  const baseShapes = normalizeOverlaySnapshot(base.pageLayout?.overlay?.overlaySnapshot).shapes;
  const mineShapes = normalizeOverlaySnapshot(mine.pageLayout?.overlay?.overlaySnapshot).shapes;
  const theirsShapes = normalizeOverlaySnapshot(theirs.pageLayout?.overlay?.overlaySnapshot).shapes;

  // shapes の配列順は重なり(描画)順に影響しうるため、本文ブロックと同じく順序込みで扱う。
  return mergeIdentifiedUnits(baseShapes, mineShapes, theirsShapes, state, shapeUnitAxis(t));
}
