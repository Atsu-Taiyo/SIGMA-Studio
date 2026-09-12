import type { TextFlowIdFactory } from "../model";

/**
 * Default application adapter for creating persisted SigmaDoc ids.
 *
 * Pure model operations receive an explicit `TextFlowIdFactory`; this adapter
 * keeps runtime entropy out of the model while preserving the editor's existing
 * id format for callers that do not inject a deterministic factory.
 */
export const createTextFlowId: TextFlowIdFactory = (prefix) => {
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  return `${prefix}_${random}`;
};
