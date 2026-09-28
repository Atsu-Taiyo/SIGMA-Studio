import { describe, expect, it } from "vitest";
import { normalizeOverlaySnapshot, isOverlayShape, EMPTY_TIKZ_ENVIRONMENT, isTikzImageSource, prepareTikzInput, readTikzClipboardSource } from "./index";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { sampleDocument } from "@/lib/sample-document";

const source = String.raw`\begin{tikzpicture}\draw (0,0) circle (1);\end{tikzpicture}`;
const environment = { ...EMPTY_TIKZ_ENVIRONMENT, libraries: "calc", preamble: String.raw`\newcommand{\r}{2}` };

describe("TikZ source and persistence", () => {
  it("accepts raw, fenced and full documents but leaves prose alone", () => {
    expect(readTikzClipboardSource(source)).toBe(source);
    expect(readTikzClipboardSource("```tikz\n" + source + "\n``` ")).toBe(source);
    expect(readTikzClipboardSource(`\\documentclass{standalone}\n\\begin{document}${source}\\end{document}`)).not.toBeNull();
    expect(readTikzClipboardSource(`図を考える。\n${source}`)).toBeNull();
    expect(readTikzClipboardSource("ordinary text")).toBeNull();
    expect(readTikzClipboardSource(String.raw`\tikz \draw (0,0) circle (1);`)).not.toBeNull();
    expect(readTikzClipboardSource("```tikz\n\\begin{diagram}x\\end{diagram}\n```")).toBe(String.raw`\begin{diagram}x\end{diagram}`);
    expect(readTikzClipboardSource(String.raw`% \begin{tikzpicture}\end{tikzpicture}`)).toBeNull();
  });

  it("keeps snippet packages before the document and strips the supplied class", () => {
    const input = prepareTikzInput({ source: `\\documentclass[tikz]{standalone}\n\\usepackage{pgfplots}\n${source}`, environment });
    expect(input).not.toContain("documentclass");
    expect(input.indexOf("\\usepackage")).toBeLessThan(input.indexOf("\\begin{document}"));
    expect(input).toContain("\\usetikzlibrary{calc}");
    expect(input.match(/\\begin\{document\}/g)).toHaveLength(1);
  });

  it("supplies standard arrows before user definitions without changing the saved environment", () => {
    const input = { source, environment: { ...environment, preamble: String.raw`\tikzset{axis/.style={-Latex}}` } };
    const saved = JSON.stringify(input);
    const compiled = prepareTikzInput(input);
    expect(compiled).toContain(String.raw`\usetikzlibrary{arrows.meta}`);
    expect(compiled).toContain(String.raw`\usetikzlibrary{calc}`);
    expect(compiled.indexOf("arrows.meta")).toBeLessThan(compiled.indexOf(input.environment.preamble));
    expect(JSON.stringify(input)).toBe(saved);
  });

  it("retains image source and file defaults through canonical normalization and JSON reload", () => {
    const doc = structuredClone(sampleDocument);
    doc.metadata.tikzEnvironment = environment;
    const image = { id: "tikz", type: "image" as const, x: 1, y: 2, props: { assetId: "asset", w: 80, h: 60, tikz: { source, environment } } };
    expect(isOverlayShape(image)).toBe(true);
    const snapshot = normalizeOverlaySnapshot({ version: 1, shapes: [image], assets: {} });
    expect(snapshot.shapes[0]).toEqual(image);
    expect(parseSigmaDocument(JSON.parse(JSON.stringify(doc))).metadata.tikzEnvironment).toEqual(environment);
    expect(normalizeOverlaySnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it("bounds source and rejects invalid environment data without affecting regular images", () => {
    expect(isTikzImageSource({ source: "x".repeat(100_001), environment })).toBe(false);
    expect(isTikzImageSource({ source, environment: { ...environment, packages: 2 } })).toBe(false);
    expect(isOverlayShape({ id: "img", type: "image", x: 0, y: 0, props: { assetId: "a", w: 20, h: 20 } })).toBe(true);
  });
});
