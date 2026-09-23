import { collectIds } from "./shared-document";
import { contentHash, isObject, type ObjectValue, type Value } from "./value";

export interface ReadPrecondition {
  id: string;
  hash: string;
}
export interface TargetChange {
  id: string;
  value: ObjectValue | null;
}
export interface SharedApproval {
  operationId: string;
  preconditions: ReadPrecondition[];
  changes?: TargetChange[];
  draft?: unknown;
  drafts?: unknown[];
}
export const PAGE_LAYOUT_TARGET = "$pageLayout";
export function pageLayoutPrecondition(document: ObjectValue): Value {
  const layout = document.pageLayout;
  return isObject(layout)
    ? Object.fromEntries(
        Object.entries(layout).filter(([key]) => key !== "overlay"),
      )
    : null;
}

export async function assertReadPreconditions(
  current: ObjectValue,
  conditions: ReadPrecondition[],
): Promise<Set<string>> {
  if (!Array.isArray(conditions) || conditions.length > 10_000)
    throw new Error("INVALID_APPROVAL");
  const entities = collectIds(current);
  const checked = new Set<string>();
  for (const condition of conditions) {
    const value =
      condition.id === PAGE_LAYOUT_TARGET
        ? pageLayoutPrecondition(current)
        : entities.get(condition.id);
    if (value === undefined || (await contentHash(value)) !== condition.hash)
      throw new Error("PROPOSAL_CONFLICT");
    checked.add(condition.id);
  }
  return checked;
}

/** Read dependencies include reference material, not just the eventual write targets. */
export async function applyApproval(
  current: ObjectValue,
  approval: SharedApproval,
): Promise<ObjectValue> {
  if (!approval.changes?.length || approval.changes.length > 1000)
    throw new Error("INVALID_APPROVAL");
  const checked = await assertReadPreconditions(
    current,
    approval.preconditions,
  );
  const changes = new Map<string, ObjectValue | null>();
  for (const change of approval.changes) {
    if (
      !checked.has(change.id) ||
      changes.has(change.id) ||
      (change.value && change.value.id !== change.id)
    )
      throw new Error("INVALID_APPROVAL");
    changes.set(change.id, change.value);
  }
  const visit = (value: Value): Value | undefined => {
    if (Array.isArray(value))
      return value.flatMap((child) => {
        const next = visit(child);
        return next === undefined ? [] : [next];
      });
    if (!isObject(value)) return value;
    if (typeof value.id === "string" && changes.has(value.id))
      return changes.get(value.id) ?? undefined;
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, child]) => {
        const next = visit(child);
        return next === undefined ? [] : [[key, next]];
      }),
    );
  };
  return visit(current) as ObjectValue;
}
