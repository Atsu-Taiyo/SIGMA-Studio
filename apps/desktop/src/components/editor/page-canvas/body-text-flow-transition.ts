import {
  getLayoutSectionColumns,
  getLayoutSectionColumnWidths,
  isTextFlowBlock,
  setLayoutSectionColumns,
  replaceTopLevelTextFlowBlocks,
  type TextFlowBlock,
} from "@/features/text-editing";
import { PROBLEM_AREA_ORDER } from "@/features/document";
import type {
  ProblemAreaBlock,
  ProblemAreaKind,
  SigmaBlock,
} from "@/features/document";

import {
  replaceLayoutSectionChildren,
  replaceProblemAreaRichBlocks,
} from "./reconciliation";

export type BodyTextFlowEditRequest =
  | {
      scope: "problemArea";
      targetId: string;
      area: ProblemAreaKind;
      previousIds: string[];
      nextBlocks: TextFlowBlock[];
    }
  | {
      scope: "layoutSection" | "boxBlock";
      targetId: string;
      previousIds: string[];
      nextBlocks: TextFlowBlock[];
    };

export interface BodyTextFlowTransition {
  targetId: string;
  reduce: (
    target: SigmaBlock | ProblemAreaBlock,
  ) => SigmaBlock | ProblemAreaBlock;
}

/**
 * Resolves a TextFlow edit into a SigmaDoc target transition.
 *
 * The page controller owns focus and selection effects. This module only
 * captures the document snapshot needed for id reservation and returns the
 * equivalent pure target reducer.
 */
export function resolveBodyTextFlowTransition(
  content: readonly SigmaBlock[],
  request: BodyTextFlowEditRequest,
): BodyTextFlowTransition {
  if (request.scope === "problemArea") {
    const reservedIds = collectReservedProblemAreaIds(
      content,
      request.targetId,
      request.area,
      request.previousIds,
    );

    return {
      targetId: request.targetId,
      reduce: (target) => {
        if (target.type !== "problem") {
          return target;
        }

        return {
          ...target,
          [request.area]: replaceProblemAreaRichBlocks(
            target[request.area],
            request.previousIds,
            request.nextBlocks,
            reservedIds,
          ),
        };
      },
    };
  }

  if (request.scope === "boxBlock") {
    return {
      targetId: request.targetId,
      reduce: (target) => target.type === "boxBlock"
        ? { ...target, blocks: replaceTopLevelTextFlowBlocks(target.blocks, request.previousIds, request.nextBlocks) }
        : target,
    };
  }

  const reservedIds = collectReservedLayoutSectionIds(
    content,
    request.targetId,
    request.previousIds,
  );

  return {
    targetId: request.targetId,
    reduce: (target) => {
      if (target.type !== "layoutSection") {
        return target;
      }
      const columns = getLayoutSectionColumns(target);
      const columnIndex = columns.findIndex((column) => (
        request.previousIds.some((id) => column.some((child) => child.id === id))
      ));
      if (columnIndex < 0) return target;
      const nextColumn = replaceLayoutSectionChildren(
        columns[columnIndex],
        request.previousIds,
        request.nextBlocks,
        reservedIds,
      );
      const nextColumns = columns.map((column, index) => index === columnIndex ? nextColumn : column);
      return setLayoutSectionColumns(target, nextColumns, getLayoutSectionColumnWidths(target, columns.length));
    },
  };
}

export type FragmentTextFlowOwner =
  | { scope: "document" }
  | { scope: "boxBlock" | "layoutSection"; targetId: string }
  | { scope: "problemArea"; targetId: string; area: ProblemAreaKind };

/** Continuations can create/remove siblings, so writes go to their actual SigmaDoc container. */
export function findFragmentTextFlowOwner(
  content: readonly SigmaBlock[],
  blockId: string,
): FragmentTextFlowOwner | null {
  if (content.some((block) => block.id === blockId)) return { scope: "document" };
  for (const block of content) {
    if (block.type === "problem") {
      for (const area of PROBLEM_AREA_ORDER) {
        if (block[area].some((child) => child.id === blockId)) {
          return { scope: "problemArea", targetId: block.id, area };
        }
        const owner = findFragmentTextFlowOwner(block[area], blockId);
        if (owner) return owner;
      }
    } else if (block.type === "boxBlock" || block.type === "layoutSection") {
      const children = block.type === "boxBlock" ? block.blocks : block.children;
      if (children.some((child) => child.id === blockId)) {
        return { scope: block.type, targetId: block.id };
      }
      const owner = findFragmentTextFlowOwner(children, blockId);
      if (owner) return owner;
    }
  }
  return null;
}

function collectReservedProblemAreaIds(
  content: readonly SigmaBlock[],
  problemId: string,
  area: ProblemAreaKind,
  previousIds: readonly string[],
): Set<string> {
  const previousIdSet = new Set(previousIds);
  const ids = new Set<string>();

  for (const block of content) {
    ids.add(block.id);
    if (block.type === "layoutSection" || isTextFlowBlock(block)) {
      addTextFlowBlockIds(ids, block);
    }
    if (block.type !== "problem") {
      continue;
    }

    for (const currentArea of PROBLEM_AREA_ORDER) {
      for (const richBlock of block[currentArea]) {
        if (
          block.id === problemId &&
          currentArea === area &&
          previousIdSet.has(richBlock.id)
        ) {
          continue;
        }
        addTextFlowBlockIds(ids, richBlock);
      }
    }
  }

  return ids;
}

function collectReservedLayoutSectionIds(
  content: readonly SigmaBlock[],
  sectionId: string,
  previousIds: readonly string[],
): Set<string> {
  const previousIdSet = new Set(previousIds);
  const ids = new Set<string>();

  for (const block of content) {
    ids.add(block.id);

    if (block.type === "layoutSection") {
      addReservedIdsForLayoutSectionEdit(
        ids,
        block,
        sectionId,
        previousIdSet,
      );
      continue;
    }

    if (isTextFlowBlock(block)) {
      addTextFlowBlockIds(ids, block);
      continue;
    }

    if (block.type === "problem") {
      for (const area of PROBLEM_AREA_ORDER) {
        for (const richBlock of block[area]) {
          addReservedIdsForLayoutSectionEdit(
            ids,
            richBlock,
            sectionId,
            previousIdSet,
          );
        }
      }
    }
  }

  return ids;
}

function addReservedIdsForLayoutSectionEdit(
  ids: Set<string>,
  block: TextFlowBlock | ProblemAreaBlock,
  sectionId: string,
  previousIdSet: ReadonlySet<string>,
): void {
  ids.add(block.id);
  if (block.type === "layoutSection") {
    for (const child of block.children) {
      if (block.id === sectionId && previousIdSet.has(child.id)) {
        continue;
      }
      addReservedIdsForLayoutSectionEdit(
        ids,
        child,
        sectionId,
        previousIdSet,
      );
    }
    return;
  }
  if (block.type === "boxBlock") {
    block.blocks.forEach((child) => {
      addReservedIdsForLayoutSectionEdit(
        ids,
        child,
        sectionId,
        previousIdSet,
      );
    });
    return;
  }
  if (block.type !== "list") {
    return;
  }

  for (const item of block.items) {
    ids.add(item.id);
    item.nested?.forEach((nested) => {
      addReservedIdsForLayoutSectionEdit(
        ids,
        nested,
        sectionId,
        previousIdSet,
      );
    });
  }
}

function addTextFlowBlockIds(
  ids: Set<string>,
  block: TextFlowBlock | ProblemAreaBlock,
): void {
  ids.add(block.id);
  if (block.type === "boxBlock") {
    block.blocks.forEach((child) => addTextFlowBlockIds(ids, child));
    return;
  }
  if (block.type === "layoutSection") {
    block.children.forEach((child) => addTextFlowBlockIds(ids, child));
    return;
  }
  if (block.type !== "list") {
    return;
  }

  for (const item of block.items) {
    ids.add(item.id);
    item.nested?.forEach((nested) => addTextFlowBlockIds(ids, nested));
  }
}
