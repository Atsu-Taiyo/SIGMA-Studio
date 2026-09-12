import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { toolActivityFileName } from "./ai-edit-run-context";
import { ToolActivityWatcher, type ToolActivityEvent } from "./gemini-tool-activity-watcher";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRunContextDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gemini-tool-activity-watcher-"));
  tempDirs.push(dir);
  return dir;
}

function appendLine(dir: string, fileName: string, event: Partial<ToolActivityEvent> & { callId: string; tool: string; status: string }): void {
  appendFileSync(path.join(dir, fileName), `${JSON.stringify({ ts: Date.now(), ...event })}\n`, "utf8");
}

async function waitForEvents(count: number, events: ToolActivityEvent[], timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (events.length < count) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${count} events, got ${events.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("ToolActivityWatcher", () => {
  it("does not surface lines that were already in the static file before start()", async () => {
    const runContextDir = makeRunContextDir();
    const runId = "run_watch_1";
    // A previous, unrelated run's leftover activity in the shared static file.
    appendLine(runContextDir, toolActivityFileName("antigravity"), { callId: "old_call", tool: "insert_table", status: "started" });

    const events: ToolActivityEvent[] = [];
    const watcher = new ToolActivityWatcher({
      runContextDir,
      runId,
      pollIntervalMs: 20,
      onActivity: (event) => events.push(event),
    });
    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await watcher.stop();

    expect(events).toHaveLength(0);
  });

  it("surfaces appends to both the per-run file and the static file after start()", async () => {
    const runContextDir = makeRunContextDir();
    const runId = "run_watch_2";
    const events: ToolActivityEvent[] = [];
    const watcher = new ToolActivityWatcher({
      runContextDir,
      runId,
      pollIntervalMs: 20,
      onActivity: (event) => events.push(event),
    });
    watcher.start();

    appendLine(runContextDir, toolActivityFileName("antigravity", runId), { callId: "call_1", tool: "insert_shape", runId, status: "started" });
    appendLine(runContextDir, toolActivityFileName("antigravity"), { callId: "call_2", tool: "get_attached_media", status: "started" });

    await waitForEvents(2, events);
    await watcher.stop();

    expect(events.some((e) => e.callId === "call_1" && e.tool === "insert_shape" && e.status === "started")).toBe(true);
    expect(events.some((e) => e.callId === "call_2" && e.tool === "get_attached_media" && e.status === "started")).toBe(true);
  });

  it("buffers a trailing incomplete line until the rest of it arrives", async () => {
    const runContextDir = makeRunContextDir();
    const runId = "run_watch_3";
    const events: ToolActivityEvent[] = [];
    const watcher = new ToolActivityWatcher({
      runContextDir,
      runId,
      pollIntervalMs: 20,
      onActivity: (event) => events.push(event),
    });
    watcher.start();

    const filePath = path.join(runContextDir, toolActivityFileName("antigravity", runId));
    const fullLine = JSON.stringify({ ts: Date.now(), callId: "call_partial", tool: "insert_graph", status: "completed" });
    // Write the line split across two appends, without a trailing newline on the first
    // half, simulating a partial JSONL append the watcher observes mid-write.
    appendFileSync(filePath, fullLine.slice(0, 10), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events).toHaveLength(0);

    appendFileSync(filePath, `${fullLine.slice(10)}\n`, "utf8");
    await waitForEvents(1, events);
    await watcher.stop();

    expect(events[0]).toMatchObject({ callId: "call_partial", tool: "insert_graph", status: "completed" });
  });

  it("stop() deletes the per-run file but leaves the static file alone", async () => {
    const runContextDir = makeRunContextDir();
    const runId = "run_watch_4";
    const perRunPath = path.join(runContextDir, toolActivityFileName("antigravity", runId));
    const staticPath = path.join(runContextDir, toolActivityFileName("antigravity"));
    appendLine(runContextDir, toolActivityFileName("antigravity", runId), { callId: "call_1", tool: "insert_shape", status: "started" });
    appendLine(runContextDir, toolActivityFileName("antigravity"), { callId: "call_2", tool: "insert_shape", status: "started" });

    const watcher = new ToolActivityWatcher({ runContextDir, runId, pollIntervalMs: 20, onActivity: () => {} });
    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await watcher.stop();

    expect(existsSync(perRunPath)).toBe(false);
    expect(existsSync(staticPath)).toBe(true);
  });

  it("waits quietly (no crash, no events) while the files do not exist yet", async () => {
    const runContextDir = makeRunContextDir();
    mkdirSync(runContextDir, { recursive: true });
    const events: ToolActivityEvent[] = [];
    const watcher = new ToolActivityWatcher({
      runContextDir: path.join(runContextDir, "does-not-exist-yet"),
      runId: "run_watch_5",
      pollIntervalMs: 20,
      onActivity: (event) => events.push(event),
    });
    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expect(watcher.stop()).resolves.not.toThrow();
    expect(events).toHaveLength(0);
  });
});
