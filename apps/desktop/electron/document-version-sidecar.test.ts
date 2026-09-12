import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBlankDocument } from "@/lib/blank-document";
import {
  appendDocumentVersion,
  deleteDocumentVersions,
  DOCUMENT_VERSION_INDEX_FILE_NAME,
  DocumentVersionIndexMalformedError,
  readDocumentVersion,
  readDocumentVersionMetadata,
  readLatestDocumentVersionMetadata,
  resolveDocumentVersionDirectory,
  resolveDocumentVersionSnapshotPath,
} from "./document-version-sidecar";

describe("document version sidecar", () => {
  let sandboxDir: string;
  let rootDir: string;
  beforeEach(async () => {
    sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-versions-"));
    rootDir = path.join(sandboxDir, "doc-versions");
    await fs.mkdir(rootDir);
  });
  afterEach(async () => {
    await fs.rm(sandboxDir, { recursive: true, force: true });
  });

  it("appends metadata separately from snapshots and reads one version", async () => {
    const document = createBlankDocument("履歴");
    await appendDocumentVersion(rootDir, "file_unsafe", {
      versionId: "version_1",
      revision: 2,
      capturedAt: "2026-09-01T00:00:00.000Z",
      origin: "user",
      document,
    });
    expect(await readDocumentVersionMetadata(rootDir, "file_unsafe")).toEqual([{
      versionId: "version_1",
      revision: 2,
      capturedAt: "2026-09-01T00:00:00.000Z",
      origin: "user",
    }]);
    expect((await readDocumentVersion(rootDir, "file_unsafe", "version_1"))?.document.metadata.title).toBe("履歴");
  });

  it.each(["", ".", "..", "/", "\\", "%2F", "%5C", "file/%2F"])(
    "rejects unsafe fileId %j before recursive deletion",
    async (fileId) => {
      const sentinelPath = path.join(rootDir, "sentinel.txt");
      await fs.writeFile(sentinelPath, "keep", "utf8");
      expect(() => resolveDocumentVersionDirectory(rootDir, fileId)).toThrow("Invalid fileId");
      await expect(deleteDocumentVersions(rootDir, fileId)).rejects.toThrow("Invalid fileId");
      await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("keep");
    },
  );

  it.each(["", ".", "..", "/", "\\", "%2F", "%5C", "version/%2F"])(
    "rejects unsafe versionId %j",
    (versionId) => {
      expect(() => resolveDocumentVersionSnapshotPath(rootDir, "file_1", versionId)).toThrow("Invalid versionId");
    },
  );

  it("returns an empty list only for a missing index and surfaces corruption or I/O failures", async () => {
    expect(await readDocumentVersionMetadata(rootDir, "file_1")).toEqual([]);
    const directory = resolveDocumentVersionDirectory(rootDir, "file_1");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, DOCUMENT_VERSION_INDEX_FILE_NAME), "{not-json}\n", "utf8");
    await expect(readDocumentVersionMetadata(rootDir, "file_1"))
      .rejects.toBeInstanceOf(DocumentVersionIndexMalformedError);

    const ioError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const readFile = vi.spyOn(fs, "readFile").mockRejectedValueOnce(ioError);
    await expect(readDocumentVersionMetadata(rootDir, "file_1")).rejects.toBe(ioError);
    readFile.mockRestore();
  });

  it("treats metadata with a non-ISO capturedAt as a malformed index row", async () => {
    const directory = resolveDocumentVersionDirectory(rootDir, "file_1");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, DOCUMENT_VERSION_INDEX_FILE_NAME), `${JSON.stringify({
      versionId: "version_1",
      revision: 1,
      capturedAt: "not-a-date",
      origin: "user",
    })}\n`, "utf8");

    await expect(readDocumentVersionMetadata(rootDir, "file_1"))
      .rejects.toBeInstanceOf(DocumentVersionIndexMalformedError);
  });

  it("accepts and strips extra fields from an older index row", async () => {
    const directory = resolveDocumentVersionDirectory(rootDir, "file_1");
    await fs.mkdir(directory, { recursive: true });
    const legacyStats = {
      [["added", "Words"].join("")]: 2,
      [["removed", "Words"].join("")]: 1,
    };
    await fs.writeFile(path.join(directory, DOCUMENT_VERSION_INDEX_FILE_NAME), `${JSON.stringify({
      versionId: "version_legacy",
      revision: 1,
      capturedAt: "2026-09-01T00:00:00.000Z",
      origin: "user",
      stats: legacyStats,
    })}\n`, "utf8");

    await expect(readDocumentVersionMetadata(rootDir, "file_1")).resolves.toEqual([{
      versionId: "version_legacy",
      revision: 1,
      capturedAt: "2026-09-01T00:00:00.000Z",
      origin: "user",
    }]);
  });

  it("truncates and counts only an unterminated malformed tail", async () => {
    const directory = resolveDocumentVersionDirectory(rootDir, "file_1");
    const indexPath = path.join(directory, DOCUMENT_VERSION_INDEX_FILE_NAME);
    const valid = JSON.stringify({
      versionId: "version_1",
      revision: 1,
      capturedAt: "2026-09-01T00:00:00.000Z",
      origin: "user",
    });
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(indexPath, `${valid}\n{"versionId":"version_torn"`, "utf8");
    const recoveries: Array<{ discardedBytes: number }> = [];

    await expect(readLatestDocumentVersionMetadata(rootDir, "file_1", {
      onIndexTailRecovered: (recovery) => recoveries.push(recovery),
    })).resolves.toMatchObject({ versionId: "version_1" });
    await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(`${valid}\n`);
    expect(recoveries).toEqual([expect.objectContaining({
      kind: "truncated-malformed-tail",
      discardedBytes: Buffer.byteLength('{"versionId":"version_torn"'),
    })]);
  });

  it("does not truncate a version appended while malformed-tail recovery is waiting", async () => {
    const directory = resolveDocumentVersionDirectory(rootDir, "file_1");
    const indexPath = path.join(directory, DOCUMENT_VERSION_INDEX_FILE_NAME);
    const firstMetadata = {
      versionId: "version_1",
      revision: 1,
      capturedAt: "2026-09-01T00:00:00.000Z",
      origin: "user" as const,
    };
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(indexPath, `${JSON.stringify(firstMetadata)}\n{"versionId":"version_torn"`, "utf8");

    let allowTruncate!: () => void;
    let reportTruncateStarted!: () => void;
    const truncateStarted = new Promise<void>((resolve) => {
      reportTruncateStarted = resolve;
    });
    const truncateAllowed = new Promise<void>((resolve) => {
      allowTruncate = resolve;
    });
    const realTruncate = fs.truncate;
    const truncate = vi.spyOn(fs, "truncate").mockImplementation(async (...args) => {
      reportTruncateStarted();
      await truncateAllowed;
      return realTruncate(...args);
    });

    try {
      const recovering = readDocumentVersionMetadata(rootDir, "file_1");
      await truncateStarted;
      const appended = appendDocumentVersion(rootDir, "file_1", {
        versionId: "version_2",
        revision: 2,
        capturedAt: "2026-09-01T00:01:00.000Z",
        origin: "ai",
        document: createBlankDocument("追記版"),
      });
      allowTruncate();

      await expect(recovering).resolves.toEqual([firstMetadata]);
      await appended;
      await expect(readDocumentVersionMetadata(rootDir, "file_1")).resolves.toEqual([
        firstMetadata,
        expect.objectContaining({ versionId: "version_2", revision: 2 }),
      ]);
    } finally {
      truncate.mockRestore();
    }
  });

  it("completes a valid unterminated tail before a later append", async () => {
    const directory = resolveDocumentVersionDirectory(rootDir, "file_1");
    const indexPath = path.join(directory, DOCUMENT_VERSION_INDEX_FILE_NAME);
    const valid = JSON.stringify({
      versionId: "version_1",
      revision: 1,
      capturedAt: "2026-09-01T00:00:00.000Z",
      origin: "user",
    });
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(indexPath, valid, "utf8");
    const recoveries: Array<{ kind: string }> = [];

    await expect(readLatestDocumentVersionMetadata(rootDir, "file_1", {
      onIndexTailRecovered: (recovery) => recoveries.push(recovery),
    })).resolves.toMatchObject({ versionId: "version_1" });

    expect(recoveries).toEqual([expect.objectContaining({ kind: "completed-line-terminator" })]);
    await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(`${valid}\n`);
  });

  it("does not recover malformed lines before the unterminated tail", async () => {
    const directory = resolveDocumentVersionDirectory(rootDir, "file_1");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, DOCUMENT_VERSION_INDEX_FILE_NAME),
      "{not-json}\n{also-torn",
      "utf8",
    );

    await expect(readDocumentVersionMetadata(rootDir, "file_1"))
      .rejects.toBeInstanceOf(DocumentVersionIndexMalformedError);
  });

  it("prunes snapshot files and compacts the index to 200 versions", async () => {
    const document = createBlankDocument("履歴");
    for (let index = 0; index < 201; index += 1) {
      await appendDocumentVersion(rootDir, "file_1", {
        versionId: `version_${index}`,
        revision: index,
        capturedAt: new Date(index * 1_000).toISOString(),
        origin: "user",
        document,
      });
    }
    const metadata = await readDocumentVersionMetadata(rootDir, "file_1");
    expect(metadata).toHaveLength(200);
    expect(metadata[0]?.versionId).toBe("version_1");
    await expect(fs.stat(resolveDocumentVersionSnapshotPath(rootDir, "file_1", "version_0"))).rejects.toThrow();
  });
});
