import type { DocumentSessionHost } from "./contracts";

/**
 * Whether an editor may change `fileId` now. The editing pane and the passive panes beside
 * it use this one rule.
 *
 * A file the library lists as shared is written only through its session; the host rejects
 * a whole-document save of it. Without a session (not attached to this renderer yet), such a
 * file is read-only rather than collecting edits that could never be saved.
 */
export function isDocumentWritable(
  host: DocumentSessionHost | undefined,
  fileId: string,
  shared: boolean,
): boolean {
  const session = host?.get(fileId);
  if (session) return session.writable;
  return !shared && !(host?.isReadOnly?.(fileId) ?? false);
}
