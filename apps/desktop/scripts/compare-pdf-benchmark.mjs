#!/usr/bin/env node
// Read-only PDF parity check; rendering/validation is deliberately outside timed exports.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const [beforeRoot, afterRoot] = process.argv.slice(2);
if (!beforeRoot || !afterRoot) throw new Error("Usage: node apps/desktop/scripts/compare-pdf-benchmark.mjs BEFORE_DIR AFTER_DIR");
let checked = 0;
for (const name of readdirSync(beforeRoot).filter(name => name.startsWith("pdf-export-benchmark-"))) {
  const tasks = [beforeRoot, afterRoot].map(root => getDocument({
    data: Uint8Array.from(readFileSync(path.join(root, name, "workbook.pdf"))), verbosity: 0,
  }));
  try {
    const [before, after] = await Promise.all(tasks.map(task => task.promise));
    if (before.numPages !== after.numPages) throw new Error(`${name}: page count changed`);
    for (let index = 1; index <= before.numPages; index++) {
      const images = [];
      for (const pdf of [before, after]) {
        const page = await pdf.getPage(index);
        const viewport = page.getViewport({ scale: 1.5 });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext("2d");
        await page.render({ canvas: null, canvasContext: context, viewport }).promise;
        images.push(context.getImageData(0, 0, canvas.width, canvas.height).data);
        page.cleanup();
      }
      if (images[0].length !== images[1].length) throw new Error(`${name}: page ${index} dimensions changed`);
      let changed = 0, maxDifference = 0;
      for (let i = 0; i < images[0].length; i++) {
        const difference = Math.abs(images[0][i] - images[1][i]);
        if (difference) changed++;
        maxDifference = Math.max(maxDifference, difference);
      }
      if (changed) throw new Error(`${name}: page ${index}: ${changed} channel values differ, max=${maxDifference}`);
      checked++;
    }
    console.log(`${name}: ${before.numPages} pages pixel-identical at 108dpi`);
  } finally { await Promise.all(tasks.map(task => task.destroy())); }
}
if (!checked) throw new Error("No benchmark PDFs found");
console.log(`Verified ${checked} pages`);
