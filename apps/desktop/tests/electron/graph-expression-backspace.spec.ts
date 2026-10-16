import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";

const APP_ROOT = path.resolve(__dirname, "../..");

interface FieldState {
  value: string;
  focused: boolean;
}

async function readFieldState(field: Locator): Promise<FieldState | null> {
  if (await field.count() === 0) return null;
  return field.evaluate((element) => {
    const mathField = element as HTMLElement & { getValue?: () => string; hasFocus?: () => boolean; value?: string };
    return {
      value: mathField.getValue?.() ?? mathField.value ?? "",
      // MathLive の hasFocus() は DOM の焦点が移る (focus() の少し後) より先に true になる。その間の
      // キーは入力欄に届かないので、DOM の焦点も見る。
      focused: document.activeElement === element && (mathField.hasFocus?.() ?? true),
    };
  });
}

async function readSavedCurves(page: Page) {
  return page.evaluate(async () => {
    window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes"));
    await new Promise((resolve) => setTimeout(resolve, 450));
    const [file] = await window.desktopAPI!.storage.listFiles();
    const doc = await window.desktopAPI!.storage.loadDocument(file.fileId);
    const graph = doc?.pageLayout?.overlay?.overlaySnapshot?.shapes.find((shape) => shape.type === "graph2dShape");
    if (graph?.type !== "graph2dShape") return null;
    return graph.props.spec.curves.map((curve) => ({ expr: curve.expr, exprTex: curve.exprTex ?? null }));
  });
}

/** グラフに描かれている曲線の path (式が変わると変わる)。 */
async function drawnCurvePath(graph: Locator) {
  return graph.evaluate((element) => {
    const paths = Array.from(element.querySelectorAll<SVGPathElement>("path"))
      .map((pathElement) => pathElement.getAttribute("d") ?? "")
      .filter((d) => d.length > 40);
    return paths.join("|");
  });
}

/**
 * 実機の MathLive でしか起きない不具合の回帰テスト。
 *
 * 1. グラフの式欄 (リアルタイム表示) で `\sin(x)` を末尾から Backspace すると、入力のたびに値が欄へ
 *    書き戻され、MathLive が閉じ括弧を消した途中の式 `\sin(x.` を読み直してキャレットを末尾へ送るので、
 *    Backspace のたびに `.` が増え続けた。
 * 2. 全部消すと、その Backspace で欄が閉じて焦点がボタンへ移り、続けて打った式がどこにも入らなかった。
 */
test("the realtime graph expression field deletes sin(x) one element per Backspace and accepts a new formula after it is emptied", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Run npm run electron:build first");
  test.skip(
    !process.env.SIGMA_STUDIO_E2E_BASE_URL && !process.env.SIGMA_STUDIO_DEV_SERVER_URL && !existsSync(path.join(APP_ROOT, "out/index.html")),
    "Start a private dev server or build the renderer",
  );
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-graph-expression-backspace-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${profile}`], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    if (env.SIGMA_STUDIO_DEV_SERVER_URL) {
      await expect.poll(() => new URL(page.url()).origin).toBe(new URL(env.SIGMA_STUDIO_DEV_SERVER_URL).origin);
    }
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(async () => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      // 数式入力モード「リアルタイム表示」(MathLive)。
      localStorage.setItem("sigma-studio:inline-math-input-mode", "mathlive");
      await window.desktopAPI!.settings!.setUiLocale!("ja");
    });
    await page.reload();
    await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
    await expect(page.locator(".startup-splash")).toBeHidden();

    await page.getByRole("button", { name: "挿入", exact: true }).click();
    await page.getByRole("menu", { name: "挿入", exact: true }).getByRole("menuitem", { name: "グラフ" }).click();
    const surface = (await page.locator(".overlay-canvas-editor.inserting").first().boundingBox())!;
    await page.mouse.move(surface.x + 200, surface.y + 120);
    await page.mouse.down();
    await page.mouse.move(surface.x + 600, surface.y + 340, { steps: 8 });
    await page.mouse.up();
    const graph = page.locator(".graph-shape").first();
    await expect(graph).toBeVisible();
    // 挿入した直後の最初のクリックは原点の指定になる。
    const box = (await graph.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.locator(".overlay-canvas-editor.origin-picking")).toHaveCount(0);

    await page.getByRole("button", { name: "グラフの設定", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "グラフの設定", exact: true });
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "関数を追加" }).click();
    await expect.poll(() => readSavedCurves(page)).toEqual([{ expr: "sin(x)", exprTex: "\\sin(x)" }]);
    const sinPath = await drawnCurvePath(graph);
    expect(sinPath).not.toBe("");

    await panel.getByTestId("overlay-graph-expr-input").click();
    const field = panel.getByTestId("overlay-graph-expr-input-field");
    await expect.poll(() => readFieldState(field)).toEqual({ value: "\\sin(x)", focused: true });

    // 閉じ括弧を消した途中で欄を離れても、式の下書き (赤いエラー表示のボタン) に `.` が出ない。
    // MathLive はこの途中の式を `\sin(x.` と書き出していた (`mathlive-open-fence.ts`)。
    await page.keyboard.press("Backspace");
    await expect.poll(async () => (await readFieldState(field))?.value).toBe("\\sin(x");
    await page.keyboard.press("Enter");
    await expect(field).toHaveCount(0);
    const draftButton = panel.getByTestId("overlay-graph-expr-input");
    await expect(draftButton).toContainText("sin");
    expect(await draftButton.textContent(), "draft preview").not.toContain(".");
    await draftButton.click();
    await expect.poll(() => readFieldState(field)).toEqual({ value: "\\sin(x", focused: true });

    // 末尾から Backspace で消していくと、点 (`.`) が増えずに空まで行き着く。開き直した `\sin(x` には
    // MathLive が仮の閉じ括弧を出すので、最初の 1 回はそれを消す (値は `\sin(x` のまま)。
    const values: string[] = ["\\sin(x"];
    for (let press = 0; press < 8 && values.at(-1) !== ""; press += 1) {
      await page.keyboard.press("Backspace");
      await page.waitForTimeout(120);
      const state = await readFieldState(field);
      expect(state?.focused, `values: ${JSON.stringify(values)}`).toBe(true);
      values.push(state!.value);
    }
    expect(values.at(-1), `values: ${JSON.stringify(values)}`).toBe("");
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index], `values: ${JSON.stringify(values)}`).not.toContain(".");
      expect(values[index].length, `values: ${JSON.stringify(values)}`).toBeLessThanOrEqual(values[index - 1].length);
    }

    // 空の欄でさらに Backspace しても閉じず、焦点も残る。
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(200);
    expect(await readFieldState(field)).toEqual({ value: "", focused: true });
    await expect(panel.locator(".graph-expression-error")).toHaveText("数値や変数を使った式を入力してください。");

    // 新しい式を打つと欄に入り、そのままグラフへ反映される。
    await page.keyboard.type("x");
    await page.keyboard.type("^");
    await page.keyboard.type("2");
    await expect.poll(async () => (await readFieldState(field))?.value).toBe("x^2");
    await expect.poll(() => drawnCurvePath(graph)).not.toBe(sinPath);
    await expect(panel.locator(".graph-expression-error")).toHaveText("");
    await page.screenshot({ path: testInfo.outputPath("graph-expression-retyped.png") });

    await page.keyboard.press("Enter");
    await expect(field).toHaveCount(0);
    await expect.poll(() => readSavedCurves(page)).toEqual([{ expr: "x^2", exprTex: "x^2" }]);
    const parabolaPath = await drawnCurvePath(graph);

    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    const reloaded = page.locator(".graph-shape").first();
    await expect(reloaded).toBeVisible();
    expect(await readSavedCurves(page)).toEqual([{ expr: "x^2", exprTex: "x^2" }]);
    await expect.poll(() => drawnCurvePath(reloaded)).toBe(parabolaPath);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    expect(existsSync(profile)).toBe(false);
  }
});
