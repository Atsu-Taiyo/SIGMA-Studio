import { expect, test, type Page } from "@playwright/test";
import type { SigmaDocument } from "@/features/document";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

const graphDocument = (durationMs = 500): SigmaDocument => ({
  version: "2.0", docId: "graph2d_video", metadata: { title: "2D動画" },
  content: [{ type: "paragraph", id: "intro", children: [{ type: "text", text: "2Dアニメーション" }] }],
  pageLayout: {
    preset: "A4", orientation: "portrait", pageSize: { widthMm: 210, heightMm: 297 },
    marginsMm: { top: 15, right: 15, bottom: 15, left: 15 }, flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
    overlay: { updatedAt: "2026-09-10T00:00:00Z", overlaySnapshot: {
      version: 1, assets: {}, shapes: [{
        id: "animated_graph", type: "graph2dShape", x: 90, y: 160, rotation: 0,
        props: { w: 320, h: 240, spec: {
          kind: "cartesian", title: "s sin(x)", width: 320, height: 240,
          viewBox: { xMin: "-pi", xMax: "pi", yMin: "-2", yMax: "2" },
          axes: { grid: true, showX: true, showY: true, showTicks: true, xTickStep: "pi/2", xTickMode: "pi" },
          curves: [{ id: "curve", expr: "s*sin(x)", color: "#dc2626", strokeWidth: 2 }],
          parameters: [{ id: "s", name: "s", value: 0.25, min: -1.5, max: 1.5,
            animation: { durationMs, loop: "pingPong" } }],
        } },
      }],
    } },
  },
  outputProfiles: { student: {}, teacher: { showSolutions: true }, answerBook: { onlySolutions: true } },
});

async function openGraph(page: Page, durationMs = 500) {
  await installDesktopRuntimeMock(page, graphDocument(durationMs));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(process.env.SIGMA_STUDIO_E2E_BASE_URL ?? "/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();
  await page.locator(".startup-splash").waitFor({ state: "hidden" });
  const graph = page.locator(".graph-shape").first();
  const box = (await graph.locator(".graph2d-axes line").first().boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(".overlay-selection-box")).toBeVisible();
  const graphBox = (await graph.boundingBox())!;
  await page.mouse.click(graphBox.x + graphBox.width * 0.42, graphBox.y + graphBox.height * 0.48, { button: "right" });
  await page.locator(".overlay-shape-context-menu").getByRole("menuitem", { name: "グラフの設定…" }).click({ timeout: 5000 });
  const panel = page.getByRole("dialog", { name: "グラフの設定", exact: true });
  await expect(panel).toBeVisible();
  return panel;
}

test("saves a playable moving 2D video and keeps the source values through reload", async ({ page }, testInfo) => {
  const panel = await openGraph(page);
  await page.evaluate(() => {
    const save = window.desktopAPI!.file.saveToDownloads!;
    window.desktopAPI!.file.saveToDownloads = async (payload) => {
      (window as Window & { videoBase64?: string }).videoBase64 = payload.dataBase64;
      return save(payload);
    };
  });
  await expect(panel.getByText("約1.0秒・ダウンロードフォルダへ保存します")).toBeVisible();
  await panel.getByRole("button", { name: "動画で書き出す" }).click();
  await expect(panel.getByText(/^保存しました: /)).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByRole("button", { name: "フォルダを開く" })).toBeVisible();
  await expect(page.locator("[data-graph-video-stage]")).toHaveCount(0);
  const exported = await page.evaluate(() => ({
    saved: JSON.parse(localStorage.getItem("sigma-studio:e2e-saved-download")!) as { fileName: string; byteLength: number },
    base64: (window as Window & { videoBase64?: string }).videoBase64!,
    document: localStorage.getItem("sigma-studio:e2e-document"),
  }));
  // The app exports media for external playback; its static CSP forbids in-app media.
  const playback = await page.context().newPage();
  const result = await playback.evaluate(async ({ saved, base64, document: savedDocument }) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: saved.fileName.endsWith("mp4") ? "video/mp4" : "video/webm" }));
    const video = document.createElement("video");
    video.muted = true;
    video.src = url;
    await new Promise<void>((resolve, reject) => { video.onloadeddata = () => resolve(); video.onerror = () => reject(new Error("video decode failed")); });
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d")!;
    const sample = async (time: number) => {
      video.currentTime = time;
      await new Promise<void>((resolve) => { video.onseeked = () => resolve(); });
      context.drawImage(video, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let redPixels = 0;
      let redY = 0;
      let darkPixels = 0;
      let fractionDenominatorPixels = 0;
      for (let y = 0; y < canvas.height; y++) for (let x = canvas.width / 2; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        if (data[i] > 130 && data[i + 1] < 100 && data[i + 2] < 100) { redPixels++; redY += y; }
        if (data[i] < 120 && data[i + 1] < 120 && data[i + 2] < 120) {
          darkPixels++;
          // The denominator of the pi/2 tick sits below its bar. Flattened KaTeX markup
          // incorrectly reads as 2pi and leaves this region empty.
          if (x > canvas.width * 0.72 && x < canvas.width * 0.77 && y > canvas.height * 0.555 && y < canvas.height * 0.60) fractionDenominatorPixels++;
        }
      }
      return { redPixels, redY: redY / redPixels, darkPixels, fractionDenominatorPixels, image: canvas.toDataURL("image/png") };
    };
    const first = await sample(0.1);
    const middle = await sample(0.5);
    const dimensions = { width: video.videoWidth, height: video.videoHeight };
    video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url);
    return { saved, first, middle, dimensions, document: savedDocument };
  }, exported).finally(() => playback.close());
  expect(result.saved.fileName).toMatch(/^2Dアニメーション\.(mp4|webm)$/u);
  expect(result.saved.byteLength).toBeGreaterThan(1000);
  expect(result.dimensions).toEqual({ width: 1280, height: 960 });
  expect(result.first.redPixels).toBeGreaterThan(100);
  expect(result.middle.redPixels).toBeGreaterThan(100);
  expect(Math.abs(result.first.redY - result.middle.redY)).toBeGreaterThan(50);
  expect(result.first.darkPixels).toBeGreaterThan(100);
  expect(result.first.fractionDenominatorPixels).toBeGreaterThan(40);
  await testInfo.attach("video-first-frame", { body: Buffer.from(result.first.image.split(",")[1], "base64"), contentType: "image/png" });
  await testInfo.attach("video-middle-frame", { body: Buffer.from(result.middle.image.split(",")[1], "base64"), contentType: "image/png" });
  const savedDocument = JSON.parse(result.document!) as SigmaDocument;
  const shape = savedDocument.pageLayout!.overlay!.overlaySnapshot!.shapes.find((shape) => shape.type === "graph2dShape")!;
  expect(shape.props.spec.parameters?.[0].value).toBe(0.25);
  expect(shape.props.spec.curves[0].expr).toBe("s*sin(x)");
  const restored = await page.context().newPage();
  await installDesktopRuntimeMock(restored, savedDocument);
  await restored.goto(process.env.SIGMA_STUDIO_E2E_BASE_URL ?? "/");
  await expect(restored.locator(".graph-shape").getByTestId("graph2d-curve")).toHaveAttribute("d", await page.locator(".graph-shape").getByTestId("graph2d-curve").getAttribute("d") as string);
  await restored.close();
});

test("downloads a video when the browser owns file saving", async ({ page }, testInfo) => {
  const panel = await openGraph(page);
  await page.evaluate(() => { window.desktopAPI!.file.saveToDownloads = undefined; });
  const downloadReady = page.waitForEvent("download");
  await panel.getByRole("button", { name: "動画で書き出す" }).click();
  const download = await downloadReady;
  expect(download.suggestedFilename()).toMatch(/^2Dアニメーション\.(mp4|webm)$/u);
  await download.saveAs(testInfo.outputPath(download.suggestedFilename()));
  await expect(panel.getByText("ダウンロードしました")).toBeVisible();
});

test("cancels without saving when the settings close during recording", async ({ page }) => {
  const panel = await openGraph(page, 3000);
  await panel.getByRole("button", { name: "動画で書き出す" }).click();
  await expect(panel.getByText(/録画しています/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "動画で書き出す" })).toBeDisabled();
  await panel.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(page.locator("[data-graph-video-stage]")).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("sigma-studio:e2e-saved-download"))).toBeNull();
});

test("cleans up after an unsupported recorder and allows another export", async ({ page }) => {
  const panel = await openGraph(page);
  await page.evaluate(() => {
    const supported = MediaRecorder.isTypeSupported;
    (window as Window & { restoreVideoSupport?: () => void }).restoreVideoSupport = () => { MediaRecorder.isTypeSupported = supported; };
    MediaRecorder.isTypeSupported = () => false;
  });
  await panel.getByRole("button", { name: "動画で書き出す" }).click();
  await expect(panel.getByText("この環境では動画を書き出せません")).toBeVisible();
  await expect(page.locator("[data-graph-video-stage]")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "動画で書き出す" })).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem("sigma-studio:e2e-saved-download"))).toBeNull();
  await page.evaluate(() => { (window as Window & { restoreVideoSupport?: () => void }).restoreVideoSupport!(); });
  await panel.getByRole("button", { name: "動画で書き出す" }).click();
  await expect(panel.getByText(/^保存しました: /)).toBeVisible();
});
