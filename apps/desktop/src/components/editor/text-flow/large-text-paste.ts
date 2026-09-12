import type { Mark, ResolvedPos } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";

import {
  getTextFlowBlockIds,
  type TextFlowBlock,
} from "@/features/text-editing";
import { countPerformanceEvent, measurePerformance } from "@/lib/performance";
import {
  getEditorClipboardPlainText,
  type EditorClipboardPayload,
} from "@/lib/editor-clipboard";
import { tiptapNodesToInlineNodes } from "@/lib/tiptap-adapter";

import { parsePastedMarkdown } from "./markdown-paste";
import {
  buildTextRunReplacementMutations,
  type TextRunReplacementMutation,
} from "./text-run-replacement";
import { emptyTextFlowParagraph, plainTextToTextFlowParagraphs, sliceToTextFlowBlocks } from "./text-run-slice";

export const LARGE_TEXT_PASTE_LINE_THRESHOLD = 200;
export const LARGE_TEXT_PASTE_INITIAL_BLOCK_COUNT = 40;

export interface LargeTextPastePlan extends TextRunReplacementMutation {
  deferredBlockIds: string[];
}

export interface LargePasteHydrationState {
  deferredBlockIds: ReadonlySet<string>;
  hydratedUnitIds: ReadonlySet<string>;
}

/**
 * 連続する大量 paste では、先の paste でまだ placeholder の block も次の hydration へ渡す。
 * 既に hydrate 済みの unit は再び deferred に戻さず、新しい paste 分だけを追加する。
 */
export function mergeLargePasteDeferredBlockIds(
  current: LargePasteHydrationState | null,
  units: readonly { id: string; blockIds: readonly string[] }[],
  nextDeferredBlockIds: readonly string[],
): Set<string> {
  const hydratedBlockIds = new Set(
    units.flatMap((unit) => current?.hydratedUnitIds.has(unit.id) ? unit.blockIds : []),
  );
  return new Set([
    ...[...(current?.deferredBlockIds ?? [])]
      .filter((blockId) => !hydratedBlockIds.has(blockId)),
    ...nextDeferredBlockIds,
  ]);
}

/**
 * SigmaDoc mutation paths bypass PM's filterTransaction, so reject a plan that
 * would alter an existing guarded block before any selection/history state moves.
 */
export function findLargeTextPasteBlockedBlockId(
  plan: LargeTextPastePlan,
  previousBlocks: readonly TextFlowBlock[],
  guardedBlockIds: ReadonlySet<string>,
): string | null {
  if (guardedBlockIds.size === 0) {
    return null;
  }

  for (const blockId of guardedBlockIds) {
    const previous = findPersistedNodeById(previousBlocks, blockId);
    if (!previous) {
      continue;
    }
    const next = findPersistedNodeById(plan.nextBlocks, blockId);
    if (!next || !structurallyEqual(previous, next)) {
      return blockId;
    }
  }
  return null;
}

function findPersistedNodeById(value: unknown, id: string): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPersistedNodeById(item, id);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (record.id === id) {
    return record;
  }
  for (const child of Object.values(record)) {
    const found = findPersistedNodeById(child, id);
    if (found) {
      return found;
    }
  }
  return null;
}

function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a)
      && Array.isArray(b)
      && a.length === b.length
      && a.every((item, index) => structurallyEqual(item, b[index]));
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key)
      && structurallyEqual(left[key], right[key]));
}

export type LargeTextPasteCommit = (
  previousIds: string[],
  nextBlocks: TextFlowBlock[],
  activeBlockId: string | undefined,
  context: {
    historyGroup: string;
    selection: LargeTextPastePlan["selection"];
    crossEditor: true;
    deferredPasteBlockIds: string[];
  },
) => void;

/** PM の plain-text parser と同じ改行規則で数える。連続改行は境界 1 個へ畳む。 */
export function countPlainTextPasteBlocks(text: string): number {
  return text.length === 0 ? 0 : text.split(/(?:\r\n?|\n)+/).length;
}

export function shouldUseLargeTextPaste(
  text: string,
  threshold = LARGE_TEXT_PASTE_LINE_THRESHOLD,
): boolean {
  return countPlainTextPasteBlocks(text) >= threshold;
}

/** A module-local clipboard fallback is valid only while it still describes the OS paste event. */
export function localClipboardPayloadMatchesPlainText(
  payload: EditorClipboardPayload | null,
  plainText: string,
): boolean {
  return payload !== null && getEditorClipboardPlainText(payload) === plainText;
}

/**
 * 大量ペーストを DOM/PM ノードへせず、canonical な本文ブロック列へ変換する。
 * Markdown と判定できる入力も既存 parser の結果をそのまま使う。
 */
export function largeTextPasteBlocks(
  text: string,
  contextMarks: readonly Mark[] = [],
): TextFlowBlock[] {
  return measurePerformance("TextFlowEditor.largePaste.parse", () => {
    const markdownBlocks = parsePastedMarkdown(text);
    if (markdownBlocks) {
      return markdownBlocks;
    }

    return applyContextMarks(plainTextToTextFlowParagraphs(text), contextMarks);
  });
}

/** literal paste never interprets Markdown, but otherwise matches PM's plain-text parser. */
export function largeLiteralTextPasteBlocks(
  text: string,
  contextMarks: readonly Mark[] = [],
): TextFlowBlock[] {
  return measurePerformance("TextFlowEditor.largePaste.parseLiteral", () => (
    applyContextMarks(plainTextToTextFlowParagraphs(text), contextMarks)
  ));
}

function applyContextMarks(
  blocks: TextFlowBlock[],
  contextMarks: readonly Mark[],
): TextFlowBlock[] {
  if (contextMarks.length === 0) {
    return blocks;
  }

  // ProseMirror's plain-text clipboard parser creates every line with
  // `$context.marks()`. Convert that mark set through the same PM -> SigmaDoc
  // adapter as ordinary editor updates, without constructing the large PM slice.
  const [formattedText] = tiptapNodesToInlineNodes([{
    type: "text",
    text: "x",
    marks: contextMarks.map((mark) => mark.toJSON()),
  }]);
  if (formattedText?.type !== "text") {
    return blocks;
  }

  return blocks.map((block) => block.type === "paragraph"
    ? {
        ...block,
        children: block.children.map((child) => child.type === "text"
          ? { ...formattedText, text: child.text }
          : child),
      }
    : block);
}

/**
 * The slice-based plan below only preserves document-level block structure.
 * Paragraphs nested in lists, quotes, boxes, or any future container must stay on PM's native path.
 */
export function isLargeTextPasteSelectionAtTopLevel(state: EditorState): boolean {
  const { $from, $to } = state.selection;
  return isTopLevelTextBlockPosition($from) && isTopLevelTextBlockPosition($to);
}

/**
 * 現在の PM 選択の前後だけを SigmaDoc へ戻し、大量ブロック列を 1 回の置換へ組み立てる。
 * 先頭/末尾段落の結合と選択置換は跨ぎ選択と同じ純粋ロジックを共有する。
 */
export function buildLargeTextPastePlan({
  state,
  previousBlocks,
  pastedBlocks,
  scopeId,
  unitId,
}: {
  state: EditorState;
  previousBlocks: TextFlowBlock[];
  pastedBlocks: TextFlowBlock[];
  scopeId: string;
  unitId: string;
}): LargeTextPastePlan | null {
  return measurePerformance("TextFlowEditor.largePaste.plan", () => {
    if (!isLargeTextPasteSelectionAtTopLevel(state)) {
      return null;
    }

    const { from, to } = state.selection;
    const mutation = buildTextRunReplacementMutations([{
      unitId,
      previousIds: getTextFlowBlockIds(previousBlocks),
      previousBlocks,
      before: sliceToTextFlowBlocks(state.doc.slice(0, from), previousBlocks),
      after: sliceToTextFlowBlocks(state.doc.slice(to, state.doc.content.size), previousBlocks),
      startsInsideTextBlock: isInsideTextBlock(state.doc.resolve(from)),
      endsInsideTextBlock: isInsideTextBlock(state.doc.resolve(to)),
      preserveEmpty: false,
      scopeId,
      acceptsLayoutSection: true,
    }], pastedBlocks, emptyTextFlowParagraph, { hasBlocksOutsideSpan: true })[0];
    if (!mutation) {
      return null;
    }

    const previousBlockIds = new Set(mutation.previousIds);

    countPerformanceEvent("TextFlowEditor.largePaste.planned");
    return {
      ...mutation,
      deferredBlockIds: mutation.nextBlocks
        .slice(LARGE_TEXT_PASTE_INITIAL_BLOCK_COUNT)
        // 画面に出ていた既存本文とキャレットの unit は必ず即時 mount する。
        // PageCanvasEditor は unit 内の全 block が deferred のときだけ placeholder にする。
        .filter((block) => !previousBlockIds.has(block.id) && block.id !== mutation.focusBlockId)
        .map((block) => block.id),
    };
  });
}

/** A large paste crosses the SigmaDoc mutation boundary exactly once. */
export function commitLargeTextPastePlan(
  plan: LargeTextPastePlan,
  historyGroup: string,
  commit: LargeTextPasteCommit,
  restoreCaret?: (selection: NonNullable<LargeTextPastePlan["selection"]>) => void,
): void {
  commit(plan.previousIds, plan.nextBlocks, plan.focusBlockId, {
    historyGroup,
    selection: plan.selection,
    crossEditor: true,
    deferredPasteBlockIds: plan.deferredBlockIds,
  });
  if (plan.selection) {
    restoreCaret?.(plan.selection);
  }
}

function isInsideTextBlock(position: ResolvedPos): boolean {
  return position.parent.isTextblock;
}

function isTopLevelTextBlockPosition(position: ResolvedPos): boolean {
  return position.depth === 1 && position.parent.isTextblock;
}
