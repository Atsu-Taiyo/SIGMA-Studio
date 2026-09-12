import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  evaluatePerfBudget,
  parsePerfBudget,
  parsePerfBudgetFile,
  resolvePerfBudget,
  type PerfBudget,
} from "./e2e/perf-budget";
import {
  computePerfStats,
  renderPerfSummaryMarkdown,
  type PerfProbeReport,
} from "./e2e/perf-report";

function readRepositoryBudget(): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL("../perf-budget.json", import.meta.url)), "utf8"));
}

function validBudget(): PerfBudget {
  return parsePerfBudget(readRepositoryBudget());
}

function sampleReport(overrides: Partial<PerfProbeReport> = {}): PerfProbeReport {
  return {
    label: "body",
    fixture: "body",
    generatedAt: "2026-08-17T00:00:00.000Z",
    viewport: { width: 1600, height: 1000 },
    // `counters: {}` は「計測したが何も出なかった」の明示。省略可能にすると未計測が 0 に化ける。
    open: {
      counters: {},
      msToBlocks: 1200,
      msToSettled: 2400,
      domNodes: 50_000,
      mathNodes: 1200,
      pageSheets: 30,
      heapMB: 240,
    },
    idle: {
      durationMs: 3000,
      reactRenders: 0,
      recomputes: 0,
      longTasks: 0,
      longTaskMs: 0,
      counterDelta: {},
      frames: null,
    },
    typing: [
      {
        position: 0.05,
        blockIndex: 75,
        chars: 8,
        inputDuration: computePerfStats([8, 10, 12]),
        inputProcessing: computePerfStats([2, 3, 4]),
        keydownDuration: computePerfStats([8, 9, 10]),
        longTasks: 0,
        longTaskMs: 0,
        counterDelta: {},
        reactRenders: 4,
        recompute: { count: 8, totalMs: 40, maxMs: 6, meanMs: 5 },
        measureFlowBlocks: { count: 8, totalMs: 24, maxMs: 4, meanMs: 3 },
      },
    ],
    burst: { wallMs: 400, msPerChar: 20, settled: true, longTasks: 0, longTaskMs: 0, counterDelta: {} },
    enter: {
      keystrokes: 4,
      keydownDuration: computePerfStats([20, 24, 30]),
      longTasks: 0,
      longTaskMs: 0,
      counterDelta: {},
      reactRenders: 12,
      unchangedMathRemounts: null,
    },
    arrow: {
      keystrokes: 15,
      keydownDuration: computePerfStats([4, 6, 8]),
      longTasks: 0,
      longTaskMs: 0,
      counterDelta: {},
      reactRenders: 0,
      unchangedMathRemounts: null,
    },
    scroll: { frames: computePerfStats([12, 14, 16]), framesOver50: 0, longTasks: 0, longTaskMs: 0, counterDelta: {} },
    save: null,
    consoleErrors: [],
    ...overrides,
  };
}

describe("parsePerfBudget", () => {
  it("accepts the budget file committed in the repository", () => {
    const budget = validBudget();
    expect(budget.idle.longTasks).toBe(0);
    expect(budget.typing.inputDurationP50Ms).toBeGreaterThan(0);
  });

  it("rejects a budget with a missing key", () => {
    const budget = readRepositoryBudget() as Record<string, Record<string, number>>;
    delete budget.idle.longTasks;
    expect(() => parsePerfBudget(budget)).toThrow(/idle\.longTasks/);
  });

  it("rejects a budget with a missing section", () => {
    const budget = readRepositoryBudget() as Record<string, unknown>;
    delete budget.scroll;
    expect(() => parsePerfBudget(budget)).toThrow(/scroll/);
  });

  it("rejects a non-numeric value", () => {
    const budget = readRepositoryBudget() as Record<string, Record<string, unknown>>;
    budget.arrow.keydownDurationMs = "16";
    expect(() => parsePerfBudget(budget)).toThrow(/arrow\.keydownDurationMs/);
  });

  it("rejects a negative value", () => {
    const budget = readRepositoryBudget() as Record<string, Record<string, unknown>>;
    budget.scroll.frameP90Ms = -1;
    expect(() => parsePerfBudget(budget)).toThrow(/scroll\.frameP90Ms/);
  });

  it("rejects an unknown key so typos cannot silently disable a budget", () => {
    const budget = readRepositoryBudget() as Record<string, Record<string, unknown>>;
    budget.scroll.frameP99Ms = 30;
    expect(() => parsePerfBudget(budget)).toThrow(/scroll\.frameP99Ms/);
  });

  it("rejects a non-object input", () => {
    expect(() => parsePerfBudget(null)).toThrow();
    expect(() => parsePerfBudget([])).toThrow();
  });
});

describe("computePerfStats", () => {
  it("returns null for an empty sample", () => {
    expect(computePerfStats([])).toBeNull();
  });

  it("reports nearest-rank percentiles from the sorted sample", () => {
    const stats = computePerfStats([30, 10, 20, 40, 50, 60, 70, 80, 90, 100]);
    expect(stats).toEqual({ n: 10, min: 10, p50: 50, p90: 90, max: 100, mean: 55 });
  });

  it("does not bias p50 upwards on an 8-sample keystroke run", () => {
    expect(computePerfStats([1, 2, 3, 4, 5, 6, 7, 8])?.p50).toBe(4);
  });
});

describe("evaluatePerfBudget", () => {
  it("reports no violations for a report inside every budget", () => {
    const result = evaluatePerfBudget(validBudget(), sampleReport());
    expect(result.violations).toEqual([]);
  });

  it("flags idle React renders", () => {
    const result = evaluatePerfBudget(validBudget(), sampleReport({
      idle: {
        durationMs: 3000,
        reactRenders: 91,
        recomputes: 3,
        longTasks: 2,
        longTaskMs: 140,
        counterDelta: { "PageCanvasEditor.render": 91 },
        frames: null,
      },
    }));
    expect(result.violations.map((violation) => violation.metric)).toEqual([
      "idle.reactRenders",
      "idle.recomputes",
      "idle.longTasks",
    ]);
    expect(result.violations[0]).toMatchObject({ budget: 0, actual: 91 });
  });

  it("evaluates pagination convergence on the problem fixture only", () => {
    const idle = {
      durationMs: 3000,
      reactRenders: 0,
      recomputes: 2,
      longTasks: 0,
      longTaskMs: 0,
      counterDelta: {},
      frames: null,
    };
    const body = evaluatePerfBudget(validBudget(), sampleReport({ idle }));
    expect(body.violations.map((violation) => violation.metric)).not.toContain("pagination.idleRecomputes");
    expect(body.skipped.map((skip) => skip.metric)).toContain("pagination.idleRecomputes");

    const problem = evaluatePerfBudget(validBudget(), sampleReport({ fixture: "problem", label: "problem", idle }));
    expect(problem.violations.map((violation) => violation.metric)).toContain("pagination.idleRecomputes");
  });

  it("treats unreported Event Timing durations as under the 16ms floor, not as unknown", () => {
    const report = sampleReport();
    const result = evaluatePerfBudget(validBudget(), {
      ...report,
      typing: report.typing.map((sample) => ({ ...sample, inputDuration: null, inputProcessing: null })),
      enter: { ...report.enter, keydownDuration: null },
      arrow: { ...report.arrow, keydownDuration: null },
    });
    const skippedMetrics = result.skipped.map((skip) => skip.metric);
    expect(result.violations).toEqual([]);
    expect(skippedMetrics).not.toContain("typing.inputDurationP50Ms");
    expect(skippedMetrics).not.toContain("enter.keydownDurationMs");
    expect(skippedMetrics).not.toContain("arrow.keydownDurationMs");
    // processing 時間だけは「速かった」と読めない (16ms 未満のイベントは届かないので不明)。
    expect(skippedMetrics).toContain("typing.inputProcP50Ms");
  });

  it("skips a key phase that sent no keystrokes instead of passing it", () => {
    const report = sampleReport();
    const result = evaluatePerfBudget(validBudget(), {
      ...report,
      typing: [],
      enter: { ...report.enter, keystrokes: 0, keydownDuration: null },
      arrow: { ...report.arrow, keystrokes: 0, keydownDuration: null },
    });
    const skippedMetrics = result.skipped.map((skip) => skip.metric);
    expect(skippedMetrics).toContain("typing.inputDurationP50Ms");
    expect(skippedMetrics).toContain("enter.keydownDurationMs");
    expect(skippedMetrics).toContain("arrow.keydownDurationMs");
  });

  it("reads a missing oscillation counter as zero oscillations", () => {
    // counterDelta は 0 の差分を落とすので、キーが無いのは「検出しなかった」を意味する。
    const result = evaluatePerfBudget(validBudget(), sampleReport());
    expect(result.violations.map((violation) => violation.metric)).not.toContain("pagination.oscillations");
    expect(result.skipped.map((skip) => skip.metric)).not.toContain("pagination.oscillations");
  });

  it("flags the slowest typing position rather than the average", () => {
    const report = sampleReport();
    const result = evaluatePerfBudget(validBudget(), {
      ...report,
      typing: [
        report.typing[0],
        { ...report.typing[0], position: 0.95, inputDuration: computePerfStats([120, 140, 160]) },
      ],
    });
    expect(result.violations.map((violation) => violation.metric)).toContain("typing.inputDurationP50Ms");
  });

  it("skips budgets whose metric was not measured instead of passing them", () => {
    const result = evaluatePerfBudget(validBudget(), sampleReport());
    expect(result.skipped.map((skip) => skip.metric)).toEqual([
      "typing.pageScaleRatio",
      "enter.unchangedMathRemounts",
      "save.rendererLongTasks",
      "save.rendererMainThreadMs",
      "pagination.idleRecomputes",
    ]);
  });

  it("counts a pagination oscillation reported by the app counter", () => {
    const result = evaluatePerfBudget(validBudget(), sampleReport({
      idle: {
        durationMs: 3000,
        reactRenders: 0,
        recomputes: 0,
        longTasks: 0,
        longTaskMs: 0,
        counterDelta: { "PageCanvasEditor.paginationOscillation": 2 },
        frames: null,
      },
    }));
    expect(result.violations.map((violation) => violation.metric)).toEqual(["pagination.oscillations"]);
  });
});

describe("perf-probe spec gating", () => {
  it("skips itself unless SIGMA_PERF_PROBE=1 so `npm run test:e2e` stays fast", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./e2e/perf-probe.spec.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toMatch(/test\.skip\(\s*process\.env\.SIGMA_PERF_PROBE !== "1"/);
  });

  it("説明用の `_notes` は受理し、未知セクションは弾く", () => {
    const budget = JSON.parse(readFileSync(
      fileURLToPath(new URL("../perf-budget.json", import.meta.url)),
      "utf8",
    )) as Record<string, unknown>;

    expect(() => parsePerfBudgetFile(budget)).not.toThrow();
    expect(() => parsePerfBudgetFile({ ...budget, typinng: {} })).toThrow(/未知のセクション/);
    // プロトタイプ経由で「既知」に見えるキーも弾く。
    expect(() => parsePerfBudgetFile({ ...budget, constructor: {} })).toThrow(/未知のセクション/);
  });

  it("フィクスチャ別の上書きは指定した指標だけ差し替える", () => {
    const budget = JSON.parse(readFileSync(
      fileURLToPath(new URL("../perf-budget.json", import.meta.url)),
      "utf8",
    )) as Record<string, unknown>;
    const file = parsePerfBudgetFile(budget);

    const problem = resolvePerfBudget(file, "problem");
    const body = resolvePerfBudget(file, "body");

    // 問題型は打鍵コストの水準が違うので上書きする。
    expect(problem.typing.inputProcP50Ms).toBeGreaterThan(body.typing.inputProcP50Ms);
    // 上書きしていない指標は既定値のまま。
    expect(problem.scroll.frameP90Ms).toBe(body.scroll.frameP90Ms);
    // 未知のフィクスチャは既定値。
    expect(resolvePerfBudget(file, "nope")).toEqual(file.defaults);
    // 上書き側の typo も弾く。
    expect(() => parsePerfBudgetFile({ ...budget, fixtures: { problem: { typing: { nope: 1 } } } }))
      .toThrow(/未知のキー/);
  });

  it("ランナーの既知フィクスチャ一覧が spec と一致する", () => {
    // ここがずれると、打ち間違えでない正しい名前が「未知」で弾かれるか、
    // 逆に spec 側にしか無い名前が素通りして「4 件 skip で緑」に戻る。
    const runner = readFileSync(
      fileURLToPath(new URL("../scripts/perf-probe.mjs", import.meta.url)),
      "utf8",
    );
    const spec = readFileSync(
      fileURLToPath(new URL("./e2e/perf-probe.spec.ts", import.meta.url)),
      "utf8",
    );
    const runnerList = /const KNOWN_FIXTURES = \[([^\]]*)\]/.exec(runner)?.[1] ?? "";
    const runnerNames = [...runnerList.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    const specNames = [...spec.matchAll(/name: `?"?([a-z0-9-]+)\$?/g)]
      .map((match) => match[1])
      .filter((name) => name === "body" || name === "problem");
    const scaled = /BODY_SCALE_PARAGRAPHS = \[([^\]]*)\]/.exec(spec)?.[1] ?? "";
    const scaledNames = [...scaled.matchAll(/(\d+)/g)].map((match) => `body-${match[1]}`);

    expect(runnerNames).toEqual([...scaledNames, ...specNames]);
  });

  it("未知のフィクスチャ名でランナーが落ちる", () => {
    // playwright は「全部 skip」で exit 0 を返すので、名前の検証が無いと
    // `--fixture bdoy` が「何も測っていないのに緑」になる。
    const runner = readFileSync(
      fileURLToPath(new URL("../scripts/perf-probe.mjs", import.meta.url)),
      "utf8",
    );
    expect(runner).toContain("未知のフィクスチャ");
    expect(runner).toContain("process.exit(2)");
    // 計測が 1 件も無いまま 0 で終わらないこと。
    expect(runner).toContain("計測結果がありません");
  });

  it("予算の assert は既定で有効で、明示したときだけ外れる", () => {
    // WI-17 で「報告するだけ」から「既定で門」に変えた。opt-in のままだと、
    // 誰も `SIGMA_PERF_ENFORCE=1` を付けないまま値が悪化していく。
    const source = readFileSync(
      fileURLToPath(new URL("./e2e/perf-probe.spec.ts", import.meta.url)),
      "utf8",
    );
    expect(source).toContain('process.env.SIGMA_PERF_REPORT_ONLY !== "1"');
    expect(source).toContain('process.env.SIGMA_PERF_ENFORCE !== "0"');
    // 既定を opt-in に戻す書き方が復活していないこと。
    expect(source).not.toContain('SIGMA_PERF_ENFORCE === "1"');
  });
});

describe("renderPerfSummaryMarkdown", () => {
  it("renders one section per fixture with the headline numbers", () => {
    const markdown = renderPerfSummaryMarkdown([sampleReport(), sampleReport({ label: "problem", fixture: "problem" })]);
    expect(markdown).toContain("# perf-probe");
    expect(markdown).toContain("## body");
    expect(markdown).toContain("## problem");
    expect(markdown).toContain("idle");
    expect(markdown).toContain("typing");
  });

  it("marks budget violations when they were evaluated", () => {
    const markdown = renderPerfSummaryMarkdown(
      [sampleReport()],
      [{
        fixture: "body",
        violations: [{ metric: "idle.longTasks", budget: 0, actual: 2 }],
        skipped: [],
      }],
    );
    expect(markdown).toContain("idle.longTasks");
    expect(markdown).toContain("2");
  });
});
