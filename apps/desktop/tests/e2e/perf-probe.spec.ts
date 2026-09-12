/**
 * perf-probe — the repository's performance measurement harness.
 *
 * Runs only with `SIGMA_PERF_PROBE=1` (i.e. from `npm run perf:probe`), because it needs the
 * production build served statically: `next dev` numbers are React development-mode numbers and
 * have misdiagnosed this codebase before. `npm run test:e2e` therefore skips it and stays fast.
 *
 * Output is a report by default (`perf-reports/<timestamp>/{body,problem}.json` + `summary.md`).
 * `perf-budget.json` の assert は既定で有効 (`SIGMA_PERF_REPORT_ONLY=1` で報告のみに落とせる)。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import {
  evaluatePerfBudget,
  parsePerfBudgetFile,
  resolvePerfBudget,
  type PerfBudgetFile,
} from "./perf-budget";
import {
  computePerfStats,
  renderPerfSummaryMarkdown,
  sumRecomputeCounters,
  sumRenderCounters,
  type PerfBudgetEvaluationSummary,
  type PerfKeyPhase,
  type PerfMeasureStats,
  type PerfProbeReport,
  type PerfStats,
} from "./perf-report";
import {
  createPerfBodyDocument,
  PERF_BODY_PARAGRAPH_COUNT,
} from "../fixtures/perf-body-document";
import { createPerfProblemDocument, PERF_PROBLEM_COUNT } from "../fixtures/perf-problem-document";
import type { SigmaDocument } from "@/types/sigma-doc";

// 静的 export を配る実行系 (scripts/perf-probe.mjs) からしか意味のある数値は取れない。
test.skip(
  process.env.SIGMA_PERF_PROBE !== "1",
  "本番ビルドを配って計測する専用ハーネスです (npm run perf:probe)",
);

// playwright は `apps/desktop` を cwd に起動する (playwright.config.ts の testDir 前提)。
// spec は CJS へトランスパイルされるので `import.meta.url` は使えない。
const desktopDir = process.cwd();
const OUT_DIR = process.env.SIGMA_PERF_OUT
  ?? path.join(desktopDir, "perf-reports", new Date().toISOString().replace(/[:.]/g, "-"));
const SELECTED_FIXTURE = process.env.SIGMA_PERF_FIXTURE ?? "all";
/**
 * 予算の assert は **既定で有効**。
 *
 * 「報告するが落とさない」状態は、誰も見ないまま値が悪化していくのを許す。
 * 一時的に外したいとき (計測だけしたい・予算を決め直している最中) だけ
 * `SIGMA_PERF_REPORT_ONLY=1` を明示する。`SIGMA_PERF_ENFORCE=0` でも同じ。
 */
const ENFORCE = process.env.SIGMA_PERF_REPORT_ONLY !== "1" && process.env.SIGMA_PERF_ENFORCE !== "0";
const IDLE_MS = 3000;
const TYPING_POSITIONS = [0.05, 0.5, 0.95];
const TYPING_CHARS = 8;
const TYPING_KEY_DELAY_MS = 400;
const BURST_TEXT = "burstburstburstburst";
const BURST_SETTLE_TIMEOUT_MS = 20_000;
const TYPING_TARGET_ATTEMPTS = 60;
const TYPING_TARGET_TIMEOUT_MS = 5_000;
const ENTER_PRESSES = 4;
const ARROW_PRESSES = 10;
const SHIFT_ARROW_PRESSES = 5;
const VIEWPORT = { width: 1600, height: 1000 };

interface PerfFixture {
  name: string;
  createDocument: () => SigmaDocument;
  /** Element that proves the document finished its first render. */
  readySelector: string;
  readyCount: number;
}

/**
 * 打鍵コストがページ数にどれだけ比例するかを見るための小さい本文型 (5 / 20 ページ相当)。
 * 1,500 段落 ≒ 50 ページなので、150 / 600 段落がその 1/10 / 1/2.5 にあたる。
 */
const BODY_SCALE_PARAGRAPHS = [150, 600] as const;

const FIXTURES: readonly PerfFixture[] = [
  ...BODY_SCALE_PARAGRAPHS.map((paragraphs) => ({
    name: `body-${paragraphs}`,
    createDocument: () => createPerfBodyDocument({ paragraphs }),
    readySelector: '[data-sigma-doc-id^="perf_body_p_"]',
    readyCount: paragraphs,
  })),
  {
    name: "body",
    createDocument: () => createPerfBodyDocument(),
    readySelector: '[data-sigma-doc-id^="perf_body_p_"]',
    readyCount: PERF_BODY_PARAGRAPH_COUNT,
  },
  {
    name: "problem",
    createDocument: createPerfProblemDocument,
    // 各問題の prompt 先頭ブロック — 全問題が描画され終えたことの印。
    readySelector: '[data-sigma-doc-id$="_prompt_0"]',
    readyCount: PERF_PROBLEM_COUNT,
  },
];

interface PerfEventSample {
  name: string;
  dur: number;
  proc: number;
  /**
   * イベント自体の発生時刻 (`entry.startTime`)。observer コールバックの実行時刻ではない —
   * コールバックはバッチで遅れて走るので、それでフェーズを切ると打鍵の遅延が隣のフェーズに
   * 計上され、遅い打鍵ほど別フェーズへ逃げる (重い側が軽く見える) 方向にずれる。
   */
  start: number;
}

interface PerfLongTaskSample {
  dur: number;
  start: number;
}

interface PerfMeasureSample {
  name: string;
  duration: number;
  /** `Date.now()`。measures はリングバッファなので index 差分ではなくこの時刻で切る。 */
  at: number;
}

interface PerfWindow {
  __perfEvents?: PerfEventSample[];
  __perfLongTasks?: PerfLongTaskSample[];
  __perfFrames?: number[];
  __perfRecordingFrames?: boolean;
  __perfRecordFrames?: (on: boolean) => void;
  __SIGMA_STUDIO_PERFORMANCE__?: {
    counters: Record<string, number>;
    measures: PerfMeasureSample[];
    /** 本番ビルドか。development ビルドを計測していないことの証明に使う。 */
    productionBuild?: boolean;
  };
}

interface EventTimingObserverInit extends PerformanceObserverInit {
  durationThreshold?: number;
}

interface PerfSnapshot {
  counters: Record<string, number>;
  domNodes: number;
  mathNodes: number;
  pageSheets: number;
  /** マウントされている本文エディタ (ProseMirror) の数。可視範囲化の効き目はここに出る。 */
  editors: number;
  heapMB: number | null;
}

interface PerfWindowSlice {
  events: PerfEventSample[];
  longTasks: PerfLongTaskSample[];
}

interface MemoryInfo {
  usedJSHeapSize: number;
}

const collectedReports: PerfProbeReport[] = [];
const collectedEvaluations: PerfBudgetEvaluationSummary[] = [];

test.afterAll(() => {
  if (collectedReports.length === 0) {
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const summaryPath = path.join(OUT_DIR, "summary.md");
  writeFileSync(summaryPath, renderPerfSummaryMarkdown(collectedReports, collectedEvaluations));
  console.log(`[perf-probe] summary: ${summaryPath}`);
});

for (const fixture of FIXTURES) {
  test(`perf probe: ${fixture.name}`, async ({ page }) => {
    test.skip(
      SELECTED_FIXTURE !== "all" && SELECTED_FIXTURE !== fixture.name,
      `SIGMA_PERF_FIXTURE=${SELECTED_FIXTURE} により対象外`,
    );
    test.setTimeout(900_000);
    page.setDefaultTimeout(120_000);

    const report = await runProbe(page, fixture);
    mkdirSync(OUT_DIR, { recursive: true });
    const reportPath = path.join(OUT_DIR, `${fixture.name}.json`);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 1)}\n`);
    collectedReports.push(report);
    console.log(`[perf-probe] report: ${reportPath}`);

    const evaluation = evaluatePerfBudget(resolvePerfBudget(loadBudgetFile(), fixture.name), report);
    collectedEvaluations.push(evaluation);

    // このフィクスチャ分の summary を **assert より前に** 書き出す。
    //
    // playwright はテストが落ちるとそのワーカーを止めるので、`afterAll` が走った後に
    // モジュール状態 (`collectedReports`) が初期化され、次のワーカーの `afterAll` が
    // summary.md を上書きする。結果、**落ちたフィクスチャが summary から消え、
    // 残ったフィクスチャの「違反なし」だけが残る**(exit 1 なのに中身は緑に見える)。
    // 断片をここで書いておけば、後続のワーカーに消されない。
    writeFileSync(
      path.join(OUT_DIR, `${fixture.name}.summary.md`),
      renderPerfSummaryMarkdown([report], [evaluation]),
    );

    if (ENFORCE) {
      expect(
        evaluation.violations,
        `${fixture.name}: 性能予算違反 ${JSON.stringify(evaluation.violations)}`,
      ).toEqual([]);
    }
  });
}

function loadBudgetFile(): PerfBudgetFile {
  return parsePerfBudgetFile(JSON.parse(readFileSync(path.join(desktopDir, "perf-budget.json"), "utf8")));
}

async function runProbe(page: Page, fixture: PerfFixture): Promise<PerfProbeReport> {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text().slice(0, 300));
    }
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${String(error).slice(0, 300)}`));

  await page.setViewportSize(VIEWPORT);
  await installObservers(page);
  await installDesktopRuntimeMock(page, fixture.createDocument());

  const open = await measureOpen(page, fixture);
  const idle = await measureIdle(page);
  const typing = await measureTyping(page);
  const burst = await measureBurst(page);
  const enter = await measureKeyPhase(page, ENTER_PRESSES, async () => {
    await page.keyboard.press("End");
    for (let index = 0; index < ENTER_PRESSES; index += 1) {
      await page.keyboard.press("Enter");
      await page.waitForTimeout(600);
    }
  });
  const arrow = await measureKeyPhase(page, ARROW_PRESSES + SHIFT_ARROW_PRESSES, async () => {
    for (let index = 0; index < ARROW_PRESSES; index += 1) {
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(150);
    }
    for (let index = 0; index < SHIFT_ARROW_PRESSES; index += 1) {
      await page.keyboard.press("Shift+ArrowDown");
      await page.waitForTimeout(150);
    }
  });
  const scroll = await measureScroll(page);
  const save = await measureSave(page);

  return {
    label: fixture.name,
    fixture: fixture.name,
    generatedAt: new Date().toISOString(),
    viewport: VIEWPORT,
    open,
    idle,
    typing,
    burst,
    enter,
    arrow,
    scroll,
    save,
    consoleErrors: consoleErrors.slice(0, 10),
  };
}

async function installObservers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const perfWindow = window as unknown as PerfWindow;
    perfWindow.__perfEvents = [];
    perfWindow.__perfLongTasks = [];
    perfWindow.__perfFrames = [];

    const interesting = new Set([
      "beforeinput",
      "input",
      "keydown",
      "keypress",
      "keyup",
      "pointerdown",
      "wheel",
    ]);
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!interesting.has(entry.name)) {
            continue;
          }
          const timing = entry as PerformanceEventTiming;
          perfWindow.__perfEvents?.push({
            name: timing.name,
            dur: timing.duration,
            proc: timing.processingEnd - timing.processingStart,
            start: timing.startTime,
          });
        }
        // durationThreshold は仕様上 16ms が下限 (0 を渡しても 16ms に丸められる) なので、
        // これより速いイベントは届かない。届かない = 速かった、と読む (perf-budget.ts)。
      }).observe({ type: "event", buffered: true, durationThreshold: 0 } as EventTimingObserverInit);
    } catch {
      // Event Timing 未対応のブラウザでは打鍵レイテンシだけ欠測になる。
    }

    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          perfWindow.__perfLongTasks?.push({ dur: entry.duration, start: entry.startTime });
        }
      }).observe({ type: "longtask", buffered: true });
    } catch {
      // longtask 未対応でも他の指標は取れる。
    }

    perfWindow.__perfRecordFrames = (on: boolean) => {
      perfWindow.__perfRecordingFrames = on;
      if (!on) {
        return;
      }
      let last = performance.now();
      const tick = () => {
        if (!perfWindow.__perfRecordingFrames) {
          return;
        }
        const now = performance.now();
        perfWindow.__perfFrames?.push(now - last);
        last = now;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
  });
}

async function measureOpen(page: Page, fixture: PerfFixture): Promise<PerfProbeReport["open"]> {
  const startedAt = Date.now();
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    ({ selector, count }) => document.querySelectorAll(selector).length >= count,
    { selector: fixture.readySelector, count: fixture.readyCount },
    { timeout: 300_000 },
  );
  const msToBlocks = Date.now() - startedAt;
  await assertPerfInstrumentedBuild(page);
  await waitForLayoutSettled(page, startedAt);
  const msToSettled = Date.now() - startedAt;
  const snapshot = await readSnapshot(page);
  return {
    msToBlocks,
    msToSettled,
    // 「開く」の中身が見えないと、settled が縮まない理由を数字で言えない。
    // `measureOpen` が `page.goto` を持っているので、累計 = この開くぶん。
    counters: snapshot.counters,
    domNodes: snapshot.domNodes,
    mathNodes: snapshot.mathNodes,
    pageSheets: snapshot.pageSheets,
    editors: snapshot.editors,
    heapMB: snapshot.heapMB,
  };
}

/**
 * 計測が有効なビルドかを実物で確かめる。`--no-build` で `electron:prepare` の `out/` を
 * 使い回すと `NEXT_PUBLIC_SIGMA_PERF` が無く、カウンタが 1 つも出ないまま「待機 0 回・
 * 長タスク 0」という**全部合格に見えるレポート**が出てしまう (CSP meta 検査では気付けない)。
 */
async function assertPerfInstrumentedBuild(page: Page): Promise<void> {
  const probe = await page.evaluate(() => {
    const bucket = (window as unknown as PerfWindow).__SIGMA_STUDIO_PERFORMANCE__;
    return {
      counters: Object.keys(bucket?.counters ?? {}).length,
      // 数式ノードビューのカウンタは予算 (`enter.unchangedMathRemounts`) の生存確認に使う。
      // 「差分が空 = 再構築されなかった」と読んでよいのは、この計測点が生きている時だけ。
      mathMounts: bucket?.counters?.["InlineMathNodeView.mount"] ?? 0,
      productionBuild: bucket?.productionBuild === true,
    };
  });
  if (probe.counters === 0) {
    throw new Error(
      "計測が無効なビルドです (window.__SIGMA_STUDIO_PERFORMANCE__ にカウンタがありません)。"
      + " `npm run perf:build` (NEXT_PUBLIC_SIGMA_PERF=1) で作った out/ を配ってください。",
    );
  }
  if (!probe.productionBuild) {
    // development ビルドでも計測は有効なので、カウンタの有無だけでは `next dev` を弾けない。
    // React の development ビルドは打鍵が数倍重く、その数字で予算を判定しても意味がない。
    throw new Error(
      "development ビルドを計測しています。`npm run perf:probe` (本番ビルドを配る実行系) を使ってください。",
    );
  }
  if (probe.mathMounts === 0) {
    // 0 だと `enter.unchangedMathRemounts` の「キーが無い = 再構築されていない」という
    // 読み方が成立しない (計測点が消えただけかもしれない)。門が黙って外れるのを防ぐ。
    throw new Error(
      "InlineMathNodeView.mount が 1 度も記録されていません。"
      + " enter.unchangedMathRemounts の判定根拠が失われているので、計測点を確認してください。",
    );
  }
}

/**
 * 「measures が増えなくなったら安定」。measures はリングバッファなので長さの単調増加には
 * 頼れず、直近の measure の時刻 (`at`) が進まなくなったことで判定する。
 */
async function waitForLayoutSettled(page: Page, startedAt: number): Promise<void> {
  let lastActivityAt = -1;
  let stableSince = Date.now();
  while (Date.now() - stableSince < 1500) {
    const latest = await page.evaluate(() => {
      const bucket = (window as unknown as PerfWindow).__SIGMA_STUDIO_PERFORMANCE__;
      const measures = bucket?.measures ?? [];
      return measures.length === 0 ? 0 : measures[measures.length - 1].at;
    });
    if (latest !== lastActivityAt) {
      lastActivityAt = latest;
      stableSince = Date.now();
    }
    await page.waitForTimeout(150);
    if (Date.now() - startedAt > 240_000) {
      return;
    }
  }
}

/**
 * 起動直後の 1 回きりの描画が「待機中の描画」に混ざらないよう、**静まるまで待ってから**
 * 3 秒を測る。
 *
 * 例: 更新状態の問い合わせ (`updater.getStatus()`) はマウント後に 1 度だけ解決して
 * `EditorShell` を 1 回描画する。これは待機中に回り続けている描画ではないが、読み込みが
 * 速いフィクスチャではちょうど待機窓に入り込む (実測で本文型だけ 0、他 3 つが 1)。
 *
 * 「静まる」の判定は描画カウンタが増えないこと。**回り続けている描画はここを抜けられない**
 * ので、予算 0 の意味 (待機中は 1 回も描画しない) は弱まらない。
 */
async function waitForRenderQuiescence(page: Page): Promise<void> {
  // 1 回静かなだけでは足りない: 起動の尾を引く描画は「他の描画が止まってから 1 秒ほど後」に
  // 1 回だけ来ることがある (実測でここを 1 回の判定にしていた時は取りこぼした)。
  // **連続して**静かであることを求める。回り続けている描画はここを抜けられないので、
  // 予算 0 (待機中は 1 回も描画しない) の意味は弱まらない。
  const quietMs = 500;
  const requiredQuietSamples = 4;
  const timeoutAt = Date.now() + 20_000;
  let previous = -1;
  let quiet = 0;
  while (Date.now() < timeoutAt) {
    const renders = sumRenderCounters((await readSnapshot(page)).counters);
    quiet = renders === previous ? quiet + 1 : 0;
    if (quiet >= requiredQuietSamples) {
      return;
    }
    previous = renders;
    await page.waitForTimeout(quietMs);
  }
}

async function measureIdle(page: Page): Promise<PerfProbeReport["idle"]> {
  await waitForRenderQuiescence(page);
  const before = await readSnapshot(page);
  const since = await browserNow(page);
  await setFrameRecording(page, true);
  await page.waitForTimeout(IDLE_MS);
  await setFrameRecording(page, false);
  const after = await readSnapshot(page);
  const slice = await takeWindowSlice(page, since);
  const counterDelta = diffCounters(before.counters, after.counters);
  return {
    durationMs: IDLE_MS,
    reactRenders: sumRenderCounters(counterDelta),
    recomputes: sumRecomputeCounters(counterDelta),
    longTasks: slice.longTasks.length,
    longTaskMs: totalDuration(slice.longTasks),
    counterDelta,
    frames: computePerfStats(await takeFrames(page)),
  };
}

async function measureTyping(page: Page): Promise<PerfProbeReport["typing"]> {
  const blocks = page.locator(".ProseMirror > [data-sigma-doc-id]");
  const blockCount = await blocks.count();
  const samples: PerfProbeReport["typing"] = [];

  // 捨て打ち: 最初の打鍵には JIT・IME・エディタ初期化が乗る。これを 1 つ目の計測位置に
  // 混ぜると「文書の先頭ほど重い」という偽の位置依存が出る (実測で p50 144ms 対 24ms)。
  await typeWarmUp(page, blockCount);

  for (const position of TYPING_POSITIONS) {
    const blockIndex = await focusTypableBlock(page, blockCount, position);

    const before = await readSnapshot(page);
    const since = await browserNow(page);
    const sinceEpoch = Date.now();
    await page.keyboard.type("あいうえおかきくけこ".slice(0, TYPING_CHARS), { delay: TYPING_KEY_DELAY_MS });
    await page.waitForTimeout(800);
    const after = await readSnapshot(page);
    const slice = await takeWindowSlice(page, since);
    const counterDelta = diffCounters(before.counters, after.counters);
    const recompute = await takeMeasureStats(page, "PageCanvasEditor.recompute", sinceEpoch);
    const measureFlowBlocks = await takeMeasureStats(page, "PageCanvasEditor.measureFlowBlocks", sinceEpoch);
    samples.push({
      position,
      blockIndex,
      chars: TYPING_CHARS,
      inputDuration: statsFor(slice.events, "input", (event) => event.dur),
      inputProcessing: statsFor(slice.events, "input", (event) => event.proc),
      keydownDuration: statsFor(slice.events, "keydown", (event) => event.dur),
      longTasks: slice.longTasks.length,
      longTaskMs: totalDuration(slice.longTasks),
      counterDelta,
      reactRenders: sumRenderCounters(counterDelta),
      recompute,
      measureFlowBlocks,
    });
  }

  return samples;
}

/** `measurePerformance` で記録された measure をフェーズ窓で集計する。 */
async function takeMeasureStats(
  page: Page,
  name: string,
  sinceEpoch: number,
): Promise<PerfMeasureStats | null> {
  return page.evaluate(({ measureName, from }) => {
    const bucket = (window as unknown as PerfWindow).__SIGMA_STUDIO_PERFORMANCE__;
    const durations = (bucket?.measures ?? [])
      .filter((measure) => measure.name === measureName && measure.at >= from)
      .map((measure) => measure.duration);
    if (durations.length === 0) {
      return null;
    }
    const totalMs = durations.reduce((sum, value) => sum + value, 0);
    return {
      count: durations.length,
      totalMs,
      maxMs: Math.max(...durations),
      meanMs: totalMs / durations.length,
    };
  }, { measureName: name, from: sinceEpoch });
}

async function typeWarmUp(page: Page, blockCount: number): Promise<void> {
  await focusTypableBlock(page, blockCount, TYPING_POSITIONS[0]);
  await page.keyboard.type("ああ", { delay: TYPING_KEY_DELAY_MS });
  await page.waitForTimeout(800);
}

/**
 * 指定位置の近くにある「本文があって画面に出ているブロック」にキャレットを置き、その index を返す。
 *
 * 文字数だけで選ぶと、解答エリアのように出力プロファイルで隠れているブロックや、ページ窓化で
 * 高さ 0 のまま残っているブロックを掴んでしまい、`click` が既定 timeout (120s) まで粘って
 * フェーズ全体が落ちる。可視性まで見て、駄目なら次の候補へ送る。
 */
async function focusTypableBlock(page: Page, blockCount: number, position: number): Promise<number> {
  if (blockCount <= 0) {
    throw new Error(
      "編集可能なブロックが 1 つも見つかりません (.ProseMirror > [data-sigma-doc-id])。"
      + " セレクタが実装と食い違っていないか確認してください。",
    );
  }
  const blocks = page.locator(".ProseMirror > [data-sigma-doc-id]");
  let index = Math.min(blockCount - 1, Math.floor(blockCount * position));
  for (let attempt = 0; attempt < TYPING_TARGET_ATTEMPTS; attempt += 1) {
    const target = blocks.nth(index);
    const usable = await target.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return (element.textContent?.length ?? 0) > 5 && rect.width > 0 && rect.height > 0;
    });
    if (usable) {
      try {
        await target.scrollIntoViewIfNeeded({ timeout: TYPING_TARGET_TIMEOUT_MS });
        await page.waitForTimeout(400);
        await target.click({ position: { x: 5, y: 5 }, timeout: TYPING_TARGET_TIMEOUT_MS });
        await page.keyboard.press("End");
        await page.waitForTimeout(600);
        return index;
      } catch {
        // 覆われている・スクロールで消えるなどで掴めなかった。次の候補へ。
      }
    }
    index = (index + 1) % blockCount;
  }
  throw new Error(`位置 ${position} の近くに入力できるブロックが見つかりませんでした`);
}

async function measureBurst(page: Page): Promise<PerfProbeReport["burst"]> {
  const before = await readSnapshot(page);
  const since = await browserNow(page);
  const sinceEpoch = Date.now();
  const startedAt = Date.now();
  await page.keyboard.type(BURST_TEXT, { delay: 0 });
  let settled = true;
  await page
    .waitForFunction(
      ({ count, at }) => {
        const bucket = (window as unknown as PerfWindow).__SIGMA_STUDIO_PERFORMANCE__;
        const measures = bucket?.measures ?? [];
        return measures.filter((measure) => measure.name === "TextFlowEditor.onUpdate" && measure.at >= at).length >= count;
      },
      { count: BURST_TEXT.length, at: sinceEpoch },
      // ProseMirror が更新をまとめると 20 件に届かないので、待ちは短く切る。長い timeout を
      // 黙って握り潰すと、待ち時間そのものが `msPerChar` に化けて「計測値」に見えてしまう。
      { timeout: BURST_SETTLE_TIMEOUT_MS },
    )
    .catch(() => {
      settled = false;
    });
  const wallMs = Date.now() - startedAt;
  await page.waitForTimeout(1500);
  const after = await readSnapshot(page);
  const slice = await takeWindowSlice(page, since);
  const counterDelta = diffCounters(before.counters, after.counters);
  return {
    wallMs,
    msPerChar: Math.round(wallMs / BURST_TEXT.length),
    settled,
    longTasks: slice.longTasks.length,
    longTaskMs: totalDuration(slice.longTasks),
    counterDelta,
  };
}

async function measureKeyPhase(
  page: Page,
  keystrokes: number,
  interact: () => Promise<void>,
): Promise<PerfKeyPhase> {
  const before = await readSnapshot(page);
  const since = await browserNow(page);
  await interact();
  await page.waitForTimeout(800);
  const after = await readSnapshot(page);
  const slice = await takeWindowSlice(page, since);
  const counterDelta = diffCounters(before.counters, after.counters);
  return {
    keystrokes,
    keydownDuration: statsFor(slice.events, "keydown", (event) => event.dur),
    longTasks: slice.longTasks.length,
    longTaskMs: totalDuration(slice.longTasks),
    counterDelta,
    reactRenders: sumRenderCounters(counterDelta),
    // このフェーズで作られた数式ノードビューの数 (**引き算はしていない生の値**)。
    // Enter が作るのは段落なので、観測される 1 は「編集したユニットが作り直されて
    // 巻き込まれた既存の数式 1 件」。文書サイズに比例しない (120 ノードでも 1200 ノードでも 1)
    // ので、許容 1 件を予算側に置いてある。打鍵ごとの退行が戻れば 4 件以上になる (実績は 196)。
    //
    // null のままだと予算が永久に skip され「未計測」が「良好」に化けるので、必ず数値を入れる。
    unchangedMathRemounts: counterDelta["InlineMathNodeView.mount"] ?? 0,
  };
}

/**
 * 自動保存 1 回ぶんの renderer 側コスト。
 *
 * 1 文字打って autosave (450ms のデバウンス) を発火させ、保存が終わるまで待つ。
 * 見るのは「renderer の主スレッドを何 ms 使ったか」で、IPC の往復時間ではない
 * (保存の本体は main プロセスで走るので、待ち時間を混ぜると指標の意味が変わる)。
 */
async function measureSave(page: Page): Promise<PerfProbeReport["save"]> {
  const blockCount = await page.locator(".ProseMirror > [data-sigma-doc-id]").count();
  await focusTypableBlock(page, blockCount, 0.5);
  const since = await browserNow(page);
  // `takeMeasureStats` は `Date.now()` 系の `at` で切るので、`performance.now()` を渡すと
  // 常に「全部通す」= ページ読み込み以降の保存を全部平均してしまい、フェーズの窓が無効になる
  // (未計測を表す `null` も永久に返らなくなる)。
  const sinceEpoch = Date.now();
  const before = await readSnapshot(page);

  await page.keyboard.type("s", { delay: 0 });
  // autosave のデバウンス (450ms) + 保存の往復。取りこぼさないよう余裕を持って待つ。
  await page.waitForTimeout(2_000);

  const slice = await takeWindowSlice(page, since);
  const after = await readSnapshot(page);
  const stats = await takeMeasureStats(page, "DesktopRuntime.saveDocument", sinceEpoch);

  if (!stats) {
    // 計測が 1 件も無いのは「保存が軽かった」ではなく「autosave が発火しなかった / 計測が
    // 無効なビルド」。0 を返すと予算 (≤5ms) を素通りして全部合格のレポートになるので、
    // 未計測は null で表明する (perf-budget 側に「save フェーズが未計測」の扱いがある)。
    return null;
  }

  return {
    rendererLongTasks: slice.longTasks.length,
    rendererMainThreadMs: stats.totalMs / stats.count,
    counterDelta: diffCounters(before.counters, after.counters),
  };
}

async function measureScroll(page: Page): Promise<PerfProbeReport["scroll"]> {
  const before = await readSnapshot(page);
  const since = await browserNow(page);
  await setFrameRecording(page, true);
  const scroller = page.locator(".editor-canvas").first();
  const scrollHeight = await scroller.evaluate((element) => element.scrollHeight);
  const steps = 30;
  for (let step = 0; step <= steps; step += 1) {
    await scroller.evaluate((element, top) => {
      element.scrollTop = top;
    }, (scrollHeight * step) / steps);
    await page.waitForTimeout(120);
  }
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
  for (let step = 0; step < 20; step += 1) {
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(500);
  await setFrameRecording(page, false);
  const frames = await takeFrames(page);
  const after = await readSnapshot(page);
  const slice = await takeWindowSlice(page, since);
  return {
    frames: computePerfStats(frames),
    framesOver50: frames.filter((frame) => frame > 50).length,
    longTasks: slice.longTasks.length,
    longTaskMs: totalDuration(slice.longTasks),
    counterDelta: diffCounters(before.counters, after.counters),
  };
}

async function readSnapshot(page: Page): Promise<PerfSnapshot> {
  return page.evaluate(() => {
    const bucket = (window as unknown as PerfWindow).__SIGMA_STUDIO_PERFORMANCE__;
    const memory = (performance as Performance & { memory?: MemoryInfo }).memory;
    return {
      counters: { ...(bucket?.counters ?? {}) },
      domNodes: document.getElementsByTagName("*").length,
      mathNodes: document.querySelectorAll(".math-preview, [data-inline-math-field-id]").length,
      pageSheets: document.querySelectorAll(".a4-page-sheet").length,
      editors: document.querySelectorAll(".ProseMirror").length,
      heapMB: memory ? Math.round(memory.usedJSHeapSize / 1e6) : null,
    };
  });
}

async function takeWindowSlice(page: Page, since: number): Promise<PerfWindowSlice> {
  return page.evaluate((from) => {
    const perfWindow = window as unknown as PerfWindow;
    // `buffered: true` でフェーズ前のエントリも届くので、発生時刻で切る。
    return {
      events: (perfWindow.__perfEvents ?? []).filter((event) => event.start >= from),
      longTasks: (perfWindow.__perfLongTasks ?? []).filter((task) => task.start >= from),
    };
  }, since);
}

async function takeFrames(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const perfWindow = window as unknown as PerfWindow;
    const frames = [...(perfWindow.__perfFrames ?? [])];
    perfWindow.__perfFrames = [];
    return frames;
  });
}

async function setFrameRecording(page: Page, on: boolean): Promise<void> {
  await page.evaluate((enabled) => {
    (window as unknown as PerfWindow).__perfRecordFrames?.(enabled);
  }, on);
}

async function browserNow(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

function statsFor(
  events: readonly PerfEventSample[],
  name: string,
  pick: (event: PerfEventSample) => number,
): PerfStats | null {
  return computePerfStats(events.filter((event) => event.name === name).map(pick));
}

function totalDuration(entries: readonly PerfLongTaskSample[]): number {
  return Math.round(entries.reduce((sum, entry) => sum + entry.dur, 0));
}

function diffCounters(
  before: Record<string, number>,
  after: Record<string, number>,
): Record<string, number> {
  const delta: Record<string, number> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const value = (after[key] ?? 0) - (before[key] ?? 0);
    if (value !== 0) {
      delta[key] = value;
    }
  }
  return delta;
}

function appUrl(target: string): string {
  return process.env.SIGMA_STUDIO_E2E_BASE_URL
    ? new URL(target, process.env.SIGMA_STUDIO_E2E_BASE_URL).toString()
    : target;
}
