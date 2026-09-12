import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { VisualSessionsStatusFile } from "../electron/visual-session-status";
import { resolveVisualSessionStatusFile } from "./visual-session-status-file";

const status: VisualSessionsStatusFile = {
  version: 1,
  updatedAt: "2026-09-09T00:00:00.000Z",
  sessions: [{ sessionId: "visual_session", targetId: "anchor", operationCount: 1, revision: 1, lastReviewPassed: true, proposed: true, discarded: false }],
};

afterEach(() => vi.restoreAllMocks());

function mockFileSystem(failure?: "mkdir" | "writeFile" | "rename" | "unlink") {
  const calls: Array<{ operation: string; args: unknown[] }> = [];
  for (const operation of ["mkdir", "writeFile", "rename", "unlink"] as const) {
    vi.spyOn(fs, operation).mockImplementation(async (...args: unknown[]) => {
      calls.push({ operation, args });
      if (operation === failure) throw new Error(`${operation} failed`);
      return undefined;
    });
  }
  return calls;
}

describe("visual status file writer", () => {
  it("resolves the current destination and preserves atomic write/rename/cleanup order", async () => {
    const calls = mockFileSystem();
    const env = { SIGMA_STUDIO_RUN_CONTEXT_FILE: " ./tmp/visual/context.json " };
    const target = resolveVisualSessionStatusFile(env, "claude", "run/one")!;
    const directory = path.resolve("./tmp/visual");
    expect(target.key).toBe(path.join(directory, "claude-run_one.visual-sessions.json"));
    env.SIGMA_STUDIO_RUN_CONTEXT_FILE = "./somewhere/else/context.json";
    expect(calls).toEqual([]);
    await expect(target.write(status)).resolves.toBeUndefined();
    expect(calls.map(({ operation }) => operation)).toEqual(["mkdir", "writeFile", "rename", "unlink"]);
    const temporaryPath = calls[1].args[0];
    expect(temporaryPath).toEqual(expect.stringMatching(/claude-run_one\.visual-sessions\.json\.tmp-[a-z0-9-]+$/));
    expect(calls).toEqual([
      { operation: "mkdir", args: [directory, { recursive: true }] },
      { operation: "writeFile", args: [temporaryPath, JSON.stringify(status), "utf8"] },
      { operation: "rename", args: [temporaryPath, target.key] },
      { operation: "unlink", args: [temporaryPath] },
    ]);
  });

  it.each([
    { failure: "mkdir" as const, expected: ["mkdir", "unlink"] },
    { failure: "writeFile" as const, expected: ["mkdir", "writeFile", "unlink"] },
    { failure: "rename" as const, expected: ["mkdir", "writeFile", "rename", "unlink"] },
    { failure: "unlink" as const, expected: ["mkdir", "writeFile", "rename", "unlink"] },
  ])("swallows $failure errors and always attempts temporary-file cleanup", async ({ failure, expected }) => {
    const calls = mockFileSystem(failure);
    const target = resolveVisualSessionStatusFile({ SIGMA_STUDIO_RUN_CONTEXT_FILE: "/tmp/status/context.json" }, "claude", "run")!;
    await expect(target.write(status)).resolves.toBeUndefined();
    expect(calls.map(({ operation }) => operation)).toEqual(expected);
    expect(calls.at(-1)?.args[0]).toEqual(expect.stringContaining(`${target.key}.tmp-`));
  });

  it("does not create a target without provider, run ID, or a run-context directory", () => {
    const env = { SIGMA_STUDIO_RUN_CONTEXT_FILE: "/tmp/status/context.json" };
    expect(resolveVisualSessionStatusFile(env, null, "run")).toBeNull();
    expect(resolveVisualSessionStatusFile(env, "claude", undefined)).toBeNull();
    expect(resolveVisualSessionStatusFile(env, "claude", "")).toBeNull();
    expect(resolveVisualSessionStatusFile({}, "claude", "run")).toBeNull();
    expect(resolveVisualSessionStatusFile({ SIGMA_STUDIO_RUN_CONTEXT_FILE: "  " }, "claude", "run")).toBeNull();
  });
});
