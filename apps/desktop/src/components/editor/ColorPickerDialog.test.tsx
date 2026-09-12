import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ColorPickerDialog } from "./ColorPickerDialog";

/**
 * Markup-level facts only: pointer drags, keyboard and the Escape interception live in
 * `tests/e2e/custom-fill-opacity.spec.ts`, because this suite runs without a DOM.
 */
function render(props: Partial<Parameters<typeof ColorPickerDialog>[0]> = {}) {
  return renderToStaticMarkup(
    <ColorPickerDialog
      color="#3366cc"
      opacity={undefined}
      side="left"
      onDraftChange={() => {}}
      onCancel={() => {}}
      onSubmit={() => {}}
      {...props}
    />,
  );
}

describe("ColorPickerDialog", () => {
  it("hides every transparency control when the caller has no opacity to edit", () => {
    const html = render();

    expect(html).not.toContain('aria-label="不透明度"');
    expect(html).not.toContain('aria-label="不透明度 (%)"');
    expect(html).toContain('value="#3366cc"');
  });

  it("shows the transparency as a percent and an eight-digit hex", () => {
    const html = render({ opacity: 0.35 });

    expect(html).toContain('aria-label="不透明度"');
    expect(html).toContain('value="#3366cc59"');
    expect(html).toContain('aria-label="不透明度 (%)" min="0" max="100" step="1" value="35"');
  });

  it("reads a fully transparent fill as 0%, not as unset", () => {
    const html = render({ opacity: 0 });

    expect(html).toContain('aria-label="不透明度 (%)" min="0" max="100" step="1" value="0"');
    expect(html).toContain('value="#3366cc00"');
    expect(html).not.toContain('aria-label="不透明度 (%)" min="0" max="100" step="1" value="100"');
    expect(html).not.toContain('aria-label="不透明度" min="0" max="100" step="1" value="100"');
  });

  it("is a dialog that does not claim to be modal", () => {
    // The point of this panel is watching the figure change behind it, so it must not take the
    // page away from the palette it was opened from.
    const html = render();

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="色を作成"');
    expect(html).not.toContain("aria-modal");
  });

  it("gives the two-dimensional area a focusable slider role that reads out both axes", () => {
    const html = render();

    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-label="彩度と明度"');
    expect(html).toContain('tabindex="0"');
    expect(html).toMatch(/aria-valuetext="彩度 \d+%、明度 \d+%"/);
  });

  it("offers the RGB boxes as the way round the two-dimensional area", () => {
    const html = render();

    for (const label of ["赤", "緑", "青", "色コード"]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
  });

  it("does not offer a screen colour picker, because the desktop runtime has none", () => {
    // Electron 34 exposes no `EyeDropper` at all, and a control that only appears in a browser
    // build would be a feature the shipped app does not have.
    const html = render();

    expect(html).not.toContain("スポイト");
  });

  it("shows a colour it cannot parse in the hex box, but never as the swatch", () => {
    // The swatch has to be the colour OK would write. Painting the stored `red` there would
    // promise a colour this dialog cannot produce.
    const html = render({ color: "red", opacity: 0.5 });

    expect(html).toContain('value="red"');
    expect(html).toContain("--fill-chip-color:rgba(0, 0, 0, 0.5)");
  });

  it("confirms and cancels with named buttons, and has no close cross", () => {
    const html = render();

    expect(html).toContain(">キャンセル<");
    expect(html).toContain(">OK<");
    expect(html).toContain('data-tone="primary"');
  });
});
