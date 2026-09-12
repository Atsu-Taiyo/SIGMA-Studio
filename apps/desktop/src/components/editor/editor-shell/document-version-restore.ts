export interface DocumentVersionRestoreContext<T> {
  fileId: string;
  observedRevision: number;
  dirtyRevision: number;
  document: T;
}

export type DocumentVersionRestoreResult =
  | { ok: true }
  | { ok: false; error: string };

interface DocumentVersionRestoreStepResult {
  ok: boolean;
  error?: string;
}

export interface RunDocumentVersionRestoreOptions {
  captureBackup: () => Promise<DocumentVersionRestoreStepResult>;
  isContextCurrent: () => boolean;
  applyVersion: () => boolean;
  saveRestoredDocument: () => Promise<DocumentVersionRestoreStepResult>;
  applyRejectedError: string;
  saveAppliedError: string;
  fallbackError: string;
}

/** A restore may cross its backup await only if the exact editor context is still current. */
export function isDocumentVersionRestoreContextCurrent<T>(
  expected: DocumentVersionRestoreContext<T>,
  current: DocumentVersionRestoreContext<T>,
): boolean {
  return current.fileId === expected.fileId
    && current.observedRevision === expected.observedRevision
    && current.dirtyRevision === expected.dirtyRevision
    && current.document === expected.document;
}

export async function runDocumentVersionRestore(
  options: RunDocumentVersionRestoreOptions,
): Promise<DocumentVersionRestoreResult> {
  let backup: DocumentVersionRestoreStepResult;
  try {
    backup = await options.captureBackup();
  } catch {
    return { ok: false, error: options.fallbackError };
  }
  if (!backup.ok) return { ok: false, error: backup.error ?? options.fallbackError };
  if (!options.isContextCurrent()) return { ok: false, error: options.fallbackError };

  if (!options.applyVersion()) {
    return { ok: false, error: options.applyRejectedError };
  }
  try {
    const saved = await options.saveRestoredDocument();
    return saved.ok
      ? { ok: true }
      : { ok: false, error: options.saveAppliedError };
  } catch {
    return { ok: false, error: options.saveAppliedError };
  }
}
