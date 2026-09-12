import { describe, expect, it, vi } from "vitest";

import {
  lookupWorkspacePreviewImage,
  persistWorkspacePreviewImage,
  readWorkspacePreviewMemory,
  workspacePreviewCacheKey,
} from "./workspace-preview-image";

const PNG = "data:image/png;base64,abc";

describe("workspace preview image cache", () => {
  it("keys rasters by fileId and revision", () => {
    expect(workspacePreviewCacheKey("file_1", 3)).toBe("file_1:3");
  });

  it("returns a memory hit without touching disk", async () => {
    const get = vi.fn();
    vi.stubGlobal("window", { desktopAPI: { workspacePreview: { get, put: vi.fn() } } });
    await persistWorkspacePreviewImage("file_mem", 2, PNG);
    await expect(lookupWorkspacePreviewImage("file_mem", 2)).resolves.toBe(PNG);
    expect(readWorkspacePreviewMemory("file_mem", 2)).toBe(PNG);
    expect(get).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
