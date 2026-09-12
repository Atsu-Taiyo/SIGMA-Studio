/**
 * Runs the fidelity harness over a directory of real decks.
 *
 * Real teaching material is never committed (copyright, size, confidentiality),
 * so this suite is env-gated and **skips by default**. `vitest.config.ts` only
 * excludes `tests/e2e/**`, which means every new `*.test.ts` joins
 * `npm run test` automatically - so the skip has to live here.
 *
 * The one thing that must never happen is a *silent* skip: `perf-probe.mjs`
 * learned the hard way that a mistyped fixture name makes the runner skip
 * everything and exit 0, i.e. green without measuring. So a deck directory that
 * was explicitly configured but is missing or empty fails loudly.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { formatPptxFidelityReport, runPptxFidelitySuite } from "@/lib/powerpoint-fidelity";
import { importPowerPointPptxBuffer } from "@/lib/powerpoint-import";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";

const DECK_DIR_ENV = "SIGMA_PPTX_FIDELITY_DIR";
const DEFAULT_DECK_DIR = fileURLToPath(new URL("../../pptx-fidelity-decks/", import.meta.url));
/** deck02 alone takes ~70s; a whole directory needs a lot of room. */
const DECK_SUITE_TIMEOUT_MS = 30 * 60 * 1000;

interface DeckDirState {
  /** True when `SIGMA_PPTX_FIDELITY_DIR` was set, i.e. someone asked for a measurement. */
  configured: boolean;
  dir: string;
  exists: boolean;
  files: string[];
}

function listDeckFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((entry) => entry.toLowerCase().endsWith(".pptx"))
    .sort()
    .map((entry) => path.join(dir, entry));
}

function resolveDeckDir(env: NodeJS.ProcessEnv): DeckDirState {
  const configuredPath = env[DECK_DIR_ENV]?.trim();
  const dir = configuredPath ? path.resolve(configuredPath) : DEFAULT_DECK_DIR;
  return {
    configured: Boolean(configuredPath),
    dir,
    exists: existsSync(dir),
    files: listDeckFiles(dir),
  };
}

/** Configured but unusable is an operator error, not a reason to go quietly green. */
function assertDeckDirUsable(state: DeckDirState): void {
  if (!state.configured) {
    return;
  }
  if (!state.exists) {
    throw new Error(`${DECK_DIR_ENV}="${state.dir}" does not exist. Fix the path or unset the variable.`);
  }
  if (state.files.length === 0) {
    throw new Error(`${DECK_DIR_ENV}="${state.dir}" holds no .pptx file. Fix the path or unset the variable.`);
  }
}

const deckDir = resolveDeckDir(process.env);

describe("pptx fidelity deck directory", () => {
  it("skips when no deck directory is configured", () => {
    expect(() => assertDeckDirUsable({
      configured: false,
      dir: DEFAULT_DECK_DIR,
      exists: false,
      files: [],
    })).not.toThrow();
  });

  it("fails when the configured deck directory does not exist", () => {
    expect(() => assertDeckDirUsable({
      configured: true,
      dir: "/nonexistent/pptx-fidelity-decks",
      exists: false,
      files: [],
    })).toThrow(/SIGMA_PPTX_FIDELITY_DIR/u);
  });

  it("fails when the configured deck directory holds no pptx file", () => {
    expect(() => assertDeckDirUsable({
      configured: true,
      dir: DEFAULT_DECK_DIR,
      exists: true,
      files: [],
    })).toThrow(/no \.pptx file/u);
  });

  it("accepts the deck directory this run was given", () => {
    expect(() => assertDeckDirUsable(deckDir)).not.toThrow();
  });
});

// `describe.skipIf` is new to this repo: it keeps the gated suite out of a normal
// `npm run test` without hiding it behind an early `return` that reads as dead code.
describe.skipIf(deckDir.files.length === 0)("pptx import fidelity against real decks", () => {
  it("imports every deck without a single error-severity discrepancy", async () => {
    // `pptx-viewer-core` writes `[PptxHandler][info] ...` to stdout during load and
    // has no log-level switch, so buffer it into the report footer instead of
    // letting it bury the summary.
    const importerLogs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      importerLogs.push(args.map((arg) => String(arg)).join(" "));
    });

    let summary: string;
    try {
      const reports = await runPptxFidelitySuite(deckDir.files, async (file) => {
        const bytes = new Uint8Array(readFileSync(file));
        const document = parseSigmaDocument(await importPowerPointPptxBuffer(bytes, path.basename(file), {
          importedAt: "2026-01-01T00:00:00.000Z",
          visualRenderer: "none",
        }));
        return { bytes, document };
      });
      summary = [
        formatPptxFidelityReport(reports),
        `インポータのログ ${importerLogs.length} 行 (末尾 10 行):`,
        ...importerLogs.slice(-10),
      ].join("\n");

      logSpy.mockRestore();
      // The report is the whole point of this suite.
      console.log(summary);

      const failures = reports.filter((report) => report.failure !== undefined);
      expect(failures.map((report) => `${report.file}: ${report.failure}`)).toEqual([]);
      const errors = reports.flatMap((report) => (
        report.discrepancies
          .filter((item) => item.severity === "error")
          .map((item) => `${report.file} slide ${item.slideIndex + 1} ${item.kind} ${item.objectName ?? ""}`)
      ));
      expect(errors).toEqual([]);
    } finally {
      logSpy.mockRestore();
    }
  }, DECK_SUITE_TIMEOUT_MS);
});
