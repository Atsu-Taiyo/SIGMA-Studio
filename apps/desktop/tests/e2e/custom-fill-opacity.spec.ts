import { expect, test, type Locator, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { grabShapeFromBody } from "./body-overlay-entry";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * Fill transparency.
 *
 * The model has stored `fillOpacity` all along; what was missing was a way to set it and a toolbar
 * that reads the selection instead of remembering the last value it applied. These tests drive the
 * real palette, so they cover both halves: what the panel shows, and what reaches the document.
 *
 * Opacity is checked through `getComputedStyle`, not through the attribute: a stylesheet can
 * override a presentation attribute without changing the markup at all.
 */

function documentWithShapes(shapes: unknown[]): SigmaDocument {
  return {
    ...sampleDocument,
    pageLayout: {
      ...sampleDocument.pageLayout,
      overlay: {
        ...sampleDocument.pageLayout?.overlay,
        overlaySnapshot: { version: 1, shapes, assets: {} },
      },
    },
  } as SigmaDocument;
}

function rectangle(id: string, props: Record<string, unknown> = {}) {
  return {
    id,
    type: "geo",
    x: 60,
    y: 120,
    props: {
      geo: "rectangle",
      w: 120,
      h: 80,
      fill: "solid",
      fillColor: "#3366cc",
      color: "#111827",
      labelColor: "#111827",
      dash: "solid",
      size: "m",
      ...props,
    },
  };
}

const SECTOR = {
  id: "shape_sector",
  type: "arc",
  x: 240,
  y: 120,
  props: {
    kind: "sector",
    r: 50,
    startAngle: 0,
    endAngle: Math.PI / 2,
    fill: "solid",
    fillColor: "#cc3366",
    color: "#111827",
    dash: "solid",
    size: "m",
  },
};

const CLOSED_LINE = {
  id: "shape_closed_line",
  type: "line",
  x: 400,
  y: 120,
  props: {
    kind: "polyline",
    points: [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 40, y: 60 }],
    closed: true,
    fill: "solid",
    fillColor: "#33cc66",
    color: "#111827",
    labelColor: "#111827",
    dash: "solid",
    size: "m",
  },
};

async function open(page: Page, document: SigmaDocument) {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await installDesktopRuntimeMock(page, document);
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
}

async function selectShape(page: Page, id: string) {
  // Unselected shapes let pointer events through to the body, so a plain click never reaches them.
  await grabShapeFromBody(page, page.locator(`.overlay-shape[data-overlay-shape-id="${id}"]`).first());
  const shape = page.locator(`.overlay-shape[data-overlay-shape-id="${id}"]`);
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(1);
  return shape;
}

/**
 * The colour buttons come twice: in the ribbon's shape-style group and in the bar that floats over
 * the selection. The specs drive the floating one — it is what an author reaches for right after
 * selecting a figure — and the ribbon has its own spec below.
 */
function floatingButton(page: Page, name: string) {
  return page.locator(`.selection-toolbar-button[aria-label="${name}"]`);
}

async function openFillPanel(page: Page) {
  const fillButton = floatingButton(page, "内部塗りつぶし");
  await expect(fillButton).toBeEnabled();
  await fillButton.click();
  const popover = page.locator(".color-popover");
  await expect(popover).toBeVisible();
  return popover;
}

/**
 * The painted transparency, so a stylesheet cannot hide a mismatch the way an attribute test would.
 *
 * `:not(defs)` matters: an arc puts its marker definitions first, and a `<defs>` reports a fill
 * opacity of 1 no matter what the figure looks like.
 */
async function paintedFillOpacity(shape: Locator): Promise<number> {
  return shape.locator(".overlay-vector-svg > *:not(defs)").first().evaluate((node) => (
    Number(window.getComputedStyle(node).fillOpacity)
  ));
}

/**
 * The one way into editing a colour: the "+" in the custom row.
 *
 * The dialog sits beside the palette but inside its popover, so everything it contains is still
 * reachable through the popover locator.
 */
async function openCreateDialog(popover: Locator) {
  await popover.getByRole("button", { name: /^色(と不透明度)?を作成$/ }).click();
  const dialog = popover.getByRole("dialog", { name: "色を作成" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function setOpacityPercent(popover: Locator, percent: number) {
  // The palette's own opacity slider is still in the DOM (inert) behind the dialog, under the same
  // name, so the dialog's is reached through the dialog.
  await popover.getByRole("dialog", { name: "色を作成" }).getByRole("slider", { name: "不透明度" }).fill(String(percent));
}

/** The painted fill colour, for the preview that never reaches the document. */
async function paintedFill(shape: Locator): Promise<string> {
  return shape.locator(".overlay-vector-svg > *:not(defs)").first().evaluate((node) => (
    window.getComputedStyle(node).fill
  ));
}

async function savedShapes(page: Page): Promise<Array<Record<string, never>>> {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
  return readSavedShapes(page);
}

/**
 * Without forcing a flush.
 *
 * The flush event emits the overlay again even when the debounced save has already landed, which
 * adds a second (no-op) document write — and therefore a second undo step. Tests that press undo
 * have to let the ordinary autosave settle instead.
 */
async function readSavedShapes(page: Page): Promise<Array<Record<string, never>>> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed?.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
  });
}

test("sets a colour and a transparency together, and stores both", async ({ page }) => {
  await open(page, documentWithShapes([rectangle("shape_rect")]));
  const shape = await selectShape(page, "shape_rect");

  const popover = await openFillPanel(page);
  await openCreateDialog(popover);
  await setOpacityPercent(popover, 35);

  // Immediate preview: the figure follows the slider before anything is confirmed.
  await expect.poll(async () => paintedFillOpacity(shape)).toBeCloseTo(0.35, 2);

  await popover.getByRole("button", { name: "OK", exact: true }).click();
  await expect(popover).toBeHidden();
  await expect.poll(async () => paintedFillOpacity(shape)).toBeCloseTo(0.35, 2);

  await expect.poll(async () => (await savedShapes(page))[0])
    .toMatchObject({ props: { fill: "solid", fillColor: "#3366cc", fillOpacity: 0.35 } });
});

test("leaves the document untouched when the panel is cancelled", async ({ page }) => {
  await open(page, documentWithShapes([rectangle("shape_rect", { fillOpacity: 0.8 })]));
  const shape = await selectShape(page, "shape_rect");

  const popover = await openFillPanel(page);
  await openCreateDialog(popover);
  await setOpacityPercent(popover, 10);
  await expect.poll(async () => paintedFillOpacity(shape)).toBeCloseTo(0.1, 2);

  await popover.getByRole("button", { name: "キャンセル", exact: true }).click();
  await expect.poll(async () => paintedFillOpacity(shape)).toBeCloseTo(0.8, 2);
  await expect.poll(async () => (await savedShapes(page))[0]).toMatchObject({ props: { fillOpacity: 0.8 } });
});

test("drops an unconfirmed preview when the palette is closed from the toolbar", async ({ page }) => {
  // Closing this way never runs the popover's own close handler, so the preview has to be tied to
  // the palette being on screen rather than to one code path.
  await open(page, documentWithShapes([rectangle("shape_rect", { fillOpacity: 1 })]));
  const shape = await selectShape(page, "shape_rect");

  const popover = await openFillPanel(page);
  await openCreateDialog(popover);
  await setOpacityPercent(popover, 15);
  await expect.poll(async () => paintedFillOpacity(shape)).toBeCloseTo(0.15, 2);

  await floatingButton(page, "内部塗りつぶし").click();
  await expect(popover).toBeHidden();
  await expect.poll(async () => paintedFillOpacity(shape)).toBeCloseTo(1, 2);
});

test("brings an invisible fill back when a swatch changes its colour", async ({ page }) => {
  await open(page, documentWithShapes([rectangle("shape_rect", { fillOpacity: 0 })]));
  await selectShape(page, "shape_rect");

  const popover = await openFillPanel(page);
  await popover.getByTitle("#ffc400").click();

  // Keeping 0% here would answer a colour choice with no visible change and no way to find out why.
  await expect.poll(async () => (await savedShapes(page))[0])
    .toMatchObject({ props: { fillColor: "#ffc400", fillOpacity: 1 } });
});

test("a dragged preview never reaches the undo stack", async ({ page }) => {
  await open(page, documentWithShapes([rectangle("shape_rect", { fillOpacity: 1 })]));
  const shape = await selectShape(page, "shape_rect");

  const popover = await openFillPanel(page);
  await openCreateDialog(popover);
  for (const percent of [80, 60, 40, 20]) {
    await setOpacityPercent(popover, percent);
  }
  await popover.getByRole("button", { name: "OK", exact: true }).click();
  await expect.poll(async () => paintedFillOpacity(shape)).toBeCloseTo(0.2, 2);
  // The overlay debounces its save; undoing before it lands would race the history entry.
  await expect.poll(async () => (await readSavedShapes(page))[0], { timeout: 15_000 })
    .toMatchObject({ props: { fillOpacity: 0.2 } });

  // One undo has to reach the value the figure started at, not the previous slider position.
  await page.keyboard.press("ControlOrMeta+KeyZ");
  await expect.poll(async () => paintedFillOpacity(shape)).toBeCloseTo(1, 2);
  await page.keyboard.press("ControlOrMeta+Shift+KeyZ");
  await expect.poll(async () => paintedFillOpacity(shape)).toBeCloseTo(0.2, 2);
});

test("restores the stored colour and transparency when the palette is reopened", async ({ page }) => {
  await open(page, documentWithShapes([rectangle("shape_rect", { fillOpacity: 0.4, fillColor: "#cc0000" })]));
  await selectShape(page, "shape_rect");

  const popover = await openFillPanel(page);
  await expect(popover.getByText("不透明度 40%")).toBeVisible();
  const dialog = await openCreateDialog(popover);
  await expect(dialog.getByRole("spinbutton", { name: "不透明度 (%)" })).toHaveValue("40");
  // Eight digits are how the colour is *typed*; six digits are how it is stored.
  await expect(dialog.getByRole("textbox", { name: "色コード" })).toHaveValue("#cc000066");
  await expect(dialog.getByRole("spinbutton", { name: "赤" })).toHaveValue("204");
});

test("keeps a fully transparent fill apart from no fill", async ({ page }) => {
  await open(page, documentWithShapes([rectangle("shape_rect")]));
  const shape = await selectShape(page, "shape_rect");

  let popover = await openFillPanel(page);
  await openCreateDialog(popover);
  await setOpacityPercent(popover, 0);
  await popover.getByRole("button", { name: "OK", exact: true }).click();

  // 0% keeps the colour, so the figure can be brought back; "no fill" throws it away.
  await expect.poll(async () => (await savedShapes(page))[0])
    .toMatchObject({ props: { fill: "solid", fillColor: "#3366cc", fillOpacity: 0 } });
  popover = await openFillPanel(page);
  await expect(popover.getByText("不透明度 0%")).toBeVisible();

  await popover.getByRole("button", { name: "塗りなし" }).click();
  await expect.poll(async () => (await savedShapes(page))[0]).toMatchObject({ props: { fill: "none" } });
  popover = await openFillPanel(page);
  await expect(popover.getByText("塗りなし", { exact: true }).first()).toBeVisible();
  await expect(popover.getByText(/不透明度 \d+%/)).toHaveCount(0);
  await expect(shape.locator(".overlay-vector-svg > *").first()).toHaveAttribute("fill", "transparent");
});

test("shows no single value when the selection disagrees", async ({ page }) => {
  await open(page, documentWithShapes([
    rectangle("shape_a", { fillOpacity: 0.2 }),
    { ...rectangle("shape_b", { fillOpacity: 0.9 }), x: 240 },
  ]));

  await selectShape(page, "shape_a");
  await page.locator('.overlay-shape[data-overlay-shape-id="shape_b"]').click({ modifiers: ["Shift"] });
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(2);

  const popover = await openFillPanel(page);
  await expect(popover.getByText("混在")).toBeVisible();
  await expect(popover.getByText(/不透明度 \d+%/)).toHaveCount(0);
});

test("applies to sectors and closed lines, not only to boxes", async ({ page }) => {
  for (const id of ["shape_sector", "shape_closed_line"]) {
    // A fresh page per figure: with the first still selected, grabbing the second from the body
    // leaves the selection where it was, and the change would land on the wrong figure.
    await open(page, documentWithShapes([SECTOR, CLOSED_LINE]));
    const shape = await selectShape(page, id);
    const popover = await openFillPanel(page);
    await openCreateDialog(popover);
    await setOpacityPercent(popover, 25);
    await popover.getByRole("button", { name: "OK", exact: true }).click();
    await expect.poll(async () => paintedFillOpacity(shape)).toBeCloseTo(0.25, 2);
    await expect.poll(async () => (await savedShapes(page)).find((saved) => (
      (saved as unknown as { id: string }).id === id
    )) as unknown).toMatchObject({ props: { fillOpacity: 0.25 } });
  }
});

test("keeps the transparency when a palette swatch changes only the colour", async ({ page }) => {
  await open(page, documentWithShapes([rectangle("shape_rect", { fillOpacity: 0.3 })]));
  await selectShape(page, "shape_rect");

  const popover = await openFillPanel(page);
  await popover.getByTitle("#ffc400").click();

  await expect.poll(async () => (await savedShapes(page))[0])
    .toMatchObject({ props: { fillColor: "#ffc400", fillOpacity: 0.3 } });
});

test("opens the colour dialog from the plus button and suspends the palette behind it", async ({ page }) => {
  await open(page, documentWithShapes([rectangle("shape_rect")]));
  await selectShape(page, "shape_rect");

  const popover = await openFillPanel(page);
  const dialog = await openCreateDialog(popover);

  // The dialog lives inside the palette's popover rather than in a second one, so the palette
  // cannot be closed out from under it by its own outside-click handling.
  await expect(popover.locator(".color-picker-dialog")).toHaveCount(1);
  await expect(popover.locator(".color-palette-body")).toHaveAttribute("inert", "");
  await expect(dialog.getByRole("slider", { name: "彩度と明度" })).toBeFocused();
});

test("previews the figure while the saturation square is dragged, without writing anything", async ({ page }) => {
  await open(page, documentWithShapes([rectangle("shape_rect")]));
  const shape = await selectShape(page, "shape_rect");
  const before = await paintedFill(shape);

  const popover = await openFillPanel(page);
  const dialog = await openCreateDialog(popover);
  const area = dialog.getByRole("slider", { name: "彩度と明度" });
  const box = (await area.boundingBox())!;

  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.15);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.75, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => paintedFill(shape)).not.toBe(before);
  // Flushed, so this is the document as it stands rather than a save that has not landed yet.
  await expect.poll(async () => (await savedShapes(page))[0])
    .toMatchObject({ props: { fillColor: "#3366cc" } });
});

test("keeps the arrow keys for the colour square instead of moving focus off it", async ({ page }) => {
  // The popover walks focus between its own controls on ArrowUp/ArrowDown, which would take the
  // vertical axis away from every slider in the dialog.
  await open(page, documentWithShapes([rectangle("shape_rect")]));
  await selectShape(page, "shape_rect");

  const popover = await openFillPanel(page);
  const dialog = await openCreateDialog(popover);
  const area = dialog.getByRole("slider", { name: "彩度と明度" });
  await expect(area).toBeFocused();
  const before = await area.getAttribute("aria-valuetext");

  await page.keyboard.press("ArrowUp");

  await expect(area).toBeFocused();
  await expect.poll(async () => area.getAttribute("aria-valuetext")).not.toBe(before);
});

test("closes only the dialog on Escape, and puts the figure back", async ({ page }) => {
  await open(page, documentWithShapes([rectangle("shape_rect", { fillOpacity: 0.8 })]));
  const shape = await selectShape(page, "shape_rect");

  const popover = await openFillPanel(page);
  const dialog = await openCreateDialog(popover);
  await setOpacityPercent(popover, 10);
  await expect.poll(async () => paintedFillOpacity(shape)).toBeCloseTo(0.1, 2);

  await page.keyboard.press("Escape");

  await expect(dialog).toBeHidden();
  await expect(popover).toBeVisible();
  await expect.poll(async () => paintedFillOpacity(shape)).toBeCloseTo(0.8, 2);

  // Closing the dialog has to hand the keyboard back, or the popover stops answering Escape
  // (it ignores keys raised outside itself) and the author has to reach for the mouse.
  await expect(popover.getByRole("button", { name: "色と不透明度を作成" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
});

test("confirms from the keyboard with Enter in a field", async ({ page }) => {
  await open(page, documentWithShapes([rectangle("shape_rect")]));
  await selectShape(page, "shape_rect");

  const popover = await openFillPanel(page);
  const dialog = await openCreateDialog(popover);
  const hex = dialog.getByRole("textbox", { name: "色コード" });
  await hex.fill("#33cc6659");
  await hex.press("Enter");

  await expect(popover).toBeHidden();
  await expect.poll(async () => (await savedShapes(page))[0])
    .toMatchObject({ props: { fillColor: "#33cc66", fillOpacity: 0.35 } });
});

test("accepts an eight-digit hex but stores the colour and the transparency apart", async ({ page }) => {
  await open(page, documentWithShapes([rectangle("shape_rect")]));
  const shape = await selectShape(page, "shape_rect");

  const popover = await openFillPanel(page);
  const dialog = await openCreateDialog(popover);
  await dialog.getByRole("textbox", { name: "色コード" }).fill("#33cc6659");
  await expect.poll(async () => paintedFillOpacity(shape)).toBeCloseTo(0.35, 2);

  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect.poll(async () => (await savedShapes(page))[0])
    .toMatchObject({ props: { fill: "solid", fillColor: "#33cc66", fillOpacity: 0.35 } });
});

test("remembers a created colour as a six-digit swatch", async ({ page }) => {
  await open(page, documentWithShapes([rectangle("shape_rect")]));
  await selectShape(page, "shape_rect");

  let popover = await openFillPanel(page);
  const dialog = await openCreateDialog(popover);
  await dialog.getByRole("textbox", { name: "色コード" }).fill("#33cc6659");
  await dialog.getByRole("button", { name: "OK", exact: true }).click();

  popover = await openFillPanel(page);
  await expect(popover.getByTitle("#33cc66")).toBeVisible();

  // An eight-digit swatch would put an alpha back into `fillColor` the next time it was clicked.
  const stored = await page.evaluate(() => (
    JSON.parse(window.localStorage.getItem("sigma-studio:color-palette.custom") ?? "null")
  ));
  expect(Array.isArray(stored)).toBe(true);
  expect(stored).toContain("#33cc66");
  for (const entry of stored as unknown[]) {
    expect(typeof entry).toBe("string");
    expect(entry as string).toMatch(/^#[0-9a-f]{6}$/);
  }
});

test("previews nothing until a disagreeing selection is actually touched", async ({ page }) => {
  await open(page, documentWithShapes([
    rectangle("shape_a", { fillOpacity: 0.2 }),
    { ...rectangle("shape_b", { fillOpacity: 0.9 }), x: 240 },
  ]));

  const first = await selectShape(page, "shape_a");
  const second = page.locator('.overlay-shape[data-overlay-shape-id="shape_b"]');
  await second.click({ modifiers: ["Shift"] });
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(2);

  const popover = await openFillPanel(page);
  await expect(popover.getByText("混在")).toBeVisible();
  await openCreateDialog(popover);

  // Opening the dialog is not an edit: neither figure may be flattened onto the other's value.
  await expect.poll(async () => paintedFillOpacity(first)).toBeCloseTo(0.2, 2);
  await expect.poll(async () => paintedFillOpacity(second)).toBeCloseTo(0.9, 2);

  await setOpacityPercent(popover, 50);
  await expect.poll(async () => paintedFillOpacity(first)).toBeCloseTo(0.5, 2);
  await expect.poll(async () => paintedFillOpacity(second)).toBeCloseTo(0.5, 2);
});

test("the stroke palette carries its own transparency, stored apart from the colour", async ({ page }) => {
  await open(page, documentWithShapes([rectangle("shape_rect")]));
  await selectShape(page, "shape_rect");

  const popover = await openStrokePanel(page);
  const dialog = await openCreateDialog(popover);

  await expect(dialog.getByRole("slider", { name: "不透明度" })).toHaveCount(1);
  await expect(dialog.getByRole("spinbutton", { name: "不透明度 (%)" })).toHaveValue("100");
  // Eight digits are how it is typed; the document keeps the six-digit colour and the opacity apart.
  await dialog.getByRole("textbox", { name: "色コード" }).fill("#ff6a0059");
  await dialog.getByRole("button", { name: "OK", exact: true }).click();
  await expect.poll(async () => (await savedShapes(page))[0])
    .toMatchObject({ props: { color: "#ff6a00", strokeOpacity: 0.35 } });
});

/**
 * Lets a figure that was just grabbed from the body finish becoming the selection.
 *
 * A style change made in the first few hundred milliseconds after the grab was measured to be lost
 * about one run in five, in the app as it stands. The slider specs act faster than any author can
 * (the popover opens and the slider is set in one breath), so they wait first.
 */
async function settleSelection(page: Page) {
  await page.waitForTimeout(600);
}

/**
 * The box of something inside a popover that is still sliding into place.
 *
 * The popover enters with a `transform` animation, so a box read the moment it is visible is a few
 * pixels off and a pointer aimed at it misses.
 */
async function settledBox(locator: Locator) {
  let previous = await locator.boundingBox();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await locator.page().waitForTimeout(100);
    const current = await locator.boundingBox();
    if (previous && current && previous.x === current.x && previous.y === current.y) {
      return current;
    }
    previous = current;
  }
  throw new Error("the element never stopped moving");
}

/** The opacity slider on the palette itself: the first control, not the second dialog. */
function paletteOpacitySlider(popover: Locator) {
  return popover.locator(".color-palette-opacity").getByRole("slider", { name: "不透明度" });
}

async function openStrokePanel(page: Page) {
  const strokeButton = floatingButton(page, "枠線");
  await expect(strokeButton).toBeEnabled();
  await strokeButton.click();
  const popover = page.locator(".color-popover");
  await expect(popover).toBeVisible();
  return popover;
}

/** The painted stroke transparency, read off the drawn element the same way the fill is. */
async function paintedStrokeOpacity(shape: Locator): Promise<number> {
  return shape.locator(".overlay-vector-svg > *:not(defs)").first().evaluate((node) => (
    Number(window.getComputedStyle(node).strokeOpacity)
  ));
}

test("a selected figure has no separate opacity button: the colour palettes carry it", async ({ page }) => {
  await open(page, documentWithShapes([rectangle("shape_rect")]));
  await selectShape(page, "shape_rect");

  await expect(floatingButton(page, "内部塗りつぶし")).toBeVisible();
  await expect(floatingButton(page, "枠線")).toBeVisible();
  await expect(floatingButton(page, "透明度")).toHaveCount(0);
});

test("sets the fill opacity from the slider on the palette, without opening the colour dialog", async ({ page }) => {
  await open(page, documentWithShapes([rectangle("shape_rect")]));
  const shape = await selectShape(page, "shape_rect");
  await settleSelection(page);

  const popover = await openFillPanel(page);
  await paletteOpacitySlider(popover).fill("40");

  // Following the slider is a preview; the confirmed value lands when it is released.
  await expect.poll(async () => paintedFillOpacity(shape)).toBeCloseTo(0.4, 2);
  await expect.poll(async () => (await savedShapes(page))[0])
    .toMatchObject({ props: { fill: "solid", fillColor: "#3366cc", fillOpacity: 0.4 } });
  // The palette stays open, so the colour can still be changed after the opacity.
  await expect(popover).toBeVisible();
  await expect(popover.getByText("不透明度 40%")).toBeVisible();
});

test("one drag of the palette slider is one undo step", async ({ page }) => {
  await open(page, documentWithShapes([rectangle("shape_rect", { fillOpacity: 1 })]));
  const shape = await selectShape(page, "shape_rect");
  await settleSelection(page);

  const popover = await openFillPanel(page);
  const slider = paletteOpacitySlider(popover);
  const box = await settledBox(slider);
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 6 });
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();

  const painted = await paintedFillOpacity(shape);
  expect(painted).toBeLessThan(0.3);
  await expect.poll(async () => (await readSavedShapes(page))[0], { timeout: 15_000 })
    .toMatchObject({ props: { fillOpacity: painted } });

  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+KeyZ");
  await expect.poll(async () => paintedFillOpacity(shape)).toBeCloseTo(1, 2);
});

test("sets the stroke opacity from the palette and keeps it when the colour changes", async ({ page }) => {
  await open(page, documentWithShapes([rectangle("shape_rect")]));
  const shape = await selectShape(page, "shape_rect");
  await settleSelection(page);

  let popover = await openStrokePanel(page);
  await paletteOpacitySlider(popover).fill("30");
  await expect.poll(async () => paintedStrokeOpacity(shape)).toBeCloseTo(0.3, 2);
  await expect.poll(async () => (await savedShapes(page))[0])
    .toMatchObject({ props: { color: "#111827", strokeOpacity: 0.3 } });

  // A swatch changes the colour only: choosing red must not quietly make the line opaque again.
  await popover.getByTitle("#e60000").click();
  await expect.poll(async () => (await savedShapes(page))[0])
    .toMatchObject({ props: { color: "#e60000", strokeOpacity: 0.3 } });

  popover = await openStrokePanel(page);
  await expect(popover.getByText("不透明度 30%")).toBeVisible();
});

test("brings an invisible stroke back when a swatch changes its colour", async ({ page }) => {
  await open(page, documentWithShapes([rectangle("shape_rect", { strokeOpacity: 0 })]));
  await selectShape(page, "shape_rect");

  const popover = await openStrokePanel(page);
  await popover.getByTitle("#e60000").click();

  await expect.poll(async () => (await savedShapes(page))[0])
    .toMatchObject({ props: { color: "#e60000", strokeOpacity: 1 } });
});

test("sets a line's opacity from its stroke palette now that the opacity button is gone", async ({ page }) => {
  await open(page, documentWithShapes([
    {
      id: "shape_line",
      type: "line",
      x: 60,
      y: 300,
      props: { kind: "polyline", points: [{ x: 0, y: 0 }, { x: 120, y: 60 }], closed: false, color: "#111827", dash: "solid", size: "m" },
    },
  ]));
  const shape = await selectShape(page, "shape_line");
  await settleSelection(page);

  const popover = await openStrokePanel(page);
  await paletteOpacitySlider(popover).fill("50");

  await expect.poll(async () => paintedStrokeOpacity(shape)).toBeCloseTo(0.5, 2);
  await expect.poll(async () => (await savedShapes(page))[0])
    .toMatchObject({ props: { strokeOpacity: 0.5 } });
});

test("puts one opacity onto a selection whose fills disagree, without touching their colours", async ({ page }) => {
  await open(page, documentWithShapes([
    rectangle("shape_a", { fillOpacity: 0.2, fillColor: "#3366cc" }),
    { ...rectangle("shape_b", { fillOpacity: 0.9, fillColor: "#cc3366" }), x: 240 },
  ]));
  await selectShape(page, "shape_a");
  await page.locator('.overlay-shape[data-overlay-shape-id="shape_b"]').click({ modifiers: ["Shift"] });
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(2);
  await settleSelection(page);

  const popover = await openFillPanel(page);
  await expect(popover.getByText("混在")).toBeVisible();
  await paletteOpacitySlider(popover).fill("60");

  await expect.poll(async () => (await savedShapes(page)).map((saved) => (saved as unknown as { props: object }).props))
    .toMatchObject([
      { fillColor: "#3366cc", fillOpacity: 0.6 },
      { fillColor: "#cc3366", fillOpacity: 0.6 },
    ]);
});

test("cannot move the opacity slider over a figure that has no fill", async ({ page }) => {
  await open(page, documentWithShapes([rectangle("shape_rect", { fill: "none" })]));
  await selectShape(page, "shape_rect");

  const popover = await openFillPanel(page);
  await expect(paletteOpacitySlider(popover)).toBeDisabled();
});

test("the ribbon's fill and stroke palettes carry the same opacity slider", async ({ page }) => {
  // Wide enough that the ribbon's shape-style group is on screen rather than folded away.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await open(page, documentWithShapes([rectangle("shape_rect")]));
  const shape = await selectShape(page, "shape_rect");
  await settleSelection(page);
  const ribbon = page.getByLabel("図形スタイル");

  await ribbon.getByRole("button", { name: "内部塗りつぶし", exact: true }).click();
  let popover = page.locator(".color-popover");
  await paletteOpacitySlider(popover).fill("45");
  await expect.poll(async () => paintedFillOpacity(shape)).toBeCloseTo(0.45, 2);
  await expect.poll(async () => (await savedShapes(page))[0]).toMatchObject({ props: { fillOpacity: 0.45 } });
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  await ribbon.getByRole("button", { name: "枠線", exact: true }).click();
  popover = page.locator(".color-popover");
  await paletteOpacitySlider(popover).fill("25");
  await expect.poll(async () => paintedStrokeOpacity(shape)).toBeCloseTo(0.25, 2);
  await expect.poll(async () => (await savedShapes(page))[0]).toMatchObject({ props: { strokeOpacity: 0.25 } });
});
