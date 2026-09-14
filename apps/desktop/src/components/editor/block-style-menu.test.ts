import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 段落スタイルはアプリ内ポップオーバーで選び、フォントサイズはツールバー上で
 * 直接入力できる。OS のドロップダウンや別ダイアログには依存しない。
 */
const chromeSource = readFileSync(
  new URL("./editor-shell/chrome/editor-chrome.tsx", import.meta.url),
  "utf8",
);

function popoverSource(ariaKey: string): string {
  const start = chromeSource.indexOf(`ariaLabel={t("${ariaKey}")}`);
  expect(start).toBeGreaterThan(-1);
  const end = chromeSource.indexOf("</ToolbarPopover>", start);
  expect(end).toBeGreaterThan(start);
  return chromeSource.slice(start, end);
}

describe("block style and font size toolbar controls", () => {
  it("picks heading styles from an in-app menu, not a native select", () => {
    expect(chromeSource).not.toMatch(/aria-label=\{t\("format\.blockStyle\.aria"\)\}[\s\S]{0,200}<option value="h1"/);
    const source = popoverSource("format.blockStyle.aria");
    expect(source).toContain('role="menuitemradio"');
    expect(source).toContain("BLOCK_STYLE_OPTIONS");
    expect(source).not.toContain("<option");
  });

  it("uses a simple inline font size control with direct entry", () => {
    const start = chromeSource.indexOf("const fontSizeSelect");
    const end = chromeSource.indexOf("const boldButton", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const source = chromeSource.slice(start, end);
    expect(source).toContain('className="toolbar-font-size-control"');
    expect(source).toContain('className="toolbar-font-size-input"');
    expect(source).toContain('type="text"');
    expect(source).toContain("<Minus");
    expect(source).toContain("<Plus");
    expect(source).not.toContain("ToolbarPopover");
    expect(source).not.toContain("format.fontSize.apply");
    expect(source).not.toContain("font-size-custom-help");
    expect(source).not.toContain("min={1}");
    expect(source).not.toContain("1pt以上");
  });
});
