#!/usr/bin/env node
// build/icon.svg から配布用のアイコン素材一式を生成する。
//
//   build/icon.svg  →  build/icon.png  (1024px, Linux/`app.dock.setIcon()`/BrowserWindow)
//                   →  build/icon.icns (macOS, electron-builder `mac.icon`)
//                   →  build/icon.ico  (Windows, electron-builder `win.icon`)
//
// 実行: npm run icons:generate   (apps/desktop から)
//
// icns の組み立てには macOS の `iconutil` が要る。macOS 以外で走らせた場合は
// icns だけ skip して png/ico は生成する（既存の icns はそのまま残る）。
import { Resvg } from "@resvg/resvg-js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BUILD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "build");
const SVG_PATH = path.join(BUILD_DIR, "icon.svg");

// macOS の iconset が要求する固定の並び。@2x は論理サイズの倍解像度。
const ICNS_ENTRIES = [
  { name: "icon_16x16.png", px: 16 },
  { name: "icon_16x16@2x.png", px: 32 },
  { name: "icon_32x32.png", px: 32 },
  { name: "icon_32x32@2x.png", px: 64 },
  { name: "icon_128x128.png", px: 128 },
  { name: "icon_128x128@2x.png", px: 256 },
  { name: "icon_256x256.png", px: 256 },
  { name: "icon_256x256@2x.png", px: 512 },
  { name: "icon_512x512.png", px: 512 },
  { name: "icon_512x512@2x.png", px: 1024 },
];

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const svg = readFileSync(SVG_PATH);
const renderCache = new Map();

function render(px) {
  const cached = renderCache.get(px);
  if (cached) {
    return cached;
  }
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: px },
    background: "rgba(0,0,0,0)",
  })
    .render()
    .asPng();
  renderCache.set(px, png);
  return png;
}

/**
 * ICO は「PNGをそのまま格納する」形式が Windows Vista 以降で使える。
 * ヘッダ(6) + ディレクトリ(16×n) + PNG本体の連結だけで済むので、
 * 変換ツールへの依存を増やさずにここで組み立てる。
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, index) => {
    const entry = directory.subarray(index * 16, index * 16 + 16);
    // 256px は 0 で表現する（1バイトに収まらないため）
    entry.writeUInt8(image.px >= 256 ? 0 : image.px, 0);
    entry.writeUInt8(image.px >= 256 ? 0 : image.px, 1);
    entry.writeUInt8(0, 2); // パレット色数（トゥルーカラーは0）
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(image.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

function buildIcns(outPath) {
  const workDir = mkdtempSync(path.join(tmpdir(), "sigma-icon-"));
  const iconsetDir = path.join(workDir, "icon.iconset");
  try {
    mkdirSync(iconsetDir);
    for (const entry of ICNS_ENTRIES) {
      writeFileSync(path.join(iconsetDir, entry.name), render(entry.px));
    }
    execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", outPath], { stdio: "inherit" });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

const pngPath = path.join(BUILD_DIR, "icon.png");
writeFileSync(pngPath, render(1024));
console.log(`[icons] wrote ${path.relative(process.cwd(), pngPath)} (1024px)`);

const icoPath = path.join(BUILD_DIR, "icon.ico");
writeFileSync(icoPath, buildIco(ICO_SIZES.map((px) => ({ px, png: render(px) }))));
console.log(`[icons] wrote ${path.relative(process.cwd(), icoPath)} (${ICO_SIZES.join(", ")}px)`);

const icnsPath = path.join(BUILD_DIR, "icon.icns");
if (process.platform === "darwin") {
  buildIcns(icnsPath);
  console.log(`[icons] wrote ${path.relative(process.cwd(), icnsPath)}`);
} else {
  console.warn("[icons] iconutil is macOS only - skipped icon.icns");
}
