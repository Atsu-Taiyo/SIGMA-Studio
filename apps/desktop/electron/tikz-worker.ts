import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import path from "node:path";
import tex2svg from "node-tikzjax";
import { JSDOM } from "jsdom";
import { isTikzImageSource, prepareTikzInput } from "../src/features/document/tikz";

async function run() {
  if (!isTikzImageSource(workerData)) throw new Error("invalid-input");
  let log = "";
  // The engine's diagnostics are returned only to this dialog, never written to app logs.
  console.log = (...values: unknown[]) => { log = (log + values.join(" ") + "\n").slice(-12_000); };
  let svg: string;
  try {
    svg = await tex2svg(prepareTikzInput(workerData), { showConsole: true });
  } catch {
    if (/Unicode character/.test(log)) throw new Error("unsupported-unicode");
    throw new Error(log.match(/![\s\S]*/)?.[0]?.slice(0, 3000) ?? "render-failed");
  }
  const diagnostic = log.match(/^![\s\S]*/m)?.[0];
  if (diagnostic) throw new Error(diagnostic.slice(0, 3000));
  if (svg.length > 4_000_000) throw new Error("image-too-large");
  const dom = new JSDOM(svg, { contentType: "image/svg+xml" });
  try {
    const root = dom.window.document.documentElement;
    const width = Number(root.getAttribute("width"));
    const height = Number(root.getAttribute("height"));
    if (root.localName !== "svg" || ![width, height].every((v) => Number.isFinite(v) && v > 0 && v <= 8192)) throw new Error("invalid-image");
    // TeX specials may emit SVG. Keep the output self-contained and passive.
    for (const element of [root, ...root.querySelectorAll("*")]) {
      if (["script", "foreignObject", "image", "style", "iframe", "animate", "set"].includes(element.localName)) throw new Error("unsupported-svg");
      for (const attr of Array.from(element.attributes)) {
        if (attr.name.startsWith("on") || /(?:href)$/i.test(attr.name) && !attr.value.startsWith("#") || /url\(/i.test(attr.value) && !/^url\(#[\w.-]+\)$/.test(attr.value)) throw new Error("unsupported-svg");
      }
    }
    const fontRoot = path.join(path.dirname(require.resolve("node-tikzjax/package.json")), "css/bakoma/ttf");
    const families = new Set(Array.from(root.querySelectorAll("[font-family]"), (node) => node.getAttribute("font-family")!));
    const css = [...families].map((family) => {
      if (!/^[a-z0-9]+$/.test(family)) throw new Error("unsupported-font");
      const font = readFileSync(path.join(fontRoot, `${family}.ttf`)).toString("base64");
      return `@font-face{font-family:${family};src:url(data:font/ttf;base64,${font}) format('truetype')}`;
    }).join("");
    if (css) {
      const style = dom.window.document.createElementNS("http://www.w3.org/2000/svg", "style");
      style.textContent = css;
      root.prepend(style);
    }
    parentPort?.postMessage({ ok: true, image: { src: `data:image/svg+xml;base64,${Buffer.from(root.outerHTML).toString("base64")}`, width, height } });
  } finally {
    dom.window.close();
  }
}

void run().catch((error: unknown) => parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : "render-failed" }));
