import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV, toolActivityFileName } from "../electron/ai-edit-run-context";
import { SIGMA_STUDIO_MCP_PROVIDER_ENV } from "../electron/sigma-studio-mcp-launch";
import { createToolActivityLogger } from "./tool-activity";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRunContextFile(): { dir: string; runContextFile: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "tool-activity-"));
  tempDirs.push(dir);
  return { dir, runContextFile: path.join(dir, "antigravity.run-context.json") };
}

async function flushAsyncWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("createToolActivityLogger", () => {
  it("is a noop (writes nothing) when SIGMA_STUDIO_MCP_PROVIDER is not antigravity", async () => {
    const { dir, runContextFile } = makeRunContextFile();
    const logger = createToolActivityLogger({
      [SIGMA_STUDIO_MCP_PROVIDER_ENV]: "claude",
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: runContextFile,
    });

    logger({ callId: "call_1", tool: "insert_shape", status: "started" });
    await flushAsyncWrites();

    expect(existsSync(path.join(dir, toolActivityFileName("antigravity")))).toBe(false);
  });

  it("is a noop when SIGMA_STUDIO_RUN_CONTEXT_FILE is unset or blank", async () => {
    const loggerUnset = createToolActivityLogger({ [SIGMA_STUDIO_MCP_PROVIDER_ENV]: "antigravity" });
    const loggerBlank = createToolActivityLogger({
      [SIGMA_STUDIO_MCP_PROVIDER_ENV]: "antigravity",
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: "   ",
    });

    // Neither should throw; there is no directory to assert against since no path was given.
    expect(() => loggerUnset({ callId: "call_1", tool: "insert_shape", status: "started" })).not.toThrow();
    expect(() => loggerBlank({ callId: "call_1", tool: "insert_shape", status: "started" })).not.toThrow();
  });

  it("appends a JSONL line to the static provider file when no runId is given", async () => {
    const { dir, runContextFile } = makeRunContextFile();
    const logger = createToolActivityLogger({
      [SIGMA_STUDIO_MCP_PROVIDER_ENV]: "antigravity",
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: runContextFile,
    });

    logger({ callId: "call_1", tool: "insert_shape", status: "started" });
    await flushAsyncWrites();

    const filePath = path.join(dir, toolActivityFileName("antigravity"));
    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({ callId: "call_1", tool: "insert_shape", status: "started" });
    expect(parsed.runId).toBeUndefined();
    expect(typeof parsed.ts).toBe("number");
  });

  it("appends to the per-run file (not the static one) when a runId is given, in the same directory as the run-context file", async () => {
    const { dir, runContextFile } = makeRunContextFile();
    const logger = createToolActivityLogger({
      [SIGMA_STUDIO_MCP_PROVIDER_ENV]: "antigravity",
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: runContextFile,
    });

    logger({ callId: "call_1", tool: "insert_graph", runId: "run_abc", status: "completed" });
    await flushAsyncWrites();

    const perRunPath = path.join(dir, toolActivityFileName("antigravity", "run_abc"));
    const staticPath = path.join(dir, toolActivityFileName("antigravity"));
    expect(existsSync(staticPath)).toBe(false);
    const parsed = JSON.parse(readFileSync(perRunPath, "utf8").trim());
    expect(parsed).toMatchObject({ callId: "call_1", tool: "insert_graph", runId: "run_abc", status: "completed" });
  });

  it("appends multiple events as separate JSONL lines in order", async () => {
    const { dir, runContextFile } = makeRunContextFile();
    const logger = createToolActivityLogger({
      [SIGMA_STUDIO_MCP_PROVIDER_ENV]: "antigravity",
      [SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]: runContextFile,
    });

    logger({ callId: "call_1", tool: "insert_shape", status: "started" });
    logger({ callId: "call_1", tool: "insert_shape", status: "completed" });
    await flushAsyncWrites();

    const filePath = path.join(dir, toolActivityFileName("antigravity"));
    const lines = readFileSync(filePath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).status).toBe("started");
    expect(JSON.parse(lines[1]).status).toBe("completed");
  });
});
