import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { PDFDocument, rgb } from "pdf-lib";
import { afterEach, describe, expect, it } from "vitest";
import { renderAttachedPdfPages } from "./ai-edit-pdf";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("renderAttachedPdfPages", () => {
  it("preserves text, scanned images, and later pages without truncating the PDF", async () => {
    const pdf = await PDFDocument.create();
    const scan = createCanvas(80, 80);
    scan.getContext("2d").fillStyle = "#ff0000";
    scan.getContext("2d").fillRect(0, 0, 80, 80);
    const scanImage = await pdf.embedPng(scan.toBuffer("image/png"));
    for (let number = 1; number <= 5; number += 1) {
      const page = pdf.addPage([200, 300]);
      if (number === 2) page.drawImage(scanImage, { x: 60, y: 100, width: 80, height: 80 });
      else page.drawText(`Worksheet page ${number}`, { x: 20, y: 240, size: 12, color: rgb(0, 0, 0) });
    }
    const bytes = await pdf.save();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-ai-pdf-"));
    directories.push(directory);
    const writePage = async (pageNumber: number, png: Buffer) => {
      const file = path.join(directory, `${pageNumber}.png`);
      await fs.writeFile(file, png);
      return file;
    };
    const first = await renderAttachedPdfPages(bytes, { pageStart: 1, writePage });
    expect(first.pageCount).toBe(5);
    expect(first.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3, 4]);
    expect(first.nextPageStart).toBe(5);
    expect(first.pages[0].text).toContain("Worksheet page 1");
    expect(first.pages[1].text.trim()).toBe("");
    const image = await loadImage(first.pages[1].previewFile);
    const decoded = createCanvas(image.width, image.height);
    decoded.getContext("2d").drawImage(image, 0, 0);
    const pixel = decoded.getContext("2d").getImageData(200, 320, 1, 1).data;
    expect([...pixel]).toEqual([255, 0, 0, 255]);
    const last = await renderAttachedPdfPages(bytes, { pageStart: first.nextPageStart!, writePage });
    expect(last.pages.map((page) => page.pageNumber)).toEqual([5]);
    expect(last.pages[0].text).toContain("Worksheet page 5");
    expect(last.nextPageStart).toBeNull();
    await expect(renderAttachedPdfPages(bytes, { pageStart: 6, writePage })).rejects.toThrow("5ページ");
  });

  it("reports invalid PDFs and invalid page numbers instead of returning empty success", async () => {
    const writePage = async () => "unused.png";
    await expect(renderAttachedPdfPages(new Uint8Array([1, 2, 3]), { pageStart: 1, writePage })).rejects.toThrow();
    await expect(renderAttachedPdfPages(new Uint8Array(), { pageStart: 0, writePage })).rejects.toThrow("pageStart");
  });
});
