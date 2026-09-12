import { expect, test, type Locator, type Page } from "@playwright/test";

import { getArrowheadTrimInStrokes } from "@/features/rendering/core";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * Endpoint decorations beyond the original arrow/dot/bar.
 *
 * The geometry now comes from one table (`features/rendering/core/arrowhead-spec.ts`), and
 * `arrowhead-parity.test.ts` pins that the canvas and the SVG exporter read it the same way. What
 * unit tests cannot reach is the round trip through the real toolbar: picking a head from a shape
 * preview, keeping start and end independent, and surviving a reload.
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

async function open(page: Page, document: SigmaDocument = documentWithShapes([])) {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await installDesktopRuntimeMock(page, document);
  await page.goto("/");
}

test("sets a different head on each end of an arrow, from the shape previews", async ({ page }) => {
  await open(page);
  await insertLineTool(page, "矢印");

  const shape = page.locator(".overlay-shape-arrow").first();
  await expect(shape).toBeVisible();

  await pickEndpoint(page, "end", "三角");
  await pickEndpoint(page, "start", "ひし形");

  const shapeId = await getShapeId(shape);
  await expect(shape.locator(`marker#triangle-${shapeId}-end`)).toHaveCount(1);
  await expect(shape.locator(`marker#diamond-${shapeId}-start`)).toHaveCount(1);
  await expect(shape.locator("line")).toHaveAttribute("marker-end", `url(#triangle-${shapeId}-end)`);
  await expect(shape.locator("line")).toHaveAttribute("marker-start", `url(#diamond-${shapeId}-start)`);

  // The head at the start has to be turned around, or it points into the line instead of away.
  await expect(shape.locator(`marker#diamond-${shapeId}-start`)).toHaveAttribute("orient", "auto-start-reverse");
  await expect(shape.locator(`marker#triangle-${shapeId}-end`)).toHaveAttribute("orient", "auto");

  // Only the heads in use are declared; the picker never leaves the others behind.
  await expect(shape.locator("marker")).toHaveCount(2);
});

test("offers every head as a drawn preview rather than a name alone", async ({ page }) => {
  await open(page);
  await insertLineTool(page, "矢印");

  const menu = await openEndpointMenu(page, "end");
  const options = menu.getByRole("menuitemradio");
  // Seven shapes at two sizes, plus "なし".
  await expect(options).toHaveCount(15);
  const shapes = ["矢印", "三角", "矢印（開）", "矢印（細）", "ひし形", "丸", "バー"];
  for (const name of ["なし", ...shapes, ...shapes.map((shape) => `${shape}（小）`)]) {
    await expect(menu.getByRole("menuitemradio", { name, exact: true })).toBeVisible();
  }
  // Every option but "なし" draws its shape; the label alone would not tell them apart.
  const drawn = await options.evaluateAll((nodes) => nodes.filter((node) => (
    node.querySelectorAll(".line-endpoint-preview path, .line-endpoint-preview circle:not(.endpoint-side-cue)").length > 0
  )).length);
  expect(drawn).toBe(14);

  // …and a small head really is drawn smaller, not merely named so.
  const widths = await Promise.all(["三角", "三角（小）"].map((name) => (
    menu.getByRole("menuitemradio", { name, exact: true })
      .locator(".line-endpoint-preview path")
      .evaluate((path) => (path as SVGPathElement).getBBox().width)
  )));
  expect(widths[1]).toBeLessThan(widths[0]);
});

test("keeps a head on an open curve and on an arc, and in the saved document", async ({ page }) => {
  await open(page);
  await insertLineTool(page, "曲線", { drag: false });
  await drawCurve(page);

  const curve = page.locator(".overlay-shape-line").first();
  await expect(curve).toBeVisible();
  await pickEndpoint(page, "end", "矢印（細）");
  const curveId = await getShapeId(curve);
  await expect(curve.locator(`marker#thinArrow-${curveId}-end`)).toHaveCount(1);

  await insertShape(page, "円弧");
  const arc = page.locator(".overlay-shape-arc").first();
  await expect(arc).toBeVisible();
  await pickEndpoint(page, "end", "矢印（開）");
  const arcId = await getShapeId(arc);
  await expect(arc.locator(`marker#openArrow-${arcId}-end`)).toHaveCount(1);

  // The heads have to reach the persisted document, not just the DOM.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
  await expect.poll(async () => savedHeads(page)).toEqual(
    expect.arrayContaining(["thinArrow", "openArrow"]),
  );
});

test("draws the heads of a document that was saved with them", async ({ page }) => {
  // The other half of the round trip: a stored head has to survive validation on the way in and
  // come back as a marker. Nothing in the app rewrites it on open.
  await open(page, documentWithShapes([{
    id: "overlay_shape_saved_heads",
    type: "arrow",
    x: 80,
    y: 120,
    props: {
      start: { x: 0, y: 0 },
      end: { x: 160, y: 0 },
      arrowheadStart: "diamond",
      arrowheadEnd: "triangle",
      fill: "none",
      color: "#111827",
      labelColor: "#111827",
      dash: "solid",
      size: "m",
    },
  }]));

  const shape = page.locator('[data-overlay-shape-id="overlay_shape_saved_heads"]');
  await expect(shape).toBeVisible();
  await expect(shape.locator("marker#diamond-overlay_shape_saved_heads-start")).toHaveCount(1);
  await expect(shape.locator("marker#triangle-overlay_shape_saved_heads-end")).toHaveCount(1);
});

test("keeps the head when the line turns thick and dashed", async ({ page }) => {
  await open(page);
  await insertLineTool(page, "線");

  const shape = page.locator(".overlay-shape-line").first();
  const shapeId = await getShapeId(shape);
  await pickEndpoint(page, "end", "ひし形");

  // The marker's own path also lives inside this shape, so stay on the drawn geometry.
  const path = shape.locator(".overlay-vector-svg > polyline, .overlay-vector-svg > line, .overlay-vector-svg > path").first();
  const marker = shape.locator(`marker#diamond-${shapeId}-end`);
  const thinStroke = await strokeWidthOf(path);
  const thinMarkerWidth = await marker.getAttribute("markerWidth");

  await chooseMenuItem(page, "線幅", "極太");
  await chooseMenuItem(page, "線種", "破線");

  await expect(path).toHaveAttribute("marker-end", `url(#diamond-${shapeId}-end)`);
  await expect(path).toHaveCSS("stroke-dasharray", /\d/);
  expect(await strokeWidthOf(path)).toBeGreaterThan(thinStroke);
  // `markerUnits="strokeWidth"` is what makes the head follow the line: the head is not re-authored
  // at a new size, its units simply mean more pixels.
  await expect(marker).toHaveAttribute("markerUnits", "strokeWidth");
  expect(await marker.getAttribute("markerWidth")).toBe(thinMarkerWidth);

  // Marker content inherits from the `<svg>` that declares the line, and a head states its fill as
  // a presentation attribute that any stylesheet outranks. Both have gone wrong before, and
  // neither shows up in the markup — only in the painted result.
  const painted = await marker.locator("path").evaluate((node) => {
    const style = window.getComputedStyle(node);
    return { fill: style.fill, dash: style.strokeDasharray };
  });
  expect(painted.fill).not.toBe("none");
  expect(painted.dash).toBe("none");
});

/**
 * The reported bug: with `stroke-linecap: butt` a line drawn all the way to its stored end point
 * squares off inside the head, and near a point the head is thinner than the line — so a rectangular
 * stub appears past the tip. Unit tests pin the numbers; these check that the numbers survive the
 * real DOM, that the head is what now lands on the stored point, and that the editing handles did
 * not move with the ink.
 */
test("stops the line behind the head without moving the stored endpoint", async ({ page }) => {
  await open(page, documentWithShapes([
    lineShape("overlay_shape_plain", 120, "none"),
    lineShape("overlay_shape_tipped", 320, "diamond"),
  ]));

  // A horizontal `<line>` has a zero-height box, which Playwright reports as hidden; assert on the
  // element and its attributes instead of on visibility.
  const plain = page.locator('[data-overlay-shape-id="overlay_shape_plain"] line');
  const tipped = page.locator('[data-overlay-shape-id="overlay_shape_tipped"] line');
  await expect(tipped).toHaveCount(1);

  // `xl` is a 5px stroke, so the ink is 5px shorter for every marker unit the diamond gives up.
  const trim = getArrowheadTrimInStrokes("diamond");
  const plainSpan = await lineSpan(plain);
  const tippedSpan = await lineSpan(tipped);
  expect(tippedSpan.x1).toBeCloseTo(plainSpan.x1, 3);
  expect(plainSpan.x2 - tippedSpan.x2).toBeCloseTo(trim * 5, 3);

  // The head is anchored behind its own point by exactly what the line gave up, which is what puts
  // the point back on the stored end coordinate. `9` — the tip — would leave the stub in place.
  const marker = page.locator("marker#diamond-overlay_shape_tipped-end");
  expect(Number(await marker.getAttribute("refX"))).toBeCloseTo(9 - trim, 6);
});

test("trims an arc's ink without moving its angle handles", async ({ page }) => {
  await open(page);
  await insertShape(page, "円弧");

  const arc = page.locator(".overlay-shape-arc").first();
  const path = arc.locator(".overlay-vector-svg > path");
  await expect(path).toBeVisible();
  const before = await path.getAttribute("d");
  const handle = page.locator(".overlay-arc-point-handle.end");
  await expect(handle).toBeVisible();
  const handleBefore = await handle.boundingBox();

  await pickEndpoint(page, "end", "三角");

  // The ink now stops short of the stored end angle so the triangle's point can take its place.
  await expect.poll(async () => path.getAttribute("d")).not.toBe(before);
  // The angle handle is the only way to reshape an arc. It reads the stored angle, not the drawn
  // one, so it has to stay exactly where it was.
  expect(await handle.boundingBox()).toEqual(handleBefore);
});

test("keeps a very short two-headed line drawn and pointing the right way", async ({ page }) => {
  await open(page, documentWithShapes([{
    id: "overlay_shape_short",
    type: "arrow",
    x: 120,
    y: 520,
    props: {
      start: { x: 0, y: 0 },
      end: { x: 20, y: 0 },
      arrowheadStart: "diamond",
      arrowheadEnd: "diamond",
      fill: "none",
      color: "#111827",
      labelColor: "#111827",
      dash: "solid",
      size: "xl",
    },
  }]));

  const line = page.locator('[data-overlay-shape-id="overlay_shape_short"] line');
  await expect(line).toHaveCount(1);

  // Two diamonds want 75px of a 20px line. The clamp keeps a fifth of it rather than turning the
  // line inside out, and both markers are still declared.
  const span = await lineSpan(line);
  expect(span.x2 - span.x1).toBeCloseTo(4, 3);
  await expect(page.locator("marker#diamond-overlay_shape_short-start")).toHaveCount(1);
  await expect(page.locator("marker#diamond-overlay_shape_short-end")).toHaveCount(1);
});

function lineShape(id: string, y: number, head: string) {
  return {
    id,
    type: "arrow",
    x: 120,
    y,
    props: {
      start: { x: 0, y: 0 },
      end: { x: 240, y: 0 },
      arrowheadStart: "none",
      arrowheadEnd: head,
      fill: "none",
      color: "#111827",
      labelColor: "#111827",
      dash: "solid",
      size: "xl",
    },
  };
}

async function lineSpan(locator: Locator): Promise<{ x1: number; x2: number }> {
  return locator.evaluate((node) => ({
    x1: Number(node.getAttribute("x1")),
    x2: Number(node.getAttribute("x2")),
  }));
}

async function insertLineTool(page: Page, label: string, options: { drag?: boolean } = {}) {
  const menuButton = page.getByRole("button", { name: "線", exact: true });
  await expect(menuButton).toBeVisible();
  await menuButton.click();
  await page.getByRole("menu").getByRole("menuitem", { name: label, exact: true }).click();
  if (options.drag ?? true) {
    await dragInsert(page);
  }
}

async function insertShape(page: Page, label: string) {
  const menuButton = page.getByRole("button", { name: "図形", exact: true });
  await expect(menuButton).toBeVisible();
  await menuButton.click();
  await page.getByRole("menu").getByRole("menuitem", { name: label, exact: true }).click();
  await dragInsert(page);
}

async function surfaceOrigin(page: Page) {
  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  const shapeCount = await page.locator("[data-overlay-shape-id]").count();
  return { x: box!.x + 96 + shapeCount * 150, y: box!.y + 140 };
}

async function dragInsert(page: Page) {
  const origin = await surfaceOrigin(page);
  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();
  await page.mouse.move(origin.x + 120, origin.y + 70, { steps: 8 });
  await page.mouse.up();
}

async function drawCurve(page: Page) {
  const origin = await surfaceOrigin(page);
  await page.mouse.click(origin.x, origin.y);
  await page.mouse.click(origin.x + 60, origin.y - 40);
  await page.mouse.dblclick(origin.x + 130, origin.y + 20);
}

async function openEndpointMenu(page: Page, endpoint: "start" | "end") {
  const name = endpoint === "start" ? "線の左端" : "線の右端";
  const button = page.getByRole("button", { name: new RegExp(`^${name}（現在: `) });
  await expect(button).toBeEnabled();
  await button.click();
  const menu = page.getByRole("menu", { name });
  await expect(menu).toBeVisible();
  return menu;
}

async function pickEndpoint(page: Page, endpoint: "start" | "end", label: string) {
  const menu = await openEndpointMenu(page, endpoint);
  await menu.getByRole("menuitemradio", { name: label, exact: true }).click();
  await expect(menu).toBeHidden();
}

async function chooseMenuItem(page: Page, buttonName: string, itemName: string) {
  const button = page.getByRole("button", { name: new RegExp(`^${buttonName}`) }).first();
  await button.click();
  await page.getByRole("menu").getByRole("menuitemradio", { name: itemName, exact: true }).click();
}

async function strokeWidthOf(locator: Locator): Promise<number> {
  return locator.evaluate((node) => Number.parseFloat(window.getComputedStyle(node).strokeWidth));
}

async function getShapeId(shape: Locator): Promise<string> {
  const id = await shape.getAttribute("data-overlay-shape-id");
  expect(id).toBeTruthy();
  return id!;
}

async function savedHeads(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const found: string[] = [];
    const walk = (value: unknown): void => {
      if (!value || typeof value !== "object") {
        return;
      }
      const head = (value as { arrowheadEnd?: unknown }).arrowheadEnd;
      if (typeof head === "string") {
        found.push(head);
      }
      for (const child of Object.values(value)) {
        walk(child);
      }
    };
    walk(raw ? JSON.parse(raw) : null);
    return found;
  });
}
