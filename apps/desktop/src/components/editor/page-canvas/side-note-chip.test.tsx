import { readFileSync } from "node:fs";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { getPageMetrics, normalizePageLayout } from "@/lib/page-layout";

import { getPageColumnSideNote, SIDE_NOTE_IN_COLUMN_GAP } from "./render-units";
import { SideNoteChip } from "./side-note-chip";

/**
 * 段組の 2 段目以降の問題・解答のチップ (サイド注) は、その段のすぐ左 (段の間) に縦書きで出す。
 * 一度、段組の組み方を作り直したときに段の位置を渡す処理が外れ、どの段の問題も紙面の左余白に
 * 出ていた。位置は TS (getPageColumnSideNote) が CSS 変数と印で渡し、見た目は CSS が決めるので、
 * 両者の受け渡しが切れていないことをここで固定する (実描画は tests/electron/page-column-side-notes.spec.ts)。
 */

const css = readFileSync(
  path.resolve(import.meta.dirname, "../../../app/styles/graph-and-text-editing.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

function ruleBodies(selectorPart: string): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].includes(selectorPart))
    .map((match) => match[2]);
}

describe("page-column side notes", () => {
  const metrics = getPageMetrics(normalizePageLayout({
    flow: { type: "columns", columnCount: 3, columnGapMm: 8 },
  }));
  const columnStep = metrics.flow.columnWidthPx + metrics.flow.columnGapPx;

  it("hands every position variable to a stylesheet rule that reads it", () => {
    const first = getPageColumnSideNote(metrics.margins.leftPx, metrics.margins.leftPx, metrics);
    const later = getPageColumnSideNote(metrics.margins.leftPx + columnStep, metrics.margins.leftPx + columnStep, metrics);

    expect(first.inColumnGap).toBe(false);
    expect(later.inColumnGap).toBe(true);
    for (const name of [...Object.keys(first.style), ...Object.keys(later.style)]) {
      expect(css, `${name} is written but no rule reads it`).toContain(`var(${name}`);
    }
  });

  it("writes the chips in a later column vertically inside the column gap", () => {
    for (const note of ["problem-area-side-note", "layout-section-side-note"]) {
      const bodies = ruleBodies(`[data-side-note="${SIDE_NOTE_IN_COLUMN_GAP}"] > .${note} > span`);
      expect(bodies.length, note).toBeGreaterThan(0);
      expect(bodies.join("")).toMatch(/writing-mode:\s*vertical-rl/);
      // 自分のユニットの高さを超えない (次の見出しに重ならない)。
      expect(bodies.join("")).toMatch(/max-height:/);
    }
    expect(ruleBodies(".side-note-digits").join("")).toMatch(/text-combine-upright:\s*all/);
  });

  it("marks up to two digits for upright display and keeps the label's spaces", () => {
    expect(renderToStaticMarkup(<SideNoteChip label="問2 問題文" />))
      .toBe('<span>問<span class="side-note-digits">2</span> 問題文</span>');
    expect(renderToStaticMarkup(<SideNoteChip label="問12 問題文" />))
      .toBe('<span>問<span class="side-note-digits">12</span> 問題文</span>');
    // 3 桁以上は縦中横にすると潰れるので横倒しのまま。
    expect(renderToStaticMarkup(<SideNoteChip label="問123 問題文" />)).toBe("<span>問123 問題文</span>");
    expect(renderToStaticMarkup(<SideNoteChip label="解答" />)).toBe("<span>解答</span>");
  });
});
