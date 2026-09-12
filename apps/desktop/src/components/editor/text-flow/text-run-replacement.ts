import {
  bodyTextFlowBlockContainsId,
  caretAddressAtBlockEnd,
  caretAddressAtBlockStart,
  collapsedCaretBookmark,
  getTextFlowBlockEditorLength,
  preserveManualBreaksAfterTextEdit,
  textCaretAddress,
  type CaretAddress,
  type TextFlowBlock,
  type TextFlowSelectionBookmark,
} from "@/features/text-editing";

import type { TextFlowChangeContext } from "./types";

export interface TextRunReplacementSegment {
  /** 段組セクションの中身を編集しているユニットは false。段の中に段組は入れられない。 */
  acceptsLayoutSection?: boolean;
  after: TextFlowBlock[];
  before: TextFlowBlock[];
  endsInsideTextBlock?: boolean;
  preserveEmpty: boolean;
  previousIds: string[];
  previousBlocks?: TextFlowBlock[];
  scopeId: string;
  startsInsideTextBlock?: boolean;
  unitId: string;
}

export interface TextRunReplacementOptions {
  /**
   * span の外側 (選択に含まれないユニット) に本文ブロックが残っているか。残らない
   * 全選択削除は nextBlocks が全ユニットで空になり、本文 0 ブロック = エディタが
   * 1 つもマウントされずキャレットの置き場が undo 以外で戻せない形で消えるため、
   * false のときは空段落を 1 つ残す。
   */
  hasBlocksOutsideSpan?: boolean;
  /**
   * Enter による置換: 単一エディタの deleteSelection + splitBlock と同じく、境界の
   * 段落断片を結合せず削除点を段落境界として残す。選択の終端がブロック途中でない
   * ときは空段落を差し込んでキャレットの置き場を作る。
   */
  splitAtBoundary?: boolean;
}

export interface TextRunReplacementMutation {
  focusBlockId?: string;
  /**
   * 境界結合で消えた挿入ブロック id → 結合先ブロック id。貼り付け元ブロックにぶら下がる
   * 図形のアンカーは、この読み替えを通して結合先へ付け直す。
   */
  joinedInsertionIds?: Record<string, string>;
  nextBlocks: TextFlowBlock[];
  previousIds: string[];
  selection?: TextFlowSelectionBookmark;
  unitId: string;
}

/**
 * 文書順の選択断片を、各 TextFlowEditor 固有の onChange に流せる変更列へ変換する。
 * 問題・段組みの構造内は空段落を残し、通常本文の完全選択はブロックごと削除する。
 */
export function buildTextRunReplacementMutations(
  segments: readonly TextRunReplacementSegment[],
  requestedInsertion: readonly TextFlowBlock[],
  createEmptyParagraph: () => TextFlowBlock,
  options?: TextRunReplacementOptions,
): TextRunReplacementMutation[] {
  if (segments.length === 0) {
    return [];
  }
  const splitAtBoundary = options?.splitAtBoundary === true && requestedInsertion.length === 0;
  // Enter の分割で、選択の終端がブロック境界ちょうどのときは削除点の直後に段落頭が
  // 来ないので、空段落を差し込んでキャレットの置き場を作る (splitBlock 相当)。
  const splitParagraphs = splitAtBoundary && segments[segments.length - 1].endsInsideTextBlock !== true
    ? [createEmptyParagraph()]
    : [];

  // 挿入は先頭グループの scope に入る。そこが段組の中なら、運ばれてきた段組は段に置けない
  // ので中身へ解く (コピー元が段組を丸ごと含んでいても、貼り付け先の段には段落として並ぶ)。
  const insertion = segments[0].acceptsLayoutSection === false
    ? requestedInsertion.flatMap((block) => (block.type === "layoutSection" ? block.children : [block]))
    : requestedInsertion;

  const groups: Array<{ segments: TextRunReplacementSegment[]; startsAt: number }> = [];
  segments.forEach((segment, index) => {
    const current = groups.at(-1);
    // 自動ページ分割だけで分かれた隣接チャンクは従来どおり 1 回の SigmaDoc 変更へ束ねる。
    // 一方、手動 break で始まるチャンクは独立した所有境界である。ここまで束ねると、先頭
    // writer の optimistic content に後続ユニットの owner が入り、同じ id の mounted editor
    // が二重になる。さらに retainDeletedOwners が別ユニットの owner を先頭側へ補うため、
    // 保存側の previousIds と DOM の対応も崩れる。
    if (
      current?.segments[0].scopeId === segment.scopeId
      && !startsWithManualBreakOwner(segment)
    ) {
      current.segments.push(segment);
    } else {
      groups.push({ segments: [segment], startsAt: index });
    }
  });

  const lastSegmentIndex = segments.length - 1;
  let insertionCaret: (CaretAddress & { unitId: string }) | undefined;
  let deletionAfterCaret: (CaretAddress & { unitId: string }) | undefined;
  let deletionBeforeCaret: (CaretAddress & { unitId: string }) | undefined;
  const mutations = groups.map(({ segments: scopeSegments, startsAt }): TextRunReplacementMutation => {
    const first = scopeSegments[0];
    const last = scopeSegments.at(-1)!;
    const endsAt = startsAt + scopeSegments.length - 1;
    const before = startsAt === 0 ? [...first.before] : [];
    const inserted = startsAt === 0 ? [...insertion, ...splitParagraphs] : [];
    const after = endsAt === lastSegmentIndex ? [...last.after] : [];
    const startsInsideTextBlock = startsAt === 0 && first.startsInsideTextBlock === true;
    const endsInsideTextBlock = endsAt === lastSegmentIndex && last.endsInsideTextBlock === true;
    let joinedDeletionBoundary = false;
    let joinedInsertionIds: Record<string, string> | undefined;

    // 入れ物の先頭には break-before の相手がいない。コピー元の先頭ブロックに付いていた
    // 区切りだけを黙って落とし、2 ブロック目以降の相対区切りはそのまま運ぶ。
    if (startsAt === 0 && before.length === 0 && inserted[0]?.pagination?.break === true) {
      inserted[0] = withoutManualBreak(inserted[0]);
    }

    if (inserted.length > 0) {
      if (startsAt === 0 && before.length === 0) {
        // 挿入が先頭ユニットの頭 (ブロック境界ちょうど) から始まる = 旧先頭ブロックは丸ごと
        // 消える。その id を先頭の挿入ブロックへ引き継ぐ。ユニット境界 (チャンクアンカー) は
        // 先頭ブロック id なので、これが変わると React key が変わってエディタごと作り直され、
        // キャレット復元前に届いた次の打鍵がフォーカスの無い一瞬に落ちる。単一エディタの
        // 全選択タイプが段落ノード (と id) を保つ挙動とも揃う。
        const reusableId = first.previousIds[0];
        const leading = inserted[0];
        if (reusableId && (leading.type === "paragraph" || leading.type === "heading")) {
          joinedInsertionIds = { [leading.id]: reusableId };
          inserted[0] = { ...leading, id: reusableId };
        }
      }
      if (!splitAtBoundary && startsInsideTextBlock && before.length > 0) {
        const joined = joinCompatibleTextBlocks(before.at(-1)!, inserted[0]);
        if (joined) {
          // 先頭の結合だけ id が保持側 (before 末尾) に倒れる。末尾の結合は挿入側の id が残る。
          joinedInsertionIds = { [inserted[0].id]: joined.id };
          before[before.length - 1] = joined;
          inserted.shift();
        }
      }

      const finalInsertedIndex = inserted.length - 1;
      const finalInserted = inserted[finalInsertedIndex] ?? before.at(-1);
      if (finalInserted) {
        insertionCaret = { ...caretAddressAtBlockEnd(finalInserted), unitId: first.unitId };
        if (!splitAtBoundary && endsInsideTextBlock && after.length > 0) {
          const joined = joinCompatibleTextBlocks(finalInserted, after[0]);
          if (joined) {
            if (finalInsertedIndex >= 0) {
              inserted[finalInsertedIndex] = joined;
            } else {
              before[before.length - 1] = joined;
            }
            after.shift();
          }
        }
      }
    } else if (!splitAtBoundary && startsInsideTextBlock && endsInsideTextBlock && before.length > 0 && after.length > 0) {
      const leading = before.at(-1)!;
      const joined = joinCompatibleTextBlocks(leading, after[0]);
      if (joined) {
        deletionBeforeCaret = {
          ...textCaretAddress(joined.id, getTextFlowBlockEditorLength(leading)),
          unitId: first.unitId,
        };
        before[before.length - 1] = joined;
        after.shift();
        joinedDeletionBoundary = true;
      }
    }

    const nextBlocks = preserveManualBreaksAfterTextEdit(
      scopeSegments.flatMap((segment) => segment.previousBlocks ?? []),
      [...before, ...inserted, ...after],
      { retainDeletedOwners: true },
    );
    if (insertion.length === 0) {
      const firstAfter = after[0];
      if (firstAfter && !joinedDeletionBoundary && !deletionAfterCaret) {
        deletionAfterCaret = { ...caretAddressAtBlockStart(firstAfter), unitId: first.unitId };
      }
      const finalBefore = before.at(-1);
      if (finalBefore) {
        deletionBeforeCaret = deletionBeforeCaret ?? {
          ...caretAddressAtBlockEnd(finalBefore),
          unitId: first.unitId,
        };
      }
    }
    return {
      unitId: first.unitId,
      previousIds: scopeSegments.flatMap((segment) => segment.previousIds),
      ...(joinedInsertionIds ? { joinedInsertionIds } : {}),
      nextBlocks: nextBlocks.length > 0 || !scopeSegments.some((segment) => segment.preserveEmpty)
        ? nextBlocks
        : [createEmptyParagraph()],
    };
  });

  // 全選択削除で span の外にも本文ブロックが残らないときは空段落を 1 つ残す。
  // 全ユニットの nextBlocks が空だと buildRenderUnits がユニット 0 件を返し、
  // キャレットを置くエディタが 1 つも無くなる。id は旧先頭ブロックから引き継ぐ
  // (チャンクアンカー保持。上の挿入経路と同じ理由でエディタの作り直しを避ける)。
  if (options?.hasBlocksOutsideSpan !== true && mutations.every((mutation) => mutation.nextBlocks.length === 0)) {
    const filler = createEmptyParagraph();
    const reusableId = segments[0].previousIds[0];
    mutations[0].nextBlocks = [reusableId ? { ...filler, id: reusableId } : filler];
  }

  // 削除のキャレットは選択の始端に合わせる: 段落の途中から始まった選択は保持した先行内容の
  // 末尾へ、ブロック境界ちょうどから始まった選択は後続内容の先頭へ置く (挿入経路と同じ向き)。
  // Enter の分割は例外で、単一エディタの splitBlock と同じく必ず後続側の先頭に置く。
  const deletionCaret = !splitAtBoundary && segments[0].startsInsideTextBlock === true
    ? deletionBeforeCaret ?? deletionAfterCaret
    : deletionAfterCaret ?? deletionBeforeCaret;
  const caret = insertionCaret ?? deletionCaret ?? firstAvailableCaret(mutations);
  if (!caret) {
    return mutations;
  }
  const focusMutation = mutations.find((mutation) => mutation.unitId === caret.unitId);
  if (!focusMutation) {
    return mutations;
  }
  const address: CaretAddress = {
    affinity: caret.affinity,
    blockId: caret.blockId,
    kind: caret.kind,
    offset: caret.offset,
  };
  focusMutation.focusBlockId = caret.blockId;
  focusMutation.selection = collapsedCaretBookmark(address);
  return mutations;
}

function startsWithManualBreakOwner(segment: TextRunReplacementSegment): boolean {
  return segment.previousBlocks?.[0]?.pagination?.break === true;
}

function withoutManualBreak<T extends TextFlowBlock>(block: T): T {
  const pagination = { ...(block.pagination ?? {}) };
  delete pagination.break;
  return {
    ...block,
    pagination: Object.keys(pagination).length > 0 ? pagination : undefined,
  };
}

/**
 * 変更後にキャレットの配送を予約すべきか。
 * 通常の打鍵は Tiptap 自身がキャレットを保つので、復元は「キャレットのブロックが新しく
 * 現れたとき」だけでよい。跨ぎ選択の置換はエディタの外で組み立てるため、結合先が既存の
 * ブロック id を保っていても必ず復元する (焦点エディタは id が同じだと外部同期も
 * キャレット移動もしないので、放置すると次の入力が置換前の選択を編集する)。
 */
export function shouldRestoreTextFlowSelectionAfterChange(
  previousIds: readonly string[],
  nextBlocks: readonly TextFlowBlock[],
  selection: TextFlowSelectionBookmark | null | undefined,
  context: TextFlowChangeContext | undefined,
): boolean {
  if (!selection) {
    return false;
  }
  if (!nextBlocks.some((block) => bodyTextFlowBlockContainsId(block, selection.head.blockId))) {
    return false;
  }
  return context?.crossEditor === true || !previousIds.includes(selection.head.blockId);
}

function firstAvailableCaret(
  mutations: readonly TextRunReplacementMutation[],
): (CaretAddress & { unitId: string }) | undefined {
  for (const mutation of mutations) {
    const block = mutation.nextBlocks[0];
    if (block) {
      return { ...caretAddressAtBlockStart(block), unitId: mutation.unitId };
    }
  }
  return undefined;
}

/**
 * 段落/見出しの断片同士の境界結合。id は先行側が残る。跨ぎ置換の境界結合と、IME 合成後の
 * 境界結合 (`finishTextRunSpanComposition`) が同じ規則を共有する。
 */
export function joinCompatibleTextBlocks(
  leading: TextFlowBlock,
  trailing: TextFlowBlock,
): TextFlowBlock | null {
  if (trailing.pagination?.break === true && leading.id !== trailing.id) {
    return null;
  }
  if (leading.type === "paragraph" || leading.type === "heading") {
    if (trailing.type !== "paragraph" && trailing.type !== "heading") {
      return null;
    }
    return {
      ...leading,
      children: [...leading.children, ...trailing.children],
    };
  }
  return null;
}
