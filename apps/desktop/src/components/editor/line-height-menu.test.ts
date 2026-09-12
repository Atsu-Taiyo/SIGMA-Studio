import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The line-height toolbar popover owns exactly one fine-adjustment stepper, and it lives behind
 * the "数値で指定" disclosure.
 *
 * PR #303 put a stepper at the top of the popover. PR #318 then redesigned the popover so the
 * detailed controls open on demand — it added a second, properly grouped stepper inside
 * `#line-height-custom-panel` and shipped an e2e ("opens detailed line-height controls on demand",
 * `tests/e2e/text-format-selection.spec.ts`) asserting the collapsed popover has no stepper at
 * all — but never deleted the #303 one. The result was two identical `− 1.75行 +` controls stacked
 * in the same popover, both exposing the aria-labels 行間を狭める / 行間を広げる, which makes
 * `getByRole` inside the dialog ambiguous and reads as a duplicated control to assistive tech.
 *
 * The structure is pinned in source (same technique as `GraphSettingsPanel.test.ts`) because
 * `EditorShell` cannot be mounted in isolation; the rendered behaviour is covered by the e2e above.
 *
 * The popover markup itself moved out of `EditorShell.tsx` into the shared chrome group components
 * (WI-3, 振る舞い不変リファクタ); only the file that owns it changed, so this test follows it there
 * rather than relaxing what it asserts.
 *
 * 文言は `chrome` namespace へ移した (i18n WI-2) ので、目印は生の日本語ではなく翻訳キーで引く。
 * 何を固定しているか (ステッパーは1つ・開示パネルの中・± のラベルは各1回) は変えていない。
 */
const chromeSource = readFileSync(
  new URL("./editor-shell/chrome/editor-chrome.tsx", import.meta.url),
  "utf8",
);

function lineHeightPopoverSource(): string {
  const start = chromeSource.indexOf('ariaLabel={t("format.lineHeight.label")}');
  expect(start).toBeGreaterThan(-1);
  const end = chromeSource.indexOf("</ToolbarPopover>", start);
  expect(end).toBeGreaterThan(start);
  return chromeSource.slice(start, end);
}

/**
 * Any way of writing the class token counts — `className="line-height-stepper"`,
 * `className={"line-height-stepper"}` and `className="line-height-stepper foo"` are the same
 * element to the browser, so a re-added stepper must not be able to slip past by changing quoting.
 */
const STEPPER_CLASS = /className=\{?["'`][^"'`]*\bline-height-stepper\b/g;

describe("line-height toolbar popover", () => {
  it("declares a single stepper", () => {
    const popover = lineHeightPopoverSource();
    const steppers = popover.match(STEPPER_CLASS) ?? [];
    expect(steppers).toHaveLength(1);
  });

  it("keeps that stepper inside the format.lineHeight.custom disclosure panel", () => {
    const popover = lineHeightPopoverSource();
    const panelStart = popover.indexOf('id="line-height-custom-panel"');
    expect(panelStart).toBeGreaterThan(-1);
    const stepperStart = popover.search(new RegExp(STEPPER_CLASS.source));
    expect(stepperStart).toBeGreaterThan(panelStart);
  });

  it("exposes the ± aria-labels only once so the dialog stays unambiguous", () => {
    const popover = lineHeightPopoverSource();
    expect(popover.match(/aria-label=\{t\("format\.lineHeight\.decrease"\)\}/g) ?? []).toHaveLength(1);
    expect(popover.match(/aria-label=\{t\("format\.lineHeight\.increase"\)\}/g) ?? []).toHaveLength(1);
  });
});
