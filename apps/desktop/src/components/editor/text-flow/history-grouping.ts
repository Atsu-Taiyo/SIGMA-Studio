import type { Transaction } from "@tiptap/pm/state";
import type { Mapping, StepMap } from "@tiptap/pm/transform";

export const TEXT_FLOW_HISTORY_GROUP_DELAY_MS = 500;

export interface TextFlowHistoryGroupingState {
  readonly sequence: number;
  readonly previousRanges: readonly number[] | null;
  readonly previousTime: number;
  readonly previousComposition: unknown;
}

export interface TextFlowHistoryGroupingResult {
  readonly group: number;
  readonly state: TextFlowHistoryGroupingState;
}

export function createTextFlowHistoryGroupingState(): TextFlowHistoryGroupingState {
  return {
    sequence: 0,
    previousRanges: null,
    previousTime: 0,
    // Matches ProseMirror's sentinel so ordinary (non-composition)
    // transactions still apply the delay and adjacency boundaries.
    previousComposition: -1,
  };
}

/**
 * Mirrors ProseMirror's default history grouping: adjacent document changes
 * within 500 ms share one undo event, while a pause or a non-adjacent edit
 * starts another. The actual history remains SigmaDoc-owned.
 */
export function groupTextFlowTransaction(
  previous: TextFlowHistoryGroupingState,
  transaction: Transaction,
): TextFlowHistoryGroupingResult {
  const appendedTransaction = transaction.getMeta("appendedTransaction");
  const composition = transaction.getMeta("composition");
  const startsNewGroup = previous.previousTime === 0
    || (!appendedTransaction
      && previous.previousComposition !== composition
      && (
        previous.previousTime < transaction.time - TEXT_FLOW_HISTORY_GROUP_DELAY_MS
        || !isAdjacentToPreviousChange(transaction, previous.previousRanges)
      ));
  const sequence = startsNewGroup ? previous.sequence + 1 : previous.sequence;
  const previousRanges = appendedTransaction
    ? mapRanges(previous.previousRanges, transaction.mapping)
    : rangesFor(transaction.mapping.maps);

  return {
    group: sequence,
    state: {
      sequence,
      previousRanges,
      previousTime: transaction.time,
      previousComposition: composition == null ? previous.previousComposition : composition,
    },
  };
}

function isAdjacentToPreviousChange(
  transaction: Transaction,
  previousRanges: readonly number[] | null,
): boolean {
  if (!previousRanges) {
    return false;
  }
  if (!transaction.docChanged) {
    return true;
  }

  let adjacent = false;
  transaction.mapping.maps[0]?.forEach((start, end) => {
    for (let index = 0; index < previousRanges.length; index += 2) {
      if (start <= previousRanges[index + 1] && end >= previousRanges[index]) {
        adjacent = true;
      }
    }
  });
  return adjacent;
}

function rangesFor(maps: readonly StepMap[]): readonly number[] {
  const result: number[] = [];
  for (let index = maps.length - 1; index >= 0 && result.length === 0; index -= 1) {
    maps[index].forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      result.push(newStart, newEnd);
    });
  }
  return result;
}

function mapRanges(ranges: readonly number[] | null, mapping: Mapping): readonly number[] | null {
  if (!ranges) {
    return null;
  }

  const result: number[] = [];
  for (let index = 0; index < ranges.length; index += 2) {
    const from = mapping.map(ranges[index], 1);
    const to = mapping.map(ranges[index + 1], -1);
    if (from <= to) {
      result.push(from, to);
    }
  }
  return result;
}
