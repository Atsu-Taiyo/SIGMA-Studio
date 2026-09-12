"use client";

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Graph2DSpec } from "@/features/document";
import { graphParameterAnimationOverridesAt, graphVideoAnimationParameters, graphVideoDurationMs } from "@/features/drawing";
import { resolveGraph2DParameters } from "@/features/rendering/core";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import type { MathRenderEnvironment } from "@/lib/math-environment";
import { canvasVideoPixelSize, recordCanvasVideo } from "../canvas-video";
import { Graph2DPreview } from "./Graph2DPreview";
import { MathEnvironmentValueProvider } from "./MathEnvironment";

const tShape = createCurrentLocaleTranslator("shape");
const SVG_NS = "http://www.w3.org/2000/svg";

/** Render the canonical graph off-screen; neither playback nor export changes the document. */
export async function recordGraph2DAnimationVideo(options: {
  spec: Graph2DSpec;
  mathEnvironment: MathRenderEnvironment;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}) {
  const { spec, mathEnvironment, signal, onProgress } = options;
  const parameters = graphVideoAnimationParameters(spec.parameters ?? []);
  if (parameters.length === 0) throw new Error(tShape("graph3d.noAnimatableParameters"));
  signal?.throwIfAborted();
  const durationMs = graphVideoDurationMs(parameters);
  const { pixelWidth, pixelHeight } = canvasVideoPixelSize(spec.width, spec.height);
  const canvas = document.createElement("canvas");
  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error(tShape("graph3d.videoFrameFailed"));

  const stage = document.createElement("div");
  stage.dataset.graphVideoStage = "true";
  stage.className = "graph-shape";
  stage.setAttribute("aria-hidden", "true");
  Object.assign(stage.style, {
    position: "fixed", left: "-10000px", top: "0", pointerEvents: "none",
    width: `${spec.width}px`, height: `${spec.height}px`,
  });
  document.body.append(stage);
  const root = createRoot(stage);
  const render = (timeMs: number) => {
    const overrides = graphParameterAnimationOverridesAt(parameters, timeMs);
    const frameSpec = resolveGraph2DParameters({ ...spec, parameters: spec.parameters?.map((parameter) => ({
      ...parameter, value: overrides[parameter.name] ?? parameter.value,
    })) });
    flushSync(() => root.render(
      <MathEnvironmentValueProvider environment={mathEnvironment}>
        <Graph2DPreview spec={frameSpec} disableCropInteraction idSeed="graph-video" />
      </MathEnvironmentValueProvider>,
    ));
    const svg = stage.querySelector("svg");
    if (!svg) throw new Error(tShape("graph3d.videoFrameFailed"));
    return svg;
  };
  try {
    render(0);
    await whileActive(document.fonts.ready, signal);
    const css = await graphVideoCss(signal);
    const drawFrame = async (timeMs: number) => {
      signal?.throwIfAborted();
      const source = render(timeMs);
      const svg = source.cloneNode(true) as SVGSVGElement;
      svg.setAttribute("xmlns", SVG_NS);
      svg.setAttribute("width", String(pixelWidth));
      svg.setAttribute("height", String(pixelHeight));
      svg.style.width = `${pixelWidth}px`;
      svg.style.height = `${pixelHeight}px`;
      const style = document.createElementNS(SVG_NS, "style");
      style.textContent = css;
      svg.prepend(style);
      // External styles can depend on editor ancestors. Resolve SVG paints here, including
      // author colors and local marker/clip references; KaTeX keeps its own layout stylesheet.
      const originals = [source, ...source.querySelectorAll<SVGElement>("*")];
      const clones = [svg, ...svg.querySelectorAll<SVGElement>("*:not(style)")];
      originals.forEach((element, index) => {
        if (!(element instanceof SVGElement)) return;
        // Supersampling should enlarge strokes along with the graph, unlike editor zoom.
        clones[index].removeAttribute("vector-effect");
        const computed = getComputedStyle(element);
        for (const property of ["fill", "stroke", "stroke-width", "stroke-dasharray", "color", "font-size", "font-family", "overflow"]) {
          clones[index].style.setProperty(property, computed.getPropertyValue(property));
        }
      });
      // Modeled after the canvas editor’s export interaction pattern (reference only): a data URL avoids
      // Chromium tainting canvases drawn from blob SVGs containing foreignObject math labels.
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
      await whileActive(image.decode(), signal);
      signal?.throwIfAborted();
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, pixelWidth, pixelHeight);
      context.drawImage(image, 0, 0, pixelWidth, pixelHeight);
    };
    await drawFrame(0);
    const recording = await recordCanvasVideo({ canvas, durationMs, drawFrame, signal, onProgress });
    return { ...recording, pixelWidth, pixelHeight, durationMs };
  } finally {
    root.unmount();
    stage.remove();
  }
}

/** Fonts/image decoding may finish after the panel closes; release the export stage immediately. */
function whileActive<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    if (signal.aborted) abort();
  });
}

/** SVG images cannot load stylesheet/font URLs. Embed the graph and KaTeX styles once per run. */
async function graphVideoCss(signal?: AbortSignal): Promise<string> {
  const rules: CSSRule[] = [];
  const collect = (list: CSSRuleList) => {
    for (const rule of list) {
      // CSSStyleRule also exposes cssRules in browsers with CSS nesting support.
      // Keep the rule itself: recursing alone would drop every KaTeX layout rule.
      if (rule instanceof CSSStyleRule || rule instanceof CSSFontFaceRule) rules.push(rule);
      else if ("cssRules" in rule) collect((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try { collect(sheet.cssRules); } catch { /* Unrelated cross-origin stylesheets are not graph styles. */ }
  }
  return (await Promise.all(rules.map(async (rule) => {
    if (rule instanceof CSSFontFaceRule && rule.style.getPropertyValue("font-family").includes("KaTeX")) {
      const src = rule.style.getPropertyValue("src");
      const match = /url\(["']?([^"')]+\.woff2(?:\?[^"')]*)?)["']?\)/u.exec(src);
      if (!match) return "";
      const response = await fetch(new URL(match[1], rule.parentStyleSheet?.href ?? document.baseURI), { signal });
      if (!response.ok) throw new Error(tShape("graph3d.videoFrameFailed"));
      const blob = await response.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error(tShape("graph3d.videoFrameFailed")));
        reader.readAsDataURL(blob);
      });
      return `@font-face{font-family:${rule.style.getPropertyValue("font-family")};font-style:${rule.style.getPropertyValue("font-style")};font-weight:${rule.style.getPropertyValue("font-weight")};src:url("${dataUrl}") format("woff2");}`;
    }
    return rule instanceof CSSStyleRule && /\.katex|\.graph2d-/u.test(rule.selectorText) ? rule.cssText : "";
  }))).join("\n");
}
