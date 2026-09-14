import { expect, type Page } from "@playwright/test";
import { getOverlayTextBlocksLabelText, type SigmaDocument } from "@/features/document";

export type ReadGraphDocument = () => Promise<SigmaDocument | null>;

export function savedFormula(document: SigmaDocument | null) {
  const shapes = document?.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
  const graph = shapes.find((shape) => shape.type === "graph2dShape");
  if (graph?.type !== "graph2dShape") return null;
  const curve = graph.props.spec.curves[0];
  const label = shapes.find((shape) => shape.id === graph.props.labelTextShapeIdsByCurveId?.[curve?.id]);
  return {
    curve,
    parameters: graph.props.spec.parameters,
    tex: label?.type === "text" ? getOverlayTextBlocksLabelText(label.props.blocks) : null,
  };
}

export async function expectFormulaOnCanvas(page: Page, tex: string) {
  const math = page.locator(".overlay-text-shape [data-sigma-doc-math-inline]");
  await expect(math).toHaveCount(1);
  await expect(math).toHaveAttribute("data-tex", tex);
  await expect(math.locator(".ML__mathlive, .katex").first()).toBeVisible();
  await expect(math).not.toContainText("*");
}

/** Same UI and saved-document assertions for browser and the real Electron file store. */
export async function exerciseFormulaLabels(page: Page, readDocument: ReadGraphDocument) {
  await page.getByRole("button", { name: "挿入", exact: true }).click();
  await page.getByRole("menu", { name: "挿入", exact: true }).getByRole("menuitem", { name: "グラフ" }).click();
  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  const box = (await surface.boundingBox())!;
  await page.mouse.move(box.x + 120, box.y + 120);
  await page.mouse.down();
  await page.mouse.move(box.x + 420, box.y + 290, { steps: 8 });
  await page.mouse.up();
  const graph = page.locator(".graph-shape").first();
  await expect(graph).toBeVisible();
  const graphBox = (await graph.boundingBox())!;
  await page.mouse.click(graphBox.x + graphBox.width * 0.42, graphBox.y + graphBox.height * 0.48, { button: "right" });
  await page.locator(".overlay-shape-context-menu").getByRole("menuitem", { name: "グラフの設定…" }).click();
  const panel = page.getByRole("dialog", { name: "グラフの設定" });
  await panel.getByRole("button", { name: "パラメータを追加" }).click();
  await panel.getByRole("button", { name: "関数を追加" }).click();

  const toggle = async (visible: boolean) => {
    await page.getByTestId("overlay-graph-curve-actions").hover();
    await page.getByRole("button", { name: `グラフ上の式を${visible ? "表示" : "隠す"}`, exact: true }).click();
    await page.mouse.move(0, 0);
  };
  const setExpression = async (tex: string) => {
    await page.getByTestId("overlay-graph-expr-input").click();
    const field = page.getByTestId("overlay-graph-expr-input-field");
    await field.evaluate(async () => customElements.whenDefined("math-field").then(() => undefined));
    await expect.poll(() => field.evaluate((element) => (element as HTMLElement & { value?: string }).value !== undefined)).toBe(true);
    await field.evaluate((element, value) => {
      (element as HTMLElement & { value: string }).value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }, tex);
    await field.press("Enter");
    await expect(page.getByTestId("overlay-graph-expr-input")).toHaveAttribute("aria-label", /./);
  };

  // Ordinary math must retain the authored fraction, then parameter math must keep s symbolic.
  for (const tex of ["\\frac{x^{2}}{2}", "sx"]) {
    await setExpression(tex);
    await toggle(true);
    await expectFormulaOnCanvas(page, `y = ${tex}`);
    await expect.poll(async () => savedFormula(await readDocument())?.tex).toBe(`y = ${tex}`);
    // Materialization removes curve.label. Recreating it must use exprTex, never expr.
    await toggle(false);
    await expect(page.locator(".overlay-text-shape")).toHaveCount(0);
    await toggle(true);
    await expectFormulaOnCanvas(page, `y = ${tex}`);
    if (tex !== "sx") await toggle(false);
  }
  const curve = graph.getByTestId("graph2d-curve").first();
  const before = await curve.getAttribute("d");
  const slider = panel.getByRole("slider", { name: "s", exact: true });
  await slider.fill("0.5");
  await expect.poll(() => curve.getAttribute("d")).not.toBe(before);
  await expectFormulaOnCanvas(page, "y = sx");
  await expect.poll(async () => savedFormula(await readDocument())).toMatchObject({
    curve: { expr: "s*x", exprTex: "sx" }, parameters: [{ name: "s", value: 0.5 }], tex: "y = sx",
  });
  expect(savedFormula(await readDocument())?.curve.label).toBeUndefined();
  await panel.getByRole("button", { name: "閉じる", exact: true }).click();
  return (await curve.getAttribute("d"))!;
}
