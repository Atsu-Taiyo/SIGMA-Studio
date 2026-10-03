import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { _electron as electron, expect, test } from "@playwright/test";

const APP_ROOT = path.resolve(__dirname, "../..");

async function presentation() {
  const zip = new JSZip();
  const relationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  zip.file("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>`);
  zip.file("_rels/.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relationships}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
  zip.file("ppt/presentation.xml", `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${relationships}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${relationships}/slide" Target="slides/slide1.xml"/></Relationships>`);
  zip.file("ppt/slides/slide1.xml", `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="TextBox"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="5486400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="2400"/><a:t>PowerPoint取り込み確認</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  return zip.generateAsync({ type: "nodebuffer" });
}

test("PowerPoint imports through the desktop renderer and survives native save and restart", async ({}, testInfo) => {
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-pptx-import-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  const launch = () => electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await page.evaluate(async () => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
    });
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await page.locator('input[type="file"][accept*=".pptx"]').setInputFiles({ name: "browser-import.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", buffer: await presentation() });
    await expect(page.locator(".editor-canvas")).toContainText("PowerPoint取り込み確認");
    const file = (await page.evaluate(() => window.desktopAPI!.storage.listFiles())).find(file => file.title === "browser-import")!;
    expect(file).toBeTruthy();
    const saved = (await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), file.fileId))!;
    expect(saved.metadata.source).toMatchObject({ format: "powerpoint", slideCount: 1 });
    expect(saved.pageLayout!.overlay!.overlaySnapshot!.shapes).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath("powerpoint-import.png") });
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator(".editor-canvas")).toContainText("PowerPoint取り込み確認");
    const reloaded = (await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), file.fileId))!;
    expect(reloaded.pageLayout!.overlay!.overlaySnapshot).toEqual(saved.pageLayout!.overlay!.overlaySnapshot);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
