import { SharedDocument } from "@/features/collaboration/model/shared-document";
import { fromBase64, MAX_DOCUMENT_BYTES } from "@/features/collaboration/model/protocol";
import { isObject } from "@/features/collaboration/model/value";

const integer = (value: unknown, minimum = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
export const isRemoteId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
const role = (value: unknown) => typeof value === "string" && ["owner", "admin", "editor", "viewer"].includes(value);
const capabilityKeys = ["read", "editDocument", "createChildren", "rename", "move", "deleteDescendants", "invite", "manageEditorViewer", "appointAdmin", "stopRootShare", "deleteRootShare", "restoreDocument", "startHierarchyShare"];
const validCapabilities = (value: unknown) => isObject(value) && capabilityKeys.every(key => typeof value[key] === "boolean");

export function validateDocumentIdentity(value: unknown): void {
  if (!isObject(value) || !isRemoteId(value.id) || !integer(value.epoch, 1)) throw new Error("INVALID_DOCUMENT_RESPONSE");
}
export function validateSnapshot(value: unknown, documentId: string, requireRole = true): void {
  if (!isObject(value) || typeof value.state !== "string" || !integer(value.epoch, 1)
    || ((requireRole || value.role !== undefined) && !role(value.role))
    || (value.protocol !== undefined && value.protocol !== 1)) throw new Error("INVALID_SNAPSHOT_RESPONSE");
  try {
    const document = new SharedDocument(fromBase64(value.state, MAX_DOCUMENT_BYTES));
    try {
      const identity = document.identity();
      if (identity.sharedDocumentId !== documentId || identity.epoch !== value.epoch || identity.protocol !== 1)
        throw new Error("INVALID_SNAPSHOT_RESPONSE");
    } finally { document.destroy(); }
  } catch { throw new Error("INVALID_SNAPSHOT_RESPONSE"); }
}
export function validateSync(value: unknown, epoch: number): void {
  if (!isObject(value) || typeof value.update !== "string" || !role(value.role)
    || (value.epoch !== undefined && value.epoch !== epoch)
    || (value.protocol !== undefined && value.protocol !== 1)) throw new Error("INVALID_SYNC_RESPONSE");
}
/** Validate the whole response before removing any durable outbox entry. */
export function validateAcknowledgements(value: unknown, operationIds: string[]): void {
  if (!isObject(value) || !Array.isArray(value.acks) || value.acks.length !== operationIds.length)
    throw new Error("INVALID_ACK");
  for (let index = 0; index < operationIds.length; index++) {
    const ack = value.acks[index];
    if (!isObject(ack) || ack.operationId !== operationIds[index] || !integer(ack.seq, 1)) throw new Error("INVALID_ACK");
  }
}
export function validateApproval(value: unknown, operationId: string): void {
  if (!isObject(value) || typeof value.update !== "string" || value.operationId !== operationId || !integer(value.seq, 1)) throw new Error("INVALID_ACK");
}
export function validateCatalogDelta(value: unknown): void {
  if (!isObject(value) || !integer(value.revision) || !Array.isArray(value.nodes) || !Array.isArray(value.tombstones))
    throw new Error("INVALID_CATALOG_RESPONSE");
  for (const node of value.nodes) {
    if (!isObject(node) || !isRemoteId(node.id) || !isRemoteId(node.ownerId) || !isRemoteId(node.createdBy)
      || (node.parentId !== null && !isRemoteId(node.parentId))
      || (node.sharedDocumentId !== null && !isRemoteId(node.sharedDocumentId))
      || typeof node.kind !== "string" || !["workspace", "folder", "document"].includes(node.kind)
      || typeof node.state !== "string" || !["initializing", "active", "stopped", "deleted"].includes(node.state)
      || !role(node.role) || !integer(node.revision) || !integer(node.titleVersion)
      || typeof node.isShareRoot !== "boolean" || typeof node.name !== "string" || Array.from(node.name).length > 240
      || !validCapabilities(node.capabilities))
      throw new Error("INVALID_CATALOG_RESPONSE");
    if (node.kind === "document" && node.sharedDocumentId === null) throw new Error("INVALID_CATALOG_RESPONSE");
  }
  for (const item of value.tombstones)
    if (!isObject(item) || !isRemoteId(item.id) || item.deleted !== true || !integer(item.revision)) throw new Error("INVALID_CATALOG_RESPONSE");
}
