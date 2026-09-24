import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import * as sync from "y-protocols/sync";
import * as Y from "yjs";

export const COLLABORATION_PROTOCOL = 1;
export const MAX_UPDATE_BYTES = 2 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
export const MAX_ASSET_BYTES = 20 * 1024 * 1024;
export type MemberRole = "owner" | "admin" | "editor" | "viewer";
export type SaveState =
  | "local-saving"
  | "local-saved"
  | "syncing"
  | "saved"
  | "offline"
  | "permission-error"
  | "save-error"
  | "epoch-error";
export interface OperationIdentity {
  operationId: string;
  actorId: string;
  kind: "manual" | "ai" | "undo" | "redo";
}
export interface SharedIdentity {
  sharedDocumentId: string;
  epoch: number;
  protocol: typeof COLLABORATION_PROTOCOL;
}
export interface SharedBinding extends SharedIdentity {
  localFileId: string;
  docId: string;
}

export function toBase64(bytes: Uint8Array): string {
  let value = "";
  for (let i = 0; i < bytes.length; i += 8192)
    value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
}
export function fromBase64(
  value: string,
  limit = MAX_UPDATE_BYTES,
): Uint8Array {
  if (value.length > Math.ceil(limit / 3) * 4 + 4)
    throw new Error("PAYLOAD_LIMIT");
  const binary = atob(value);
  if (binary.length > limit) throw new Error("PAYLOAD_LIMIT");
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
export function syncStepOne(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  sync.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}
export function syncUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  sync.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}
/** Decode the standard Yjs protocol without mutating a live authoritative replica. */
export function decodeSyncMessage(message: Uint8Array): {
  kind: "vector" | "update";
  bytes: Uint8Array;
} {
  if (message.length > MAX_UPDATE_BYTES + 16) throw new Error("PAYLOAD_LIMIT");
  const decoder = decoding.createDecoder(message);
  const type = decoding.readVarUint(decoder);
  if (
    type !== sync.messageYjsSyncStep1 &&
    type !== sync.messageYjsSyncStep2 &&
    type !== sync.messageYjsUpdate
  )
    throw new Error("PROTOCOL_ERROR");
  const bytes = decoding.readVarUint8Array(decoder);
  if (decoding.hasContent(decoder)) throw new Error("PROTOCOL_ERROR");
  return {
    kind: type === sync.messageYjsSyncStep1 ? "vector" : "update",
    bytes,
  };
}
export function syncStepTwo(doc: Y.Doc, vector: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  sync.writeSyncStep2(encoder, doc, vector);
  return encoding.toUint8Array(encoder);
}
