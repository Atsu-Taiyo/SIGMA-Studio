import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 段落スタイルとフォントサイズはネイティブ `<select>` ではなく、書体と同じ
 * `ToolbarPopover` + `menuitemradio` で選ぶ。OS のドロップダウンはアプリの
 * ダイアログ言語から外れるため。
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

describe("block style and font size toolbar popovers", () => {
  it("picks heading styles from an in-app menu, not a native select", () => {
    expect(chromeSource).not.toMatch(/aria-label=\{t\("format\.blockStyle\.aria"\)\}[\s\S]{0,200}<option value="h1"/);
    const source = popoverSource("format.blockStyle.aria");
    expect(source).toContain('role="menuitemradio"');
    expect(source).toContain("BLOCK_STYLE_OPTIONS");
    expect(source).not.toContain("<option");
  });

  it("picks font sizes from an in-app menu, not a native select", () => {
    expect(chromeSource).not.toMatch(/aria-label=\{t\("format\.fontSize\.aria"\)\}[\s\S]{0,200}<option key=\{size\}/);
    const source = popoverSource("format.fontSize.aria");
    expect(source).toContain('role="menuitemradio"');
    expect(source).toContain("TEXT_FONT_SIZE_OPTIONS");
    expect(source).toContain('t("format.fontSize.auto")');
    expect(source).not.toContain("<option");
  });
});
