import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

export const UNATTRIBUTED_MCP_RUN_ID = "__unattributed__";

export type McpStatsCounterName =
  | "documentDiskLoads"
  | "documentParses"
  | "previewBridgeRenders"
  | "previewCacheHits"
  | "previewCacheMisses"
  | "documentCacheHits"
  | "documentCacheMisses";

export interface McpToolTimingStats {
  callCount: number;
  totalDurationMs: number;
  maxDurationMs: number;
}

export interface McpStatsCounters {
  documentDiskLoads: number;
  documentParses: number;
  previewBridgeRenders: number;
  previewCacheHits: number;
  previewCacheMisses: number;
  documentCacheHits: number;
  documentCacheMisses: number;
}

export interface McpRunStats {
  runId: string;
  tools: Record<string, McpToolTimingStats>;
  counters: McpStatsCounters;
}

const EMPTY_COUNTERS: McpStatsCounters = {
  documentDiskLoads: 0,
  documentParses: 0,
  previewBridgeRenders: 0,
  previewCacheHits: 0,
  previewCacheMisses: 0,
  documentCacheHits: 0,
  documentCacheMisses: 0,
};

const RUN_STATS_LIMIT = 50;
const runStats = new Map<string, McpRunStats>();
const activeRun = new AsyncLocalStorage<string>();

function normalizeRunId(runId?: string): string {
  return runId?.trim() || UNATTRIBUTED_MCP_RUN_ID;
}

function ensureRunStats(runId: string): McpRunStats {
  const existing = runStats.get(runId);
  if (existing) {
    runStats.delete(runId);
    runStats.set(runId, existing);
    return existing;
  }
  const created: McpRunStats = {
    runId,
    tools: {},
    counters: { ...EMPTY_COUNTERS },
  };
  runStats.set(runId, created);
  while (runStats.size > RUN_STATS_LIMIT) {
    const oldestRunId = runStats.keys().next().value as string | undefined;
    if (oldestRunId === undefined) {
      break;
    }
    runStats.delete(oldestRunId);
  }
  return created;
}

function cloneRunStats(stats: McpRunStats): McpRunStats {
  return {
    runId: stats.runId,
    tools: Object.fromEntries(
      Object.entries(stats.tools).map(([name, timing]) => [name, { ...timing }]),
    ),
    counters: { ...stats.counters },
  };
}

export function incrementMcpStatsCounter(counter: McpStatsCounterName): void {
  const stats = ensureRunStats(activeRun.getStore() ?? UNATTRIBUTED_MCP_RUN_ID);
  stats.counters[counter] += 1;
}

export async function runWithMcpToolStats<T>(
  toolName: string,
  runId: string | undefined,
  callback: () => Promise<T>,
): Promise<T> {
  const normalizedRunId = normalizeRunId(runId);
  const start = performance.now();
  try {
    return await activeRun.run(normalizedRunId, callback);
  } finally {
    const durationMs = performance.now() - start;
    const stats = ensureRunStats(normalizedRunId);
    const timing = stats.tools[toolName] ?? { callCount: 0, totalDurationMs: 0, maxDurationMs: 0 };
    timing.callCount += 1;
    timing.totalDurationMs += durationMs;
    timing.maxDurationMs = Math.max(timing.maxDurationMs, durationMs);
    stats.tools[toolName] = timing;
  }
}

/** Internal process-local metrics accessor used by focused MCP tests and diagnostics. */
export function getMcpRunStats(runId?: string): McpRunStats {
  const normalizedRunId = normalizeRunId(runId);
  return cloneRunStats(runStats.get(normalizedRunId) ?? {
    runId: normalizedRunId,
    tools: {},
    counters: { ...EMPTY_COUNTERS },
  });
}

/** Returns every run bucket without exposing the mutable registry itself. */
export function getAllMcpRunStats(): McpRunStats[] {
  return Array.from(runStats.values(), cloneRunStats);
}

export function resetMcpRunStats(): void {
  runStats.clear();
}
