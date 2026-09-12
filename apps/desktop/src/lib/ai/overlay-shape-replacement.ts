import type {
  OverlayShape,
  SigmaDocument,
} from "@/features/document";
import type { AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";

export interface AiOverlayShapeReplacementPair {
  removedShapeId: string;
  addedShapeId: string;
}

export interface AiOverlayShapeReplacementProposalLike {
  draft: AiEditSessionDraft;
  requestedShapeId?: string;
  source?: {
    toolArgs?: unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveAiOverlayShapeReplacementRequestedId(
  proposal: Pick<AiOverlayShapeReplacementProposalLike, "requestedShapeId" | "source">,
): string | null {
  if (typeof proposal.requestedShapeId === "string" && proposal.requestedShapeId.trim()) {
    return proposal.requestedShapeId.trim();
  }
  const source = proposal.source;
  if (!isRecord(source?.toolArgs)) {
    return null;
  }
  const directId = source.toolArgs.id;
  if (typeof directId === "string" && directId.trim()) {
    return directId.trim();
  }
  const nestedShape = source.toolArgs.shape;
  if (isRecord(nestedShape) && typeof nestedShape.id === "string" && nestedShape.id.trim()) {
    return nestedShape.id.trim();
  }
  return null;
}

function insertedShapeId(draft: AiEditSessionDraft): string | null {
  for (const operation of draft.operations) {
    if (operation.operation === "insertOverlayShape") {
      return operation.overlayShape.id;
    }
    if (operation.operation === "insertTableShape") {
      return operation.tableShape.id;
    }
  }
  return null;
}

/**
 * Detects the explicit replacement sequence emitted by the local MCP tools:
 * an earlier deleteOverlayShapes removes id X, then an insert tool in the same
 * approval batch requests id X. Insert tools allocate a temporary unique id
 * while X still exists in the uncommitted base document, so the persisted
 * inserted shape id alone cannot express this relationship.
 */
export function deriveAiOverlayShapeReplacementPairs(
  proposals: AiOverlayShapeReplacementProposalLike[],
): AiOverlayShapeReplacementPair[] {
  const deletedAt = new Map<string, number>();
  proposals.forEach((proposal, proposalIndex) => {
    for (const operation of proposal.draft.mutationOperations ?? []) {
      if (operation.operation !== "deleteOverlayShapes") {
        continue;
      }
      operation.shapeIds.forEach((shapeId) => {
        if (!deletedAt.has(shapeId)) {
          deletedAt.set(shapeId, proposalIndex);
        }
      });
    }
  });

  const usedRemovedIds = new Set<string>();
  const usedAddedIds = new Set<string>();
  const pairs: AiOverlayShapeReplacementPair[] = [];
  proposals.forEach((proposal, proposalIndex) => {
    const removedShapeId = resolveAiOverlayShapeReplacementRequestedId(proposal);
    const addedShapeId = insertedShapeId(proposal.draft);
    if (!removedShapeId || !addedShapeId) {
      return;
    }
    const deleteIndex = deletedAt.get(removedShapeId);
    if (
      deleteIndex === undefined ||
      deleteIndex >= proposalIndex ||
      usedRemovedIds.has(removedShapeId) ||
      usedAddedIds.has(addedShapeId)
    ) {
      return;
    }
    usedRemovedIds.add(removedShapeId);
    usedAddedIds.add(addedShapeId);
    pairs.push({ removedShapeId, addedShapeId });
  });
  return pairs;
}

/** Keeps a logical replacement at the original shape's location and identity. */
export function preserveOverlayShapePlacementForReplacement(
  existingShape: OverlayShape,
  replacementShape: OverlayShape,
): OverlayShape {
  const nextShape = {
    ...replacementShape,
    id: existingShape.id,
    x: existingShape.x,
    y: existingShape.y,
    rotation: existingShape.rotation ?? 0,
  } as OverlayShape;

  const preservedOptionalKeys = [
    "anchor",
    "flipX",
    "flipY",
    "parentId",
    "groupId",
    "stackLayer",
    "locked",
    "hidden",
    "opacity",
  ] as const;
  const nextRecord = nextShape as unknown as Record<string, unknown>;
  const existingRecord = existingShape as unknown as Record<string, unknown>;
  for (const key of preservedOptionalKeys) {
    if (key in existingRecord) {
      nextRecord[key] = existingRecord[key];
    } else {
      delete nextRecord[key];
    }
  }
  return nextShape;
}

export function rewriteAiOverlayShapeReplacementDrafts<
  T extends AiOverlayShapeReplacementProposalLike,
>(
  baseDocument: SigmaDocument,
  proposals: T[],
): { proposals: T[]; pairs: AiOverlayShapeReplacementPair[] } {
  const pairs = deriveAiOverlayShapeReplacementPairs(proposals);
  const currentShapes = baseDocument.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
  const currentShapesById = new Map(currentShapes.map((shape) => [shape.id, shape]));
  const replacementByAddedId = new Map(
    pairs.flatMap((pair) => {
      const existingShape = currentShapesById.get(pair.removedShapeId);
      return existingShape ? [[pair.addedShapeId, existingShape] as const] : [];
    }),
  );
  const applicablePairs = pairs.filter((pair) => replacementByAddedId.has(pair.addedShapeId));
  if (applicablePairs.length === 0) {
    return { proposals, pairs: [] };
  }

  return {
    proposals: proposals.map((proposal) => ({
      ...proposal,
      draft: {
        ...proposal.draft,
        operations: proposal.draft.operations.map((operation) => {
          if (operation.operation === "insertOverlayShape") {
            const existingShape = replacementByAddedId.get(operation.overlayShape.id);
            return existingShape
              ? { ...operation, overlayShape: preserveOverlayShapePlacementForReplacement(existingShape, operation.overlayShape) }
              : operation;
          }
          if (operation.operation === "insertTableShape") {
            const existingShape = replacementByAddedId.get(operation.tableShape.id);
            if (!existingShape) {
              return operation;
            }
            const replacement = preserveOverlayShapePlacementForReplacement(existingShape, operation.tableShape);
            return replacement.type === "tableShape"
              ? { ...operation, tableShape: replacement }
              : operation;
          }
          return operation;
        }),
      },
    })),
    pairs: applicablePairs,
  };
}
