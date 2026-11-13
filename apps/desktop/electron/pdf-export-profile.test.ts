import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfExportProfile } from "./pdf-export-profile";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("PDF export profiling", () => {
  it("stays silent by default and preserves task results", async () => {
    vi.stubEnv("SIGMA_STUDIO_PDF_PROFILE", "");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const profile = new PdfExportProfile();
    expect(await profile.measure("print-to-pdf", async () => 42, 0)).toBe(42);
    profile.finish(1, true);
    expect(log).not.toHaveBeenCalled();
  });

  it("records durations on failure without logging the error or task data", async () => {
    vi.stubEnv("SIGMA_STUDIO_PDF_PROFILE", "1");
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const profile = new PdfExportProfile();
    const error = new Error("private document text/path");
    await expect(profile.measure("capture-ipc", async () => { throw error; }, 2)).rejects.toBe(error);
    profile.record([{ stage: "capture-clone", ms: 3 }], 2);
    profile.finish(3, false);
    const output = String(log.mock.calls[0][0]);
    expect(output).not.toContain(error.message);
    const result = JSON.parse(output.slice("[pdf-profile] ".length));
    expect(result).toMatchObject({ pageCount: 3, success: false, entries: [
      { stage: "capture-ipc", pageIndex: 2, ms: expect.any(Number) },
      { stage: "capture-clone", pageIndex: 2, ms: 3 },
    ] });
    expect(result.entries[0].ms).toBeGreaterThanOrEqual(0);
  });
});
