/**
 * Report shape and markdown rendering for `perf-probe`.
 *
 * Kept out of the spec file (and out of `scripts/`) on purpose: the probe itself can only be
 * verified by running a browser, so everything that can be a pure function lives here where vitest
 * can hold it still (`tests/perf-harness.test.ts`).
 */

export interface PerfStats {
  n: number;
  min: number;
  p50: number;
  p90: number;
  max: number;
  mean: number;
}

export interface PerfMeasureStats {
  count: number;
  totalMs: number;
  maxMs: number;
  meanMs: number;
}

export interface PerfOpenPhase {
  /**
   * 開く間に積み上がったカウンタ (初回ページ割りのパス数などの内訳)。
   *
   * 他フェーズの `counterDelta` と違い **差分ではなく `goto` からの累計**。
   * `measureOpen` がナビゲーション自体を持っているので値は一致するが、
   * 名前で差分だと誤解して他フェーズと引き算されないよう別名にしてある。
   * 省略可能にしない: 「計測していない」が「0 で良好」に化けないようにする。
   */
  counters: Record<string, number>;
  /** Wall clock from `goto` until every expected block is in the DOM. */
  msToBlocks: number;
  /** Wall clock until the app stopped emitting new measures (layout settled). */
  msToSettled: number;
  domNodes: number;
  mathNodes: number;
  pageSheets: number;
  /** マウント中の本文エディタ数。可視範囲に閉じられているほど小さい。 */
  editors?: number;
  /** `performance.memory` is Chromium-only and GC dependent — reference value, never a budget. */
  heapMB: number | null;
}

export interface PerfIdlePhase {
  durationMs: number;
  reactRenders: number;
  recomputes: number;
  longTasks: number;
  longTaskMs: number;
  counterDelta: Record<string, number>;
  frames: PerfStats | null;
}

export interface PerfTypingSample {
  /** Relative position in the document (0 = first block, 1 = last block). */
  position: number;
  blockIndex: number;
  chars: number;
  /**
   * Event Timing は duration が 16ms 未満のイベントを**そもそも報告しない**ので、
   * `n` が `chars` に満たないのは欠測ではなく「その打鍵は 16ms 未満だった」という意味になる。
   * `inputProcessing` (processingEnd - processingStart) は報告されたイベントの中では細かい信号だが、
   * 同じ 16ms のふるいを通った後の値なので「速い打鍵の処理時間」は含まれない (生存者バイアス)。
   * 予算側はこれを踏まえ、duration 系は「報告 0 件 = 全打鍵が 16ms 未満」として通し、
   * processing 系は「報告 0 件 = 不明」としてスキップする (perf-budget.ts)。
   */
  inputDuration: PerfStats | null;
  inputProcessing: PerfStats | null;
  keydownDuration: PerfStats | null;
  longTasks: number;
  longTaskMs: number;
  counterDelta: Record<string, number>;
  reactRenders: number;
  /** `PageCanvasEditor.recompute` の実測。1 回が 1 フレームを超えると打鍵が詰まる。 */
  recompute: PerfMeasureStats | null;
  /** recompute の内訳のうち本文の採寸ぶん (範囲限定は WI-11 の担当)。 */
  measureFlowBlocks: PerfMeasureStats | null;
}

export interface PerfKeyPhase {
  /** 送ったキー入力の数。`keydownDuration` が null のとき「速すぎて未報告」と「未実行」を分ける。 */
  keystrokes: number;
  keydownDuration: PerfStats | null;
  longTasks: number;
  longTaskMs: number;
  counterDelta: Record<string, number>;
  reactRenders: number;
  /**
   * Math node views remounted for blocks the keystroke did not change. Not observable yet (the
   * math node view has no mount counter), so it stays `null` and its budget is reported skipped
   * instead of silently passing.
   */
  unchangedMathRemounts: number | null;
}

export interface PerfBurstPhase {
  wallMs: number;
  msPerChar: number;
  /** 20 文字分の更新を観測できたか。false なら `wallMs` は待ち timeout を含む参考値。 */
  settled: boolean;
  longTasks: number;
  longTaskMs: number;
  counterDelta: Record<string, number>;
}

export interface PerfScrollPhase {
  frames: PerfStats | null;
  framesOver50: number;
  longTasks: number;
  longTaskMs: number;
  counterDelta: Record<string, number>;
}

export interface PerfSavePhase {
  rendererLongTasks: number;
  rendererMainThreadMs: number;
  counterDelta: Record<string, number>;
}

export interface PerfProbeReport {
  label: string;
  fixture: string;
  generatedAt: string;
  viewport: { width: number; height: number };
  open: PerfOpenPhase;
  idle: PerfIdlePhase;
  typing: PerfTypingSample[];
  burst: PerfBurstPhase;
  enter: PerfKeyPhase;
  arrow: PerfKeyPhase;
  scroll: PerfScrollPhase;
  /** Measured from WI-14 onwards; `null` until the save path is instrumented. */
  save: PerfSavePhase | null;
  consoleErrors: string[];
}

export interface PerfBudgetEvaluationSummary {
  fixture: string;
  violations: Array<{ metric: string; budget: number; actual: number }>;
  skipped: Array<{ metric: string; reason: string }>;
}

export function computePerfStats(values: readonly number[]): PerfStats | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  // nearest-rank: `Math.floor(ratio * n)` だと n=8 のとき p50 が 5 番目 (= 62.5 パーセンタイル)
  // になり、打鍵 8 回の p50 予算が一貫して高めの値と比較されてしまう。
  const quantile = (ratio: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1))];
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    n: sorted.length,
    min: round1(sorted[0]),
    p50: round1(quantile(0.5)),
    p90: round1(quantile(0.9)),
    max: round1(sorted[sorted.length - 1]),
    mean: round1(total / sorted.length),
  };
}

/** 打鍵 1 文字あたりのカウンタ値。計測ビルドでないと欠測になるので `-` を返す。 */
function perChar(total: number | undefined, chars: number): string {
  return total === undefined ? "-" : String(round1(total / Math.max(1, chars)));
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Counters whose name ends in `.render` are React renders by convention (`src/lib/performance.ts`). */
export function sumRenderCounters(counterDelta: Record<string, number>): number {
  return Object.entries(counterDelta)
    .filter(([name]) => name.endsWith(".render"))
    .reduce((sum, [, value]) => sum + value, 0);
}

export function sumRecomputeCounters(counterDelta: Record<string, number>): number {
  return (counterDelta["PageCanvasEditor.syncRecompute"] ?? 0)
    + (counterDelta["PageCanvasEditor.deferredRecompute"] ?? 0);
}

export function renderPerfSummaryMarkdown(
  reports: readonly PerfProbeReport[],
  evaluations: readonly PerfBudgetEvaluationSummary[] = [],
): string {
  const lines: string[] = ["# perf-probe", ""];
  if (reports.length === 0) {
    lines.push("(レポートがありません)", "");
    return lines.join("\n");
  }
  lines.push(`計測: ${reports[0].generatedAt}`, "");

  for (const report of reports) {
    lines.push(`## ${report.label}`, "");
    lines.push("| phase | metric | value |", "| --- | --- | --- |");
    lines.push(row("open", "ms to blocks", report.open.msToBlocks));
    lines.push(row("open", "ms to settled", report.open.msToSettled));
    lines.push(row("open", "DOM nodes", report.open.domNodes));
    lines.push(row("open", "math nodes", report.open.mathNodes));
    lines.push(row("open", "mounted editors", report.open.editors ?? "-"));
    lines.push(row("open", "heap MB", report.open.heapMB ?? "-"));
    lines.push(row("idle 3s", "React renders", report.idle.reactRenders));
    lines.push(row("idle 3s", "recomputes", report.idle.recomputes));
    lines.push(row("idle 3s", "long tasks", `${report.idle.longTasks} (${round1(report.idle.longTaskMs)}ms)`));
    for (const sample of report.typing) {
      const at = `typing @${Math.round(sample.position * 100)}%`;
      lines.push(row(at, "input.duration p50 / max", formatStats(sample.inputDuration)));
      lines.push(row(at, "input.processing p50 / max", formatStats(sample.inputProcessing)));
      lines.push(row(at, "long tasks / char", round1(sample.longTasks / Math.max(1, sample.chars))));
      lines.push(row(at, "React renders / char", round1(sample.reactRenders / Math.max(1, sample.chars))));
      lines.push(row(at, "└ EditorShell / TextFlowEditor renders per char", [
        perChar(sample.counterDelta["EditorShell.render"], sample.chars),
        perChar(sample.counterDelta["TextFlowEditor.render"], sample.chars),
      ].join(" / ")));
      lines.push(row(at, "decoration refresh dispatches / char", perChar(sample.counterDelta["TextFlowEditor.refreshDispatch"], sample.chars)));
      // 装飾プラグインが文書を丸ごと歩いた回数。inline まで降りる走査 (full) が打鍵ごとに走ると
      // 打鍵コストが文書の長さに比例する。block は textblock で止まる構造だけの走査 (桁が違う)。
      // 数式は静的 DOM なので、打鍵で触られた回数がそのまま無駄仕事の量になる。
      lines.push(row(at, "math node view DOM writes / char", perChar(sample.counterDelta["InlineMathNodeView.rerender"], sample.chars)));
      lines.push(row(at, "decoration walks / char (full / block / init)", [
        perChar(sample.counterDelta["PmDecorations.fullWalk"], sample.chars),
        perChar(sample.counterDelta["PmDecorations.blockWalk"], sample.chars),
        perChar(sample.counterDelta["PmDecorations.initWalk"], sample.chars),
      ].join(" / ")));
      lines.push(row(at, "recompute count / max / mean ms", formatMeasure(sample.recompute)));
      lines.push(row(at, "└ measureFlowBlocks max / mean ms", formatMeasure(sample.measureFlowBlocks)));
      // 実測の範囲: 全ブロック / 打った場所以降 / 持ち越しのみ。打鍵で all が出るなら、
      // 何かが「紙面全体が変わった」と申告している (増分計測が効いていない)。
      lines.push(row(at, "└ measure all / fromUnit / dirtyUnit / carry", [
        sample.counterDelta["PageCanvasEditor.measure.all"] ?? 0,
        sample.counterDelta["PageCanvasEditor.measure.fromUnit"] ?? 0,
        sample.counterDelta["PageCanvasEditor.measure.dirtyUnit"] ?? 0,
        sample.counterDelta["PageCanvasEditor.measure.carry"] ?? 0,
      ].join(" / ")));
    }
    lines.push(row("burst 20 chars", "ms / char", report.burst.settled ? report.burst.msPerChar : `${report.burst.msPerChar} (未収束)`));
    lines.push(row("burst 20 chars", "long tasks", report.burst.longTasks));
    lines.push(row("enter x4", "keydown p50 / max", formatStats(report.enter.keydownDuration)));
    lines.push(row("enter x4", "long tasks", `${report.enter.longTasks} (${round1(report.enter.longTaskMs)}ms)`));
    // 構造が変わったときに本文ユニットが作り直されると、その中の数式ノードビューが
    // 全部アンマウント → 再マウントされる。ここが 0 に近いほど「変更したユニットだけ」で済んでいる。
    lines.push(row("enter x4", "inline math remounts", report.enter.counterDelta["InlineMathNodeView.mount"] ?? "-"));
    lines.push(row("enter x4", "TextFlowEditor renders", report.enter.counterDelta["TextFlowEditor.render"] ?? "-"));
    lines.push(row("enter x4", "math node view DOM writes", report.enter.counterDelta["InlineMathNodeView.rerender"] ?? 0));
    lines.push(row("enter x4", "decoration walks (full / block / init)", [
      report.enter.counterDelta["PmDecorations.fullWalk"] ?? 0,
      report.enter.counterDelta["PmDecorations.blockWalk"] ?? 0,
      report.enter.counterDelta["PmDecorations.initWalk"] ?? 0,
    ].join(" / ")));
    lines.push(row("arrow", "keydown p50 / max", formatStats(report.arrow.keydownDuration)));
    // 選択が動いただけで装飾が全文を歩き直していないか (走査は文書が変わったときだけでよい)。
    lines.push(row("arrow", "decoration walks (full / block / init)", [
      report.arrow.counterDelta["PmDecorations.fullWalk"] ?? 0,
      report.arrow.counterDelta["PmDecorations.blockWalk"] ?? 0,
      report.arrow.counterDelta["PmDecorations.initWalk"] ?? 0,
    ].join(" / ")));
    lines.push(row("arrow", "refresh dispatches", report.arrow.counterDelta["TextFlowEditor.refreshDispatch"] ?? 0));
    lines.push(row("scroll", "frame p50 / p90", formatFrames(report.scroll.frames)));
    lines.push(row("scroll", "frames > 50ms", report.scroll.framesOver50));
    if (report.save) {
      lines.push(row("save", "renderer long tasks", report.save.rendererLongTasks));
      lines.push(row("save", "renderer main thread ms", round1(report.save.rendererMainThreadMs)));
    }
    lines.push("");

    // 「開く」の内訳。ここに出さないと、settled が縮まなかったときに次の一手を
    // 数字で決められない (JSON を開いた人にしか届かない)。
    const openCounters = topCounters(report.open.counters);
    if (openCounters.length > 0) {
      lines.push("開くまでのカウンタ: " + openCounters.join(", "), "");
    }

    const counters = topCounters(report.idle.counterDelta);
    if (counters.length > 0) {
      lines.push("待機3秒のカウンタ差分: " + counters.join(", "), "");
    }
    if (report.consoleErrors.length > 0) {
      lines.push("console errors:", ...report.consoleErrors.map((error) => `- ${error}`), "");
    }

    const evaluation = evaluations.find((entry) => entry.fixture === report.fixture);
    if (evaluation) {
      lines.push(...renderEvaluation(evaluation));
    }
  }

  return lines.join("\n");
}

function renderEvaluation(evaluation: PerfBudgetEvaluationSummary): string[] {
  const lines: string[] = [];
  if (evaluation.violations.length === 0) {
    lines.push("予算: 違反なし", "");
  } else {
    lines.push("予算違反:", "");
    lines.push("| metric | budget | actual |", "| --- | --- | --- |");
    for (const violation of evaluation.violations) {
      lines.push(`| ${violation.metric} | ${violation.budget} | ${violation.actual} |`);
    }
    lines.push("");
  }
  if (evaluation.skipped.length > 0) {
    lines.push(
      "未計測のため評価しない予算: " + evaluation.skipped.map((skip) => skip.metric).join(", "),
      "",
    );
  }
  return lines;
}

function topCounters(counterDelta: Record<string, number>): string[] {
  return Object.entries(counterDelta)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8)
    .map(([name, value]) => `${name}=${value}`);
}

function row(phase: string, metric: string, value: string | number): string {
  return `| ${phase} | ${metric} | ${value} |`;
}

function formatStats(stats: PerfStats | null): string {
  return stats ? `${stats.p50} / ${stats.max} ms (n=${stats.n})` : "-";
}

function formatMeasure(stats: PerfMeasureStats | null): string {
  return stats ? `${stats.count} / ${round1(stats.maxMs)} / ${round1(stats.meanMs)} ms` : "-";
}

function formatFrames(stats: PerfStats | null): string {
  return stats ? `${stats.p50} / ${stats.p90} ms (n=${stats.n})` : "-";
}
