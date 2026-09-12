/**
 * Performance budget definition, parser and evaluator for `perf-probe`.
 *
 * 予算は `apps/desktop/perf-budget.json`。assert は **既定で有効**
 * (`SIGMA_PERF_REPORT_ONLY=1` で報告のみに落とせる)。
 *
 * パーサは意図的に厳格 (未知キーは throw): 予算ファイルの typo で門が黙って外れないように。
 * 既定値はフィクスチャ共通で、`fixtures.<name>` があればその上に重ねる。重い紙面に合わせた
 * 1 つの緩い予算を全部に当てると、軽い紙面の退行を見逃す。
 */
import type { PerfBudgetEvaluationSummary, PerfProbeReport, PerfStats } from "./perf-report";

export interface PerfBudget {
  idle: { reactRenders: number; recomputes: number; longTasks: number };
  typing: {
    inputDurationP50Ms: number;
    /** `processingEnd - processingStart`; the sub-16ms signal Event Timing's duration cannot give. */
    inputProcP50Ms: number;
    longTasksPerChar: number;
    /** Slowest typing position ÷ fastest, i.e. how much typing cost grows down the document. */
    pageScaleRatio: number;
  };
  enter: { keydownDurationMs: number; unchangedMathRemounts: number };
  arrow: { keydownDurationMs: number };
  scroll: { frameP90Ms: number };
  save: { rendererLongTasks: number; rendererMainThreadMs: number };
  pagination: { oscillations: number; idleRecomputes: number };
}

const BUDGET_SHAPE = {
  idle: ["reactRenders", "recomputes", "longTasks"],
  typing: ["inputDurationP50Ms", "inputProcP50Ms", "longTasksPerChar", "pageScaleRatio"],
  enter: ["keydownDurationMs", "unchangedMathRemounts"],
  arrow: ["keydownDurationMs"],
  scroll: ["frameP90Ms"],
  save: ["rendererLongTasks", "rendererMainThreadMs"],
  pagination: ["oscillations", "idleRecomputes"],
} as const satisfies Record<keyof PerfBudget, readonly string[]>;

/** フィクスチャ名 → 既定値からの差分。指定した指標だけ上書きする。 */
export type PerfBudgetOverrides = Record<string, PerfBudget>;

export interface PerfBudgetFile {
  defaults: PerfBudget;
  fixtures: PerfBudgetOverrides;
}

/**
 * 予算ファイル全体 (既定値 + フィクスチャ上書き) を読む。
 * `fixtures` は「指定した指標だけ」を差し替えるので、上書き側に全項目を書く必要はない。
 */
export function parsePerfBudgetFile(input: unknown): PerfBudgetFile {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("perf-budget: JSON オブジェクトではありません");
  }
  const source = input as Record<string, unknown>;
  const defaults = parsePerfBudget(source);

  const fixtures: PerfBudgetOverrides = {};
  const rawFixtures = source.fixtures;
  if (rawFixtures !== undefined) {
    if (typeof rawFixtures !== "object" || rawFixtures === null || Array.isArray(rawFixtures)) {
      throw new Error("perf-budget: \"fixtures\" がオブジェクトではありません");
    }
    for (const [name, override] of Object.entries(rawFixtures as Record<string, unknown>)) {
      fixtures[name] = mergePerfBudget(defaults, override, name);
    }
  }
  return { defaults, fixtures };
}

/** そのフィクスチャに適用される実効予算。 */
export function resolvePerfBudget(file: PerfBudgetFile, fixture: string): PerfBudget {
  return file.fixtures[fixture] ?? file.defaults;
}

function mergePerfBudget(defaults: PerfBudget, override: unknown, name: string): PerfBudget {
  if (typeof override !== "object" || override === null || Array.isArray(override)) {
    throw new Error(`perf-budget: fixtures.${name} がオブジェクトではありません`);
  }
  const merged = JSON.parse(JSON.stringify(defaults)) as Record<string, Record<string, number>>;
  for (const [section, metrics] of Object.entries(override as Record<string, unknown>)) {
    if (!Object.hasOwn(BUDGET_SHAPE, section)) {
      throw new Error(`perf-budget: fixtures.${name} の未知のセクション "${section}"`);
    }
    if (typeof metrics !== "object" || metrics === null || Array.isArray(metrics)) {
      throw new Error(`perf-budget: fixtures.${name}.${section} がオブジェクトではありません`);
    }
    const allowed = BUDGET_SHAPE[section as keyof typeof BUDGET_SHAPE] as readonly string[];
    for (const [metric, value] of Object.entries(metrics as Record<string, unknown>)) {
      if (!allowed.includes(metric)) {
        throw new Error(`perf-budget: fixtures.${name} の未知のキー "${section}.${metric}"`);
      }
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`perf-budget: fixtures.${name}."${section}.${metric}" が非負の数値ではありません`);
      }
      merged[section][metric] = value;
    }
  }
  return merged as unknown as PerfBudget;
}

export function parsePerfBudget(input: unknown): PerfBudget {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("perf-budget: JSON オブジェクトではありません");
  }
  const source = input as Record<string, unknown>;

  for (const key of Object.keys(source)) {
    // `_` 始まりは説明用 (`_notes`)。`fixtures` はフィクスチャ別の上書き。
    // それ以外の未知キーは弾く: 予算ファイルの typo で門が黙って外れないように。
    // `in` ではなく `Object.hasOwn`: `constructor` や `toString` がプロトタイプ経由で
    // 「既知のセクション」に見えてしまうのを防ぐ。
    if (key.startsWith("_") || key === "fixtures") {
      continue;
    }
    if (!Object.hasOwn(BUDGET_SHAPE, key)) {
      throw new Error(`perf-budget: 未知のセクション "${key}"`);
    }
  }

  const parsed: Record<string, Record<string, number>> = {};
  for (const [section, metrics] of Object.entries(BUDGET_SHAPE)) {
    const value = source[section];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`perf-budget: セクション "${section}" がありません`);
    }
    const sectionSource = value as Record<string, unknown>;
    for (const key of Object.keys(sectionSource)) {
      if (!(metrics as readonly string[]).includes(key)) {
        throw new Error(`perf-budget: 未知のキー "${section}.${key}"`);
      }
    }
    const sectionParsed: Record<string, number> = {};
    for (const metric of metrics) {
      const metricValue = sectionSource[metric];
      if (typeof metricValue !== "number" || !Number.isFinite(metricValue)) {
        throw new Error(`perf-budget: "${section}.${metric}" が数値ではありません`);
      }
      if (metricValue < 0) {
        throw new Error(`perf-budget: "${section}.${metric}" が負の値です`);
      }
      sectionParsed[metric] = metricValue;
    }
    parsed[section] = sectionParsed;
  }

  return parsed as unknown as PerfBudget;
}

export function evaluatePerfBudget(
  budget: PerfBudget,
  report: PerfProbeReport,
): PerfBudgetEvaluationSummary {
  const violations: PerfBudgetEvaluationSummary["violations"] = [];
  const skipped: PerfBudgetEvaluationSummary["skipped"] = [];

  const check = (metric: string, limit: number, actual: number | null, reason: string) => {
    if (actual === null) {
      skipped.push({ metric, reason });
      return;
    }
    if (actual > limit) {
      violations.push({ metric, budget: limit, actual });
    }
  };

  /**
   * Event Timing の duration 系の値。1 件も報告が無いのは欠測ではなく「送った入力がすべて
   * 16ms 未満だった」= 予算内、なので 0 として評価する。入力自体を送っていないときだけ
   * null を返して skip させる (壊れたセレクタで黙って合格しないための区別)。
   */
  const reportedDurationP50 = (stats: PerfStats | null, inputCount: number): number | null => {
    if (stats) {
      return stats.p50;
    }
    return inputCount > 0 ? 0 : null;
  };

  check("idle.reactRenders", budget.idle.reactRenders, report.idle.reactRenders, "");
  check("idle.recomputes", budget.idle.recomputes, report.idle.recomputes, "");
  check("idle.longTasks", budget.idle.longTasks, report.idle.longTasks, "");

  const typingNotRun = "typing フェーズが未計測";
  const typedChars = report.typing.reduce((sum, sample) => sum + sample.chars, 0);
  check(
    "typing.inputDurationP50Ms",
    budget.typing.inputDurationP50Ms,
    reportedDurationP50(maxStats(report.typing.map((sample) => sample.inputDuration), "p50"), typedChars),
    typingNotRun,
  );
  check(
    "typing.inputProcP50Ms",
    budget.typing.inputProcP50Ms,
    // processing 時間は「16ms 以上の遅いイベント」の中でしか観測できない。報告 0 件は
    // 「速かった」ではなく「分からない」なので、0 扱いで通してはいけない。
    maxOfStats(report.typing.map((sample) => sample.inputProcessing), "p50"),
    "16ms 以上の input イベントが無く processing 時間を観測できていない",
  );
  check(
    "typing.longTasksPerChar",
    budget.typing.longTasksPerChar,
    report.typing.length === 0
      ? null
      : Math.max(...report.typing.map((sample) => sample.longTasks / Math.max(1, sample.chars))),
    typingNotRun,
  );
  check(
    "typing.pageScaleRatio",
    budget.typing.pageScaleRatio,
    typingPageScaleRatio(report),
    "打鍵位置が1箇所以下、または 16ms 以上の input が無く processing 時間を観測できていない",
  );

  check(
    "enter.keydownDurationMs",
    budget.enter.keydownDurationMs,
    reportedDurationP50(report.enter.keydownDuration, report.enter.keystrokes),
    "enter フェーズが未計測",
  );
  check(
    "enter.unchangedMathRemounts",
    budget.enter.unchangedMathRemounts,
    report.enter.unchangedMathRemounts,
    "enter フェーズが未計測",
  );
  check(
    "arrow.keydownDurationMs",
    budget.arrow.keydownDurationMs,
    reportedDurationP50(report.arrow.keydownDuration, report.arrow.keystrokes),
    "arrow フェーズが未計測",
  );
  check("scroll.frameP90Ms", budget.scroll.frameP90Ms, report.scroll.frames?.p90 ?? null, "scroll フェーズが未計測");

  const saveNotRun = "save フェーズが未計測";
  check("save.rendererLongTasks", budget.save.rendererLongTasks, report.save?.rendererLongTasks ?? null, saveNotRun);
  check("save.rendererMainThreadMs", budget.save.rendererMainThreadMs, report.save?.rendererMainThreadMs ?? null, saveNotRun);

  check(
    "pagination.oscillations",
    budget.pagination.oscillations,
    // カウンタは WI-4 で実装済み。`countPerformanceEvent` は増えたときにだけキーを作り、
    // レポートの counterDelta は 0 の差分を落とすので、キーが無い = 一度も振動を検出して
    // いない、と読んでよい。
    report.idle.counterDelta["PageCanvasEditor.paginationOscillation"] ?? 0,
    "",
  );
  check(
    "pagination.idleRecomputes",
    budget.pagination.idleRecomputes,
    // 収束の判定は問題型フィクスチャの受入基準。本文型では idle.recomputes と同じ値になり
    // 1 つの退行を 2 度数えてしまうので評価しない。
    report.fixture === "problem" ? report.idle.recomputes : null,
    "ページ割り収束は問題型フィクスチャでのみ評価する",
  );

  return { fixture: report.fixture, violations, skipped };
}

function maxOfStats(samples: ReadonlyArray<PerfStats | null>, key: keyof PerfStats): number | null {
  const values = samples.filter((stats): stats is PerfStats => stats !== null).map((stats) => stats[key]);
  return values.length === 0 ? null : Math.max(...values);
}

/** 最遅の打鍵位置を代表値にする (平均だと 1 箇所だけ遅い文書が隠れる)。 */
function maxStats(samples: ReadonlyArray<PerfStats | null>, key: keyof PerfStats): PerfStats | null {
  const present = samples.filter((stats): stats is PerfStats => stats !== null);
  if (present.length === 0) {
    return null;
  }
  return present.reduce((slowest, stats) => (stats[key] > slowest[key] ? stats : slowest));
}

/**
 * 文書の下へ行くほど打鍵が重くなっていないか。
 *
 * **duration ではなく processing を使う。** Event Timing の `duration` は 8ms 刻みに
 * 量子化されるので、比を取ると「16 と 24」= ちょうど 1.5 のような、実際の重さではなく
 * 量子化の段差を読んだ値しか出ない (実測でも本文型・問題型がそろって 1.50 になる)。
 * `processingEnd - processingStart` は量子化されないので、位置による差が素直に出る。
 */
function typingPageScaleRatio(report: PerfProbeReport): number | null {
  const p50s = report.typing
    .map((sample) => sample.inputProcessing?.p50 ?? null)
    .filter((value): value is number => value !== null && value > 0);
  if (p50s.length < 2) {
    return null;
  }
  return Math.round((Math.max(...p50s) / Math.min(...p50s)) * 100) / 100;
}
