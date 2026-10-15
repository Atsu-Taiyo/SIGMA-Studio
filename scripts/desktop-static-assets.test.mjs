import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { normalizeExportedCssAssetUrls, normalizeExportedCssAssets } from "../apps/desktop/scripts/static-assets.mjs";

test("exported font URLs resolve to actual media files from each stylesheet directory", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-static-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const exportDirectory = path.join(directory, "out");
  const media = path.join(exportDirectory, "_next", "static", "media", "Math-Regular.woff2");
  const stylesheets = [
    path.join(exportDirectory, "_next", "static", "css", "math.css"),
    path.join(exportDirectory, "styles", "nested", "math.css"),
  ];
  await mkdir(path.dirname(media), { recursive: true });
  await writeFile(media, "font fixture");
  for (const cssFile of stylesheets) {
    await mkdir(path.dirname(cssFile), { recursive: true });
    await writeFile(cssFile, '@font-face{font-family:Math;src:url("./_next/static/media/Math-Regular.woff2?v=1#face") format("woff2")}');
  }
  await writeFile(path.join(exportDirectory, "index.html"), "HTML stays unchanged");
  assert.deepEqual(await normalizeExportedCssAssets(exportDirectory), { rewrittenFiles: 2, rewrittenUrls: 2 });
  for (const cssFile of stylesheets) {
    const css = await readFile(cssFile, "utf8");
    const url = /url\("([^"]+)"\)/.exec(css)[1];
    const resolved = new URL(url, pathToFileURL(cssFile));
    assert.equal(resolved.search, "?v=1");
    assert.equal(resolved.hash, "#face");
    assert.equal(fileURLToPath(resolved), media);
    await access(fileURLToPath(resolved));
  }
  assert.deepEqual(await normalizeExportedCssAssets(exportDirectory), { rewrittenFiles: 0, rewrittenUrls: 0 });
  assert.equal(await readFile(path.join(exportDirectory, "index.html"), "utf8"), "HTML stays unchanged");
});

test("only incorrect relative media URLs change, preserving other URLs and literal strings", () => {
  const cssFile = path.resolve("fixture/out/_next/static/css/math.css");
  const exportDirectory = path.resolve("fixture/out");
  const unchanged = [
    "url(../media/a.woff2)", "url('/_next/static/media/a.woff2')", "url(data:font/woff2;base64,AAA)",
    "url(https://example.test/_next/static/media/a.woff2)", "url(//example.test/a.woff2)",
    "url(images/a.png)", "url(_next/static/chunks/a.js)", "url(_next/static/media/../a.woff2)",
  ];
  const css = '/* url(_next/static/media/comment.woff2) */\n.a {\n  content: "url(_next/static/media/literal.woff2)";\n'
    + unchanged.map((url, i) => `  --valid${i}: ${url};\n`).join("")
    + "  src: url(_next/static/media/a.woff2), URL( './_next/static/media/b.woff2' );\n}\n";
  const result = normalizeExportedCssAssetUrls(css, { cssFile, exportDirectory });
  assert.equal(result.rewrittenUrls, 2);
  assert.equal(result.css, css.replace("url(_next/static/media/a.woff2)", "url(../media/a.woff2)")
    .replace("URL( './_next/static/media/b.woff2' )", "URL( '../media/b.woff2' )"));
  assert.deepEqual(normalizeExportedCssAssetUrls(result.css, { cssFile, exportDirectory }), { css: result.css, rewrittenUrls: 0 });
});

test("a CSS file in the export root already resolves its relative media URL correctly", () => {
  const exportDirectory = path.resolve("fixture/out");
  const css = "@font-face{src:url(_next/static/media/a.woff2)}";
  assert.deepEqual(normalizeExportedCssAssetUrls(css, { cssFile: path.join(exportDirectory, "root.css"), exportDirectory }),
    { css, rewrittenUrls: 0 });
});

test("a missing static export is harmless for main-only builds", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sigma-missing-export-"));
  try {
    assert.deepEqual(await normalizeExportedCssAssets(path.join(directory, "absent")), { rewrittenFiles: 0, rewrittenUrls: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
