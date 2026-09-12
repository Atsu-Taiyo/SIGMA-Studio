import JSZip from "jszip";

import { expect, test } from "@playwright/test";

import type { SigmaDocument } from "@/features/document";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

for (const entrypoint of ["file input", "desktop open"] as const) {
  test(`${entrypoint} displays and saves the opened filename in the title, tab and library`, async ({ page }) => {
    const source: SigmaDocument = {
      version: "2.0",
      docId: "doc_filename_source",
      metadata: { title: "内部の古いタイトル", styleUnits: { fontSize: "pt" } },
      content: [{ type: "paragraph", id: "filename_body", children: [{ type: "text", text: "本文はそのまま" }] }],
      outputProfiles: { student: {}, teacher: { showSolutions: true }, answerBook: {} },
    };
    const filename = "数学.第1回.sigmadoc.json";
    const title = "数学.第1回";
    await page.setViewportSize({ width: 1400, height: 900 });
    await installDesktopRuntimeMock(page, source);
    await page.addInitScript(({ documentData, openedFilename }) => {
      const bridge = window.desktopAPI!;
      bridge.file.openSigmaDoc = async () => ({ filePath: `/tmp/${openedFilename}`, data: JSON.stringify(documentData) });
      bridge.onMenuAction = (callback) => {
        const listener = () => callback("open-document");
        window.addEventListener("test-open-document", listener);
        return () => window.removeEventListener("test-open-document", listener);
      };
    }, { documentData: source, openedFilename: filename });
    await page.goto("/");
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.getByLabel("教材タイトル")).toHaveValue(source.metadata.title);

    if (entrypoint === "desktop open") {
      await page.evaluate(() => window.dispatchEvent(new Event("test-open-document")));
    } else {
      await page.locator('input[type="file"][accept*="application/json"]').setInputFiles({
        name: filename, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(source)),
      });
    }
    await expect(page.getByLabel("教材タイトル")).toHaveValue(title);
    await expect(page.getByRole("tab", { name: new RegExp(title) })).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem("sigma-studio:e2e-document") ?? "null") as SigmaDocument | null;
      return saved?.metadata.title;
    })).toBe(title);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("sigma-studio:e2e-document")!) as SigmaDocument);
    expect(saved.content).toEqual(source.content);

    await installDesktopRuntimeMock(page, saved);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.getByLabel("教材タイトル")).toHaveValue(title);
    await expect(page.getByRole("tab", { name: new RegExp(title) })).toBeVisible();
    await page.getByRole("button", { name: "教材一覧", exact: true }).click();
    await expect(page.locator(".document-library-item").filter({ hasText: title })).toBeVisible();
  });
}

test("TeX import retains exam subquestions, display math and solutions after saving and reopening", async ({ page }) => {
  const source: SigmaDocument = {
    version: "2.0", docId: "tex_import_seed", metadata: { title: "読み込み前" },
    content: [{ type: "paragraph", id: "tex_seed_body", children: [{ type: "text", text: "読み込み前の本文" }] }],
    outputProfiles: { student: {}, teacher: { showSolutions: true }, answerBook: {} },
  };
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, source);
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  const tex = String.raw`\providecommand{\squarevalue}[2]{#1^2}
\begin{problem}[関数の問題]
関数を考える。
\[f(x)=\squarevalue{x}{unused}+2\]
\begin{enumerate}[label=(\arabic*),start=2]
\item $f(0)$を求めよ。
\item 最小値を求めよ。

理由も説明せよ。
\end{enumerate}
\begin{solution}平方は非負なので、最小値は$2$である。\end{solution}
\end{problem}`;
  await page.locator('input[type="file"][accept*="application/json"]').setInputFiles({
    name: "受験数学.tex", mimeType: "text/plain", buffer: Buffer.from(tex),
  });
  await expect(page.getByLabel("教材タイトル")).toHaveValue("受験数学");
  await expect(page.locator(".tiptap").filter({ hasText: "関数を考える。" }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("sigma-studio:e2e-document") ?? "null") as SigmaDocument | null;
    return saved?.metadata.title;
  })).toBe("受験数学");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("sigma-studio:e2e-document")!) as SigmaDocument);
  expect(saved.content).toMatchObject([{
    type: "problem",
    prompt: [
      { type: "paragraph", children: [{ text: "関数を考える。" }] },
      { type: "paragraph", align: "center", children: [{ tex: "f(x)=x^2+2" }] },
      { type: "list", markerStyle: "paren", start: 2, items: [{}, { continuations: [{ children: [{ text: "理由も説明せよ。" }] }] }] },
    ],
    solution: [{ children: [{ text: "平方は非負なので、最小値は" }, { tex: "2" }, { text: "である。" }] }],
  }]);
  await installDesktopRuntimeMock(page, saved);
  await page.reload();
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.getByLabel("教材タイトル")).toHaveValue("受験数学");
  await expect(page.locator(".tiptap").filter({ hasText: "理由も説明せよ。" }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const doc = JSON.parse(localStorage.getItem("sigma-studio:e2e-document")!) as SigmaDocument;
    return doc.content;
  })).toEqual(saved.content);
});


test("PowerPoint input imports a self-contained slide and retains it after reopening", async ({ page }) => {
  const seed: SigmaDocument = {
    version: "2.0", docId: "pptx_seed", metadata: { title: "読み込み前" },
    content: [{ type: "paragraph", id: "pptx_body", children: [{ type: "text", text: "読み込み前" }] }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
  await installDesktopRuntimeMock(page, seed);
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();

  const zip = new JSZip();
  const relationships = "http://schemas.openxmlformats.org/package/2006/relationships";
  const officeRelationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  zip.file("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
    <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
    <Default Extension="xml" ContentType="application/xml"/>
    <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
    <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  </Types>`);
  zip.file("_rels/.rels", `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${officeRelationships}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
  zip.file("ppt/presentation.xml", `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${officeRelationships}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${officeRelationships}/slide" Target="slides/slide1.xml"/></Relationships>`);
  zip.file("ppt/slides/slide1.xml", `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Rectangle"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="1828800" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="336699"/></a:solidFill></p:spPr></p:sp>
  </p:spTree></p:cSld></p:sld>`);
  const input = page.locator('input[type="file"][accept*=".pptx"]');
  await expect(input).toHaveAttribute("accept", ".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation");
  await input.setInputFiles({ name: "図形スライド.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", buffer: await zip.generateAsync({ type: "nodebuffer" }) });
  await expect(page.getByLabel("教材タイトル")).toHaveValue("図形スライド");
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("sigma-studio:e2e-document") ?? "null") as SigmaDocument | null;
    return saved?.pageLayout?.overlay?.overlaySnapshot?.shapes.length ?? 0;
  })).toBeGreaterThan(0);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("sigma-studio:e2e-document")!) as SigmaDocument);
  expect(saved.metadata.source?.format).toBe("powerpoint");
  await installDesktopRuntimeMock(page, saved);
  await page.reload();
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.getByLabel("教材タイトル")).toHaveValue("図形スライド");
  await expect.poll(() => page.evaluate(() => {
    const document = JSON.parse(localStorage.getItem("sigma-studio:e2e-document")!) as SigmaDocument;
    return document.pageLayout?.overlay?.overlaySnapshot;
  })).toEqual(saved.pageLayout?.overlay?.overlaySnapshot);
});
