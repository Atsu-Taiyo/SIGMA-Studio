import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sampleDocument } from "@/lib/sample-document";
import { createGraph2DSpecPreset } from "@/lib/graph2d";
import type { OverlayShape, OverlayTextShape, SigmaDocument } from "@/features/document";

// Generated content only: never put the user's imported教材 or embedded fonts in this fixture.
function largeOverlayDocument(): SigmaDocument {
  const shapes: OverlayShape[] = Array.from({ length: 3178 }, (_, index): OverlayTextShape => ({
    id: `text_${index}`, type: "text", anchor: { type: "page" }, x: 30 + (index % 3) * 180,
    y: index === 0 ? 35 : Math.floor(index / 74) * 990 + 400 + Math.floor((index % 74) / 3) * 20,
    props: { w: 170, h: 24, color: "black", size: "m", fontSize: 10, blocks: [{
      id: `paragraph_${index}`, type: "paragraph", children: [{ type: "text", text: index === 0 ? "入力テスト" : `テキスト ${index}` }],
    }] },
  }));
  const spec = createGraph2DSpecPreset("blank");
  for (let index = 0; index < 112; index++) {
    // Labels already exist as canonical text shapes, as on a saved converted document.
    const labelId = `text_${index + 1}`;
    shapes.push({ id: `graph_${index}`, type: "graph2dShape", anchor: { type: "page" }, x: 40 + (index % 3) * 180,
      y: Math.floor(index / 3) * 990 + 120,
      props: { boundsMode: "plot", w: 140, h: 140,
        spec: { ...spec, axes: { ...spec.axes, xLabel: "", yLabel: "", originLabel: "" } },
        axisLabelTextShapeIds: { x: labelId },
      },
    });
  }
  return { ...structuredClone(sampleDocument), docId: "overlay_input_regression",
    metadata: { ...sampleDocument.metadata, title: "図中テキスト入力の回帰テスト" },
    content: [{ id: "body", type: "paragraph", children: [] }],
    pageLayout: { ...sampleDocument.pageLayout, preset: "custom", orientation: "portrait",
      pageSize: { widthMm: 182, heightMm: 257 }, marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
      header: sampleDocument.pageLayout?.header ? { ...sampleDocument.pageLayout.header, enabled: false } : undefined,
      footer: sampleDocument.pageLayout?.footer ? { ...sampleDocument.pageLayout.footer, enabled: false } : undefined,
      overlay: { overlaySnapshot: { version: 1, shapes, assets: {},
        extensions: { "sigma.studyaid": { version: 2, pageCount: 43 } },
      } },
    },
  };
}

async function editText(page: Page, id: string) {
  const target = page.locator(`.overlay-shape-text[data-overlay-shape-id="${id}"]`).first();
  await expect(target).toBeVisible();
  const box = (await target.boundingBox())!;
  const point = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.4 };
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(modifier);
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up(modifier);
  // The selection gesture intentionally suppresses double-click editing for 500 ms.
  await page.waitForTimeout(650);
  await page.mouse.dblclick(point.x, point.y);
  const editor = page.locator(".ProseMirror.overlay-text-shape-content");
  await expect(editor).toBeFocused();
  await page.keyboard.press("End");
  return editor;
}

test("large overlay text input preserves graphs, per-letter undo and saved/reloaded content", async () => {
  const root = path.resolve(__dirname, "../..");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-overlay-input-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [root], cwd: root, env });
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await expect(page.locator(".startup-splash")).toBeHidden();
    const fileId = await page.evaluate(async document => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      const created = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return created.file.fileId;
    }, largeOverlayDocument());
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    let editor = await editText(page, "text_0");
    const initial = await editor.innerText();
    const load = () => page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
    // Persist initial derived label positions/heights before comparing unchanged shapes.
    await page.keyboard.type("x");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Escape");
    await expect.poll(async () => (await load())?.pageLayout?.overlay?.overlaySnapshot?.shapes.find(shape => shape.id === "text_1")?.anchor?.type).toBe("shape");
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    editor = await editText(page, "text_0");
    await expect(editor).toHaveText(initial);
    const before = await load();
    await page.keyboard.type("abcdefghijklmnopqrst", { delay: 200 });
    await expect(editor).toHaveText(initial + "abcdefghijklmnopqrst");
    await page.keyboard.press(`${modifier}+z`);
    await expect(editor).toHaveText(initial + "abcdefghijklmnopqrs");
    await page.keyboard.press(`${modifier}+Shift+z`);
    await expect(editor).toHaveText(initial + "abcdefghijklmnopqrst");
    await page.keyboard.insertText("日本語");
    await expect(editor).toHaveText(initial + "abcdefghijklmnopqrst日本語");
    await page.keyboard.press("Escape");
    const expected = initial + "abcdefghijklmnopqrst日本語";
    const text = (doc: SigmaDocument | null) => {
      const shape = doc?.pageLayout?.overlay?.overlaySnapshot?.shapes.find(shape => shape.id === "text_0");
      return shape?.type === "text" ? shape.props.blocks.flatMap(block => block.type === "paragraph" ? block.children : [])
        .map(node => node.type === "text" ? node.text : "").join("") : "";
    };
    await expect.poll(async () => text(await load())).toBe(expected);
    const saved = await load();
    expect(saved?.pageLayout?.overlay?.overlaySnapshot?.shapes).toHaveLength(3290);
    const beforeById = new Map(before?.pageLayout?.overlay?.overlaySnapshot?.shapes.map(shape => [shape.id, shape]));
    // Static text previews refresh their cached height as pages mount. All other persisted
    // fields, including text content, anchors and complete graph specs, must remain intact.
    const withoutDerivedHeight = (shape: OverlayShape | undefined) => shape?.type === "text"
      ? { ...shape, props: { ...shape.props, h: 0 } } : shape;
    for (const shape of saved?.pageLayout?.overlay?.overlaySnapshot?.shapes ?? []) {
      if (shape.id !== "text_0") expect(withoutDerivedHeight(shape)).toEqual(withoutDerivedHeight(beforeById.get(shape.id)));
    }
    expect(saved?.pageLayout?.overlay?.overlaySnapshot?.extensions?.["sigma.studyaid"]).toMatchObject({ pageCount: 43 });
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator('.overlay-shape-text[data-overlay-shape-id="text_0"]').first()).toHaveText(expected);
    expect(text(await load())).toBe(expected);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
