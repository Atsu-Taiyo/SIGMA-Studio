import type { TextFlowSelectionBookmark } from "@/features/text-editing";
import type { SigmaDocument } from "@/features/document";
import { findBlock } from "@/lib/document-tree";

/**
 * 教材タブごとの一時的な編集ビュー状態。
 *
 * SigmaDoc には載せない。タブ切替で document を差し替えると選択・スクロールが
 * 先頭へ戻るため、セッション中だけ fileId 単位で覚えて戻す。
 */
export interface EditorTabViewState {
  selectedId: string | null;
  textSelection: TextFlowSelectionBookmark | null;
  scrollTop: number;
  scrollLeft: number;
}

export interface ResolvedEditorTabViewState {
  /** `undefined` のとき呼び出し側は文書の既定選択へフォールバックする。 */
  selectedId: string | null | undefined;
  textSelection: TextFlowSelectionBookmark | null;
  scrollTop: number;
  scrollLeft: number;
}

export function captureEditorTabViewState(params: {
  selectedId: string | null;
  textSelection: TextFlowSelectionBookmark | null;
  scroller: Pick<HTMLElement, "scrollTop" | "scrollLeft"> | null;
}): EditorTabViewState {
  return {
    selectedId: params.selectedId,
    textSelection: params.textSelection,
    scrollTop: params.scroller?.scrollTop ?? 0,
    scrollLeft: params.scroller?.scrollLeft ?? 0,
  };
}

export function resolveEditorTabViewState(
  document: SigmaDocument,
  saved: EditorTabViewState | null | undefined,
): ResolvedEditorTabViewState {
  if (!saved) {
    return {
      selectedId: undefined,
      textSelection: null,
      scrollTop: 0,
      scrollLeft: 0,
    };
  }

  const textSelection = isUsableTextSelection(document, saved.textSelection)
    ? saved.textSelection
    : null;
  const selectedId = saved.selectedId && findBlock(document, saved.selectedId)
    ? saved.selectedId
    : textSelection?.head.blockId;

  return {
    selectedId,
    textSelection,
    scrollTop: Number.isFinite(saved.scrollTop) ? Math.max(0, saved.scrollTop) : 0,
    scrollLeft: Number.isFinite(saved.scrollLeft) ? Math.max(0, saved.scrollLeft) : 0,
  };
}

function isUsableTextSelection(
  document: SigmaDocument,
  selection: TextFlowSelectionBookmark | null,
): selection is TextFlowSelectionBookmark {
  if (!selection) {
    return false;
  }
  return Boolean(
    findBlock(document, selection.anchor.blockId)
    && findBlock(document, selection.head.blockId),
  );
}

/**
 * 以前は同じ復元を 3 回撃っていた。ブロードキャストは全ての面が拾うので、遅れて現れた面が
 * 後からキャレットを攫うのを「もう一度撃つ」で押し返していたため。宛先を 1 つに決めるルーター
 * では、未マウントの宛先は登録された瞬間に予約が消化されるので 1 回で足りる。
 */
const EDITOR_TAB_VIEW_SELECTION_RETRY_DELAYS_MS = [0] as const;

/**
 * タブ切替後のキャンバス再マウントに合わせてスクロールと本文キャレットを戻す。
 *
 * 本文エディタは仮想化＋再マウントのため、最初の数フレームではまだ listener が無い。
 * スクロールを先に戻して対象ページを出してから、短い間隔でキャレット復元を数回だけ試す。
 * キャレット復元の focus がスクロールを動かすことがあるので、都度位置を当て直す。
 */
export function scheduleEditorTabViewRestore(params: {
  getScroller: () => HTMLElement | null;
  scrollTop: number;
  scrollLeft: number;
  textSelection: TextFlowSelectionBookmark | null;
  restoreTextSelection: (selection: TextFlowSelectionBookmark) => void;
  maxScrollerAttempts?: number;
}): void {
  const maxScrollerAttempts = params.maxScrollerAttempts ?? 8;

  const apply = (): boolean => {
    const scroller = params.getScroller();
    if (!scroller) {
      return false;
    }

    applyScrollerOffset(scroller, params.scrollTop, params.scrollLeft);
    if (params.textSelection) {
      params.restoreTextSelection(params.textSelection);
      applyScrollerOffset(scroller, params.scrollTop, params.scrollLeft);
      // キャレットの配送は面がマウントされるまで待つことがあり、その `view.focus()` が
      // スクローラーを動かす。撃ち直しを 1 回に減らした代わりに、次のフレームでもう一度
      // 保存位置を当て直す (リトライで押し返す代わりの、決定的な当て直し)。
      window.requestAnimationFrame(() => {
        const current = params.getScroller();
        if (current) {
          applyScrollerOffset(current, params.scrollTop, params.scrollLeft);
        }
      });
    }
    return true;
  };

  const attemptApply = (scrollerAttempt: number) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (apply()) {
          return;
        }
        if (scrollerAttempt < maxScrollerAttempts) {
          window.setTimeout(() => attemptApply(scrollerAttempt + 1), 30);
        }
      });
    });
  };

  if (!params.textSelection) {
    attemptApply(0);
    return;
  }

  for (const delayMs of EDITOR_TAB_VIEW_SELECTION_RETRY_DELAYS_MS) {
    if (delayMs === 0) {
      attemptApply(0);
      continue;
    }
    window.setTimeout(() => attemptApply(0), delayMs);
  }
}

function applyScrollerOffset(scroller: HTMLElement, scrollTop: number, scrollLeft: number): void {
  scroller.scrollTop = scrollTop;
  scroller.scrollLeft = scrollLeft;
}
