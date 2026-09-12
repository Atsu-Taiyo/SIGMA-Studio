import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getLedgerLogPath, LEDGER_LOG_ROTATE_BYTES, logLedgerEvent } from "./ledger-log";

function readLines(raw: string): unknown[] {
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

describe("logLedgerEvent", () => {
  let dataDir: string;
  let originalMcpProvider: string | undefined;
  let originalWarn: typeof console.warn;
  let warnCalls: string[];

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-ledger-log-"));
    originalMcpProvider = process.env.SIGMA_STUDIO_MCP_PROVIDER;
    delete process.env.SIGMA_STUDIO_MCP_PROVIDER;
    warnCalls = [];
    originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args.map((value) => String(value)).join(" "));
    };
  });

  afterEach(async () => {
    console.warn = originalWarn;
    if (originalMcpProvider === undefined) {
      delete process.env.SIGMA_STUDIO_MCP_PROVIDER;
    } else {
      process.env.SIGMA_STUDIO_MCP_PROVIDER = originalMcpProvider;
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it("appends a line with the expected shape and warns to console", () => {
    logLedgerEvent(dataDir, "ledger-row-repaired", { fileId: "abc123" });

    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain("[sigma:ledger]");
    expect(warnCalls[0]).toContain("ledger-row-repaired");

    const logPath = getLedgerLogPath(dataDir);
    expect(logPath).toBe(path.join(dataDir, "logs", "ledger.log"));
  });

  it("writes a JSON line to <dataDir>/logs/ledger.log with role=main by default", async () => {
    logLedgerEvent(dataDir, "ledger-lock-waited", { pid: 123 });

    const logPath = getLedgerLogPath(dataDir);
    const raw = await fs.readFile(logPath, "utf8");
    const lines = readLines(raw) as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      role: "main",
      event: "ledger-lock-waited",
      pid: 123,
    });
    expect(typeof lines[0].ts).toBe("string");
  });

  it("flips role to mcp when SIGMA_STUDIO_MCP_PROVIDER is set", async () => {
    process.env.SIGMA_STUDIO_MCP_PROVIDER = "claude";
    logLedgerEvent(dataDir, "orphan-documents-adopted");

    const logPath = getLedgerLogPath(dataDir);
    const raw = await fs.readFile(logPath, "utf8");
    const lines = readLines(raw) as Array<Record<string, unknown>>;
    expect(lines[0]).toMatchObject({ role: "mcp", event: "orphan-documents-adopted" });
  });

  it("rotates ledger.log to ledger.log.1 once it exceeds the size threshold", async () => {
    const logPath = getLedgerLogPath(dataDir);
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    const filler = "x".repeat(LEDGER_LOG_ROTATE_BYTES + 1024);
    await fs.writeFile(logPath, filler, "utf8");

    logLedgerEvent(dataDir, "ledger-lock-broken", { lockId: "abc" });

    const rotatedPath = `${logPath}.1`;
    const rotatedRaw = await fs.readFile(rotatedPath, "utf8");
    expect(rotatedRaw).toBe(filler);

    const newRaw = await fs.readFile(logPath, "utf8");
    const lines = readLines(newRaw) as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "ledger-lock-broken" });
  });

  it("does not throw when the logs directory cannot be created", () => {
    // logs という「ディレクトリ」の代わりにファイルを置いておくことで、
    // 権限に関係なく mkdir が確実に失敗する状況を再現する。
    return fs
      .writeFile(path.join(dataDir, "logs"), "not a directory", "utf8")
      .then(() => {
        expect(() => logLedgerEvent(dataDir, "ledger-corrupt-preserved")).not.toThrow();
      });
  });
});
