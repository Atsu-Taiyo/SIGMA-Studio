import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ColorPalette } from "./ColorPalette";

/**
 * The palette is shared by the table dialog, the settings screen and the text colours, none of
 * which have an opacity. The opacity UI is therefore opt-in: it appears only when the caller
 * passes a value, so those three keep their current markup exactly.
 */
describe("ColorPalette", () => {
  it("shows no opacity control when the caller has no opacity to edit", () => {
    const html = renderToStaticMarkup(<ColorPalette value="#ff0000" onChange={() => {}} />);

    expect(html).not.toContain("color-palette-fill-summary");
    expect(html).not.toContain('aria-label="不透明度"');
  });

  it("creates colours in its own dialog rather than through the operating system's picker", () => {
    // The native `<input type="color">` opened a separate OS window, outside the app's visual
    // language, and had nowhere to put a transparency.
    const html = renderToStaticMarkup(<ColorPalette value="#ff0000" onChange={() => {}} />);

    expect(html).not.toContain("color-palette-native");
    expect(html).not.toContain('type="color"');
  });

  it("names the plus button after what it makes, including the transparency when there is one", () => {
    const withoutOpacity = renderToStaticMarkup(<ColorPalette value="#ff0000" onChange={() => {}} />);
    const withOpacity = renderToStaticMarkup(
      <ColorPalette value="#ff0000" opacity={0.35} onChange={() => {}} />,
    );

    expect(withoutOpacity).toContain('aria-label="色を作成"');
    expect(withOpacity).toContain('aria-label="色と不透明度を作成"');
  });

  it("offers no controls that do nothing", () => {
    // A permanently disabled "edit the simple palette" pencil, and an eye-dropper the desktop
    // runtime has no implementation for, are both buttons for features that do not exist.
    const html = renderToStaticMarkup(<ColorPalette value="#ff0000" opacity={1} onChange={() => {}} />);

    expect(html).not.toContain("シンプルパレットを編集");
    expect(html).not.toContain("スポイト");
    expect(html).not.toContain("disabled");
  });

  it("keeps the class names the palette is located by", () => {
    const html = renderToStaticMarkup(<ColorPalette value="#ff0000" opacity={1} onChange={() => {}} />);

    expect(html).toContain('class="color-palette"');
    expect(html).toContain('class="color-palette-body"');
    expect(html).toContain("color-palette-swatch");
  });

  it("shows the current opacity as a percent once the caller passes one", () => {
    const html = renderToStaticMarkup(<ColorPalette value="#ff0000" opacity={0.35} onChange={() => {}} />);

    expect(html).toContain("color-palette-fill-summary");
    expect(html).toContain("不透明度 35%");
  });

  it("reads a fully transparent fill as 0%, not as unset", () => {
    const html = renderToStaticMarkup(<ColorPalette value="#ff0000" opacity={0} onChange={() => {}} />);

    expect(html).toContain("不透明度 0%");
    expect(html).not.toContain("不透明度 100%");
  });

  it("keeps showing a stored colour it cannot parse, instead of calling it 塗りなし", () => {
    // `fillColor` is only validated as a string, so AI-written or imported documents legitimately
    // hold `red` or `rgb(...)`. Reporting those as unfilled would invite overwriting them.
    const html = renderToStaticMarkup(<ColorPalette value="red" opacity={0.5} onChange={() => {}} />);

    expect(html).toContain("不透明度 50%");
    expect(html).not.toContain(">塗りなし<");
    expect(html).toContain("--fill-chip-color:red");
  });

  it("says 塗りなし rather than an opacity when there is no fill", () => {
    const html = renderToStaticMarkup(
      <ColorPalette value={null} opacity={1} allowTransparent transparentLabel="塗りなし" onChange={() => {}} />,
    );

    expect(html).toContain("color-palette-fill-summary");
    expect(html).toContain(">塗りなし<");
    expect(html).not.toContain("不透明度 ");
  });

  it("shows no single value when the selection disagrees", () => {
    // `#000000` is a real palette colour, so "nothing is selected" is a claim about the mixed
    // guard rather than about the colour being absent from the grid.
    const html = renderToStaticMarkup(
      <ColorPalette value="#000000" opacity={0.35} mixed allowTransparent onChange={() => {}} />,
    );

    expect(html).toContain("混在");
    expect(html).not.toContain("不透明度 35%");
    expect(html).not.toContain('aria-selected="true"');
  });

  it("does not light up 塗りなし for a mixed selection", () => {
    // This is the combination the shell actually produces: a disagreeing selection has no single
    // colour, so `value` is null — exactly what the "no fill" button also looks for.
    const html = renderToStaticMarkup(
      <ColorPalette value={null} opacity={1} mixed allowTransparent transparentLabel="塗りなし" onChange={() => {}} />,
    );

    expect(html).toContain("混在");
    expect(html).not.toContain("color-palette-transparent active");
  });

  it("marks the current colour as selected when the selection agrees", () => {
    const html = renderToStaticMarkup(<ColorPalette value="#000000" opacity={1} onChange={() => {}} />);

    expect(html).toContain('aria-selected="true"');
  });

  it("has one way in to editing a colour, and it is the plus button", () => {
    // The summary row keeps reporting the state; what it no longer carries is a second edit button
    // pointing at the same dialog.
    const html = renderToStaticMarkup(<ColorPalette value="#ff0000" opacity={0.35} onChange={() => {}} />);

    expect(html).toContain("不透明度 35%");
    expect(html).not.toContain("色と不透明度を編集");
  });
});
