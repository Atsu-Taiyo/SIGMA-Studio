import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DEFAULT_DOCUMENT_TITLE } from "@/lib/document-title";
import { LIBRARY_VERSION } from "@/lib/library-schema";
import { getModuleSpecifiers } from "../tests/helpers/source-dependencies";
import { isValidDocumentFileId } from "./document-file-id";
import {
  createEmptyLibrary,
  normalizeFolderName,
  normalizeWorkspaceName,
  parseLibrary,
  type LibraryParseOutcome,
} from "./local-library-record";

const EPOCH = "1970-01-01T00:00:00.000Z";

function parseRecord(value: Record<string, unknown>): LibraryParseOutcome {
  const result = parseLibrary(JSON.stringify({ version: LIBRARY_VERSION, ...value }));
  expect(result.status).toBe("parsed");
  if (result.status !== "parsed") throw new Error(`Unexpected parse result: ${result.status}`);
  return result.outcome;
}

describe("local library record recovery", () => {
  it.each(["", "{", "null", "[]", '"library"', "42"])("distinguishes unreadable JSON records: %j", (raw) => {
    expect(parseLibrary(raw)).toEqual({ status: "unreadable" });
  });

  it("reports schema violations before attempting any row repair", () => {
    expect(parseLibrary(JSON.stringify({
      version: 1,
      workspaces: [{ kind: "remote" }],
      files: [{ cloudState: null }],
    }))).toEqual({
      status: "schema-violation",
      violations: [
        { path: "version", reason: { kind: "versionMismatch" }, expected: String(LIBRARY_VERSION), received: "1" },
        { path: "workspaces[0].kind", reason: { kind: "forbiddenField", field: "kind" }, expected: null, received: '"remote"' },
        { path: "files[0].cloudState", reason: { kind: "forbiddenField", field: "cloudState" }, expected: null, received: "null" },
      ],
    });
  });

  it("accepts missing arrays as empty without a recovery report", () => {
    expect(parseRecord({})).toEqual({
      library: createEmptyLibrary(),
      repairs: [],
      quarantinedRows: [],
      quarantinedArrays: [],
    });
  });

  it("recovers identifiable rows without giving undated content a recent sort position", () => {
    const outcome = parseRecord({
      workspaces: [{ id: "workspace_kept" }],
      folders: [{ id: "folder_kept", workspaceId: "workspace_kept" }],
      files: [{ fileId: "file_kept", documentPath: 42 }],
    });

    expect(outcome.library).toEqual({
      version: LIBRARY_VERSION,
      activeWorkspaceId: "",
      workspaces: [{ id: "workspace_kept", name: "マイ教材", createdAt: EPOCH, updatedAt: EPOCH, deletedAt: null }],
      folders: [{
        id: "folder_kept", workspaceId: "workspace_kept", parentFolderId: null,
        name: "無題のフォルダ", createdAt: EPOCH, updatedAt: EPOCH, deletedAt: null,
      }],
      files: [{
        fileId: "file_kept", workspaceId: "", folderId: null, docId: "", title: DEFAULT_DOCUMENT_TITLE,
        documentPath: undefined, revision: 1, createdAt: EPOCH, updatedAt: EPOCH, deletedAt: null,
      }],
    });
    expect(outcome.repairs).toEqual([
      { table: "workspaces", id: "workspace_kept", fields: ["name", "createdAt", "updatedAt", "deletedAt"] },
      { table: "folders", id: "folder_kept", fields: ["parentFolderId", "name", "createdAt", "updatedAt", "deletedAt"] },
      { table: "files", id: "file_kept", fields: ["workspaceId", "folderId", "docId", "title", "documentPath", "revision", "createdAt", "updatedAt", "deletedAt"] },
    ]);
    expect(outcome.quarantinedRows).toEqual([]);
    expect(outcome.quarantinedArrays).toEqual([]);
  });

  it("retains earlier quarantine and then unreadable rows and arrays in report order", () => {
    const malformedWorkspace = { name: "Lost ID", future: { content: [1, 2] } };
    const malformedFolderArray = { folder: "legacy" };
    const malformedFile = { fileId: "../unsafe", title: "Recover manually" };
    const prior = { prior: true };
    const outcome = parseRecord({
      quarantine: [prior],
      workspaces: [malformedWorkspace, { id: "workspace_kept" }],
      folders: malformedFolderArray,
      files: [malformedFile, null, { fileId: "file_kept" }],
    });

    expect(outcome.quarantinedRows).toEqual([
      { table: "workspaces", raw: malformedWorkspace },
      { table: "files", raw: malformedFile },
      { table: "files", raw: null },
    ]);
    expect(outcome.quarantinedArrays).toEqual([{ table: "folders", raw: malformedFolderArray }]);
    expect(outcome.library.quarantine).toEqual([prior, malformedWorkspace, malformedFile, null, malformedFolderArray]);
    expect(outcome.library.workspaces.map((row) => row.id)).toEqual(["workspace_kept"]);
    expect(outcome.library.files.map((row) => row.fileId)).toEqual(["file_kept"]);

    const reread = parseRecord(outcome.library);
    expect(reread.library).toEqual(outcome.library);
    expect(reread.repairs).toEqual([]);
    expect(reread.quarantinedRows).toEqual([]);
    expect(reread.quarantinedArrays).toEqual([]);
  });

  it("preserves unknown row fields through repair and repeated serialization", () => {
    const extensions = { futureFields: { nested: ["content", { revision: 2 }] }, isPinned: true };
    const first = parseRecord({
      workspaces: [{ id: "workspace_kept", ...extensions }],
      folders: [{ id: "folder_kept", workspaceId: "workspace_kept", ...extensions }],
      files: [{ fileId: "file_kept", ...extensions }],
    });
    const second = parseRecord(first.library);

    for (const rows of [second.library.workspaces, second.library.folders, second.library.files]) {
      expect(rows[0]).toMatchObject(extensions);
    }
    expect(second.library).toEqual(first.library);
    expect(second.repairs).toEqual([]);
  });

  it("uses a surviving timestamp and preserves accepted blank strings and finite revisions", () => {
    const outcome = parseRecord({
      activeWorkspaceId: "workspace_kept",
      workspaces: [{ id: "workspace_kept", name: "  Name  ", updatedAt: "2020-01-01", deletedAt: "   " }],
      folders: [{ id: "folder_kept", workspaceId: "workspace_kept", parentFolderId: null, name: "Folder", createdAt: "2021-01-01", deletedAt: " archived " }],
      files: [{
        fileId: "file_kept", workspaceId: "", folderId: "", docId: "", title: "", documentPath: "",
        revision: -0.5, createdAt: "", updatedAt: "", deletedAt: null,
      }],
    });

    expect(outcome.library.activeWorkspaceId).toBe("workspace_kept");
    expect(outcome.library.workspaces[0]).toMatchObject({ name: "Name", createdAt: "2020-01-01", updatedAt: "2020-01-01", deletedAt: null });
    expect(outcome.library.folders[0]).toMatchObject({ createdAt: "2021-01-01", updatedAt: "2021-01-01", deletedAt: " archived " });
    expect(outcome.library.files[0]).toMatchObject({ title: "", documentPath: "", revision: -0.5, createdAt: "", updatedAt: "" });
    expect(outcome.repairs).toEqual([
      { table: "workspaces", id: "workspace_kept", fields: ["createdAt"] },
      { table: "folders", id: "folder_kept", fields: ["updatedAt"] },
    ]);
  });

  it("keeps the existing persisted name defaults and length limits", () => {
    expect(normalizeWorkspaceName(" \n ")).toBe("マイ教材");
    expect(normalizeFolderName(" \n ")).toBe("無題のフォルダ");
    expect(normalizeWorkspaceName(` ${"a".repeat(121)} `)).toBe("a".repeat(120));
    expect(normalizeFolderName(` ${"b".repeat(161)} `)).toBe("b".repeat(160));
  });
});

describe("document file identity", () => {
  it.each(["file_a", "file_A0", "file_123-ABC", "file_12345678-abcd-1234-abcd-123456789abc"])("accepts persisted IDs: %s", (fileId) => {
    expect(isValidDocumentFileId(fileId)).toBe(true);
    expect(parseRecord({ files: [{ fileId }] }).library.files[0].fileId).toBe(fileId);
  });

  it.each(["", "file_", "file_-a", "file_a-", "file_a--b", "file_a/b", "file_a\\b", "file_a%2Fb", "file_..", "../file_a", "file_a\n", "version_a"])("quarantines IDs that cannot name a document file: %j", (fileId) => {
    expect(isValidDocumentFileId(fileId)).toBe(false);
    const outcome = parseRecord({ files: [{ fileId }] });
    expect(outcome.library.files).toEqual([]);
    expect(outcome.library.quarantine).toEqual([{ fileId }]);
  });
});

describe("local library recovery boundary", () => {
  it("keeps parsing independent of file IO, locks, watchers, and the store controller", () => {
    const allowedImports = new Set([
      "@/lib/document-title",
      "@/lib/library-ledger",
      "@/lib/library-schema",
      "./document-file-id",
    ]);
    const parser = readFileSync(new URL("./local-library-record.ts", import.meta.url), "utf8");
    const identity = readFileSync(new URL("./document-file-id.ts", import.meta.url), "utf8");
    expect(getModuleSpecifiers(parser).filter((specifier) => !allowedImports.has(specifier))).toEqual([]);
    expect(getModuleSpecifiers(identity)).toEqual([]);
  });
});
