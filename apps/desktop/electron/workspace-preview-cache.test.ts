import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readWorkspacePreviewPng,
  sanitizeWorkspacePreviewFileId,
  workspacePreviewCachePath,
  writeWorkspacePreviewPng,
} from "./workspace-preview-cache";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;

describe("workspace preview disk cache", () => {
  let userDataPath = "";

  afterEach(async () => {
    if (userDataPath) {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("round-trips a PNG keyed by fileId and revision", async () => {
    userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-preview-"));
    expect(await readWorkspacePreviewPng(userDataPath, "file_1", 3)).toBeNull();
    expect(await writeWorkspacePreviewPng(userDataPath, "file_1", 3, PNG_DATA_URL)).toBe(true);
    expect(await readWorkspacePreviewPng(userDataPath, "file_1", 3)).toBe(PNG_DATA_URL);
    expect(await fs.readFile(workspacePreviewCachePath(userDataPath, "file_1", 3))).toEqual(PNG_BYTES);
  });

  it("invalidates older revisions for the same file", async () => {
    userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-preview-"));
    await writeWorkspacePreviewPng(userDataPath, "file_1", 1, PNG_DATA_URL);
    await writeWorkspacePreviewPng(userDataPath, "file_1", 2, PNG_DATA_URL);
    expect(await readWorkspacePreviewPng(userDataPath, "file_1", 1)).toBeNull();
    expect(await readWorkspacePreviewPng(userDataPath, "file_1", 2)).toBe(PNG_DATA_URL);
  });

  it("sanitizes file ids so they stay on disk", () => {
    expect(sanitizeWorkspacePreviewFileId("../secret")).toBe(".._secret");
  });
});
