import { expect, it } from "vitest";
import type { DocumentSession, DocumentSessionHost } from "./contracts";
import { isDocumentWritable } from "./writable";

const session = (writable: boolean) => ({ writable }) as DocumentSession;
const host = (sessions: Record<string, DocumentSession>, restricted: string[] = []): DocumentSessionHost => ({
  get: (fileId) => sessions[fileId],
  isReadOnly: (fileId) => restricted.includes(fileId),
});

it("writes a shared file only through its session", () => {
  // Before its session reaches the renderer, a shared file must not collect edits that
  // could only be saved as JSON (main rejects those with SHARED_SESSION_WRITE_REQUIRED).
  expect(isDocumentWritable(host({}), "shared", true)).toBe(false);
  expect(isDocumentWritable(host({ shared: session(true) }), "shared", true)).toBe(true);
  expect(isDocumentWritable(host({ shared: session(false) }), "shared", true)).toBe(false);
});

it("keeps local files writable and respects host restrictions", () => {
  expect(isDocumentWritable(host({}), "local", false)).toBe(true);
  expect(isDocumentWritable(undefined, "local", false)).toBe(true);
  expect(isDocumentWritable(host({}, ["other-account"]), "other-account", false)).toBe(false);
});
