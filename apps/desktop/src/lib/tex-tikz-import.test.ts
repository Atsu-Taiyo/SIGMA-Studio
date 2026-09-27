import { describe, expect, it, vi } from "vitest";
import { EMPTY_TIKZ_ENVIRONMENT, type SigmaBlock } from "@/features/document";
import { parseSigmaDocument } from "./sigma-doc-schema";
import { planTexTikzPaste, renderTexTikzPaste } from "./tex-tikz-import";

const a = String.raw`\begin{tikzpicture}\draw (0,0) circle (\radius);\end{tikzpicture}`;
const b = String.raw`\begin{tikzpicture}\draw[-Latex] (0,0) -- (2,0);\end{tikzpicture}`;
const fixture = String.raw`\documentclass{article}
\usepackage{amsmath}
\usetikzlibrary{calc}
\newcommand{\radius}{1}
\begin{document}
最初の本文 $x^2$。
${a}
間の本文。
\[y=x+1\]
${b}
最後の本文。
\end{document}`;
const success = { ok: true as const, image: { src: "data:image/svg+xml;base64,PHN2Zy8+", width: 120, height: 80 } };
const blockText = (block: SigmaBlock) => "children" in block ? JSON.stringify(block.children) : "";

describe("mixed TeX and TikZ paste", () => {
  it("keeps editable text/math and separate figures in source order with shared preamble", () => {
    const plan = planTexTikzPaste(fixture, { ...EMPTY_TIKZ_ENVIRONMENT, libraries: "positioning" })!;
    expect(plan).not.toBeNull();
    expect(plan.document.content.map(block => block.type)).toEqual(["paragraph", "codeBlock", "paragraph", "paragraph", "codeBlock", "paragraph"]);
    expect(plan.document.content[0]).toMatchObject({ children: [{ text: "最初の本文 " }, { tex: "x^2" }, { text: "。" }] });
    expect(plan.figures.map(figure => figure.input.source)).toEqual([a, b]);
    for (const { input } of plan.figures) {
      expect(input.environment.packages).toContain(String.raw`\usepackage{amsmath}`);
      expect(input.environment.libraries).toBe("positioning,calc");
      expect(input.environment.preamble).toContain(String.raw`\newcommand{\radius}{1}`);
      expect(input.environment.preamble).not.toContain("documentclass");
    }
  });

  it("renders each figure at its own text anchor, reserves space and survives canonical reload", async () => {
    const plan = planTexTikzPaste(fixture)!;
    const render = vi.fn().mockResolvedValue(success);
    const result = (await renderTexTikzPaste(plan, render))!;
    const restored = parseSigmaDocument(JSON.parse(JSON.stringify(result.document)));
    expect(result.failures).toBe(0);
    expect(render).toHaveBeenCalledTimes(2);
    const snapshot = restored.pageLayout!.overlay!.overlaySnapshot!;
    expect(snapshot.shapes.map(s => s.anchor)).toEqual(plan.figures.map(f => ({ type: "block", blockId: f.blockId, dx: 0, dy: 0 })));
    expect(Object.keys(snapshot.assets)).toHaveLength(2);
    for (const { blockId } of plan.figures) {
      expect(restored.content.find(b => b.id === blockId)).toMatchObject({ type: "paragraph", spaceAfterPx: 96 });
      // Figure spacing survives reload without writing retired pagination hints.
      expect(result.document.content.find(b => b.id === blockId)?.pagination).toBeUndefined();
    }
    expect(restored.content.map(blockText).join(" ")).toContain("最後の本文");
  });

  it("retains exact failed source and shared definitions while continuing subsequent figures", async () => {
    const plan = planTexTikzPaste(fixture)!;
    const render = vi.fn().mockResolvedValueOnce({ ok: false, error: "! error" }).mockResolvedValueOnce(success);
    const result = (await renderTexTikzPaste(plan, render))!;
    expect(result.failures).toBe(1);
    expect(result.document.content[1]).toMatchObject({ type: "codeBlock", language: "latex" });
    expect(blockText(result.document.content[1])).toContain(JSON.stringify(a).slice(1, -1));
    expect(blockText(result.document.content[1])).toContain("newcommand");
    expect(result.document.pageLayout!.overlay!.overlaySnapshot!.shapes).toHaveLength(1);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("handles aggregate sources over the single-figure limit without duplicate block IDs", () => {
    const text = `${"長い本文。\n\n".repeat(15_000)}${a}\n\n${b}`;
    expect(text.length).toBeGreaterThan(100_000);
    const first = planTexTikzPaste(text)!;
    const second = planTexTikzPaste(text)!;
    expect(first.figures).toHaveLength(2);
    expect(new Set([...first.document.content, ...second.document.content].map(b => b.id)).size).toBe(first.document.content.length + second.document.content.length);
  });

  it("ignores commented diagrams, preserves comments inside real figures and balances nested environments", () => {
    const nested = String.raw`\begin{tikzpicture}
% \end{tikzpicture} is only a comment
\begin{scope}\draw (0,0) -- (1,0);\end{scope}
\end{tikzpicture}`;
    const plan = planTexTikzPaste(`% ${a}\n本文\n${nested}\n末尾`)!;
    expect(plan.figures.map(f => f.input.source)).toEqual([nested]);
    expect(blockText(plan.document.content.at(-1)!)).toContain("末尾");
    expect(planTexTikzPaste(`普通の本文\n% ${a}`)).toBeNull();
  });

  it("finds figures in problem/list/figure containers without losing their surrounding text", () => {
    const plan = planTexTikzPaste(String.raw`\begin{problem}設問。
\begin{enumerate}\item 問い。${a}説明。\item 次。\end{enumerate}
\begin{solution}解説。${b}\end{solution}
\end{problem}
\begin{figure}[h]\centering ${b}\caption{図の説明}\end{figure}`)!;
    expect(plan.figures).toHaveLength(3);
    expect(plan.document.content[0].type).toBe("problem");
    expect(JSON.stringify(plan.document.content)).toContain("図の説明");
  });

  it("cancels between sequential compiles without returning a partial document", async () => {
    const plan = planTexTikzPaste(fixture)!;
    let cancelled = false;
    const render = vi.fn(async () => { cancelled = true; return success; });
    expect(await renderTexTikzPaste(plan, render, { cancelled: () => cancelled })).toBeNull();
    expect(render).toHaveBeenCalledTimes(1);
    expect(plan.document.content[1].type).toBe("codeBlock");
  });

  it("preserves arbitrary preamble definitions, style declarations and escaped-percent comments", () => {
    const plan = planTexTikzPaste(String.raw`\documentclass[a4paper]{article}
\definecolor{diagram}{RGB}{20,30,40}
\newlength{\diagramwidth}\setlength{\diagramwidth}{1cm}
\tikzset{every path/.style={diagram}}
\begin{document}
50\% % \begin{tikzpicture} fake
${a}
${b}
\end{document}`)!;
    expect(plan.figures).toHaveLength(2);
    const env = plan.figures[0].input.environment;
    expect(env.preamble).toContain(String.raw`\definecolor{diagram}{RGB}{20,30,40}`);
    expect(env.preamble).toContain(String.raw`\setlength{\diagramwidth}{1cm}`);
    expect(env.preamble).toContain(String.raw`\tikzset{every path/.style={diagram}}`);
    expect(plan.figures[0].input.source).toBe(a);
  });

  it("bounds figure dimensions and keeps consecutive figures and list-first figures distinct", async () => {
    const plan = planTexTikzPaste(String.raw`\begin{enumerate}\item ${a}${b}\item 次。\end{enumerate}`)!;
    expect(plan.figures).toHaveLength(2);
    const result = (await renderTexTikzPaste(plan, async () => ({ ...success, image: { ...success.image, width: 1000, height: 2000 } })))!;
    const restored = parseSigmaDocument(JSON.parse(JSON.stringify(result.document)));
    expect(restored.pageLayout!.overlay!.overlaySnapshot!.shapes).toHaveLength(2);
    for (const shape of restored.pageLayout!.overlay!.overlaySnapshot!.shapes) {
      expect(shape.type === "image" && shape.props.h).toBeLessThanOrEqual(360);
    }
  });

  it("preserves the entire source if an unclosed diagram makes its boundary ambiguous", async () => {
    const source = `${a}\n本文\n\\begin{tikzpicture}\\draw (0,0) -- (1,0);`;
    const plan = planTexTikzPaste(source)!;
    const render = vi.fn().mockResolvedValue(success);
    const result = (await renderTexTikzPaste(plan, render))!;
    expect(result.document.content).toMatchObject([{ type: "codeBlock", children: [{ text: source }] }]);
    expect(result.failures).toBeGreaterThan(0);
    expect(render).not.toHaveBeenCalled();
  });

  it("does not alter declarations inside an unsupported surrounding environment", () => {
    const unsupported = String.raw`\begin{custombox}\tikzset{every path/.style={blue}}${a}\end{custombox}`;
    const plan = planTexTikzPaste(`${unsupported}\n${b}`)!;
    expect(plan.document.content[0]).toMatchObject({ type: "codeBlock", children: [{ text: unsupported }] });
    expect(plan.figures).toHaveLength(1);
    expect(plan.figures[0].input.environment.preamble).not.toContain("blue");
  });

  it("serializes many figures, reports progress, and continues after a rejected render", async () => {
    const plan = planTexTikzPaste(Array.from({ length: 32 }, (_, i) => `本文 ${i}。\n${b}`).join("\n"))!;
    let active = 0;
    let maximum = 0;
    let calls = 0;
    const progress = vi.fn();
    const result = (await renderTexTikzPaste(plan, async () => {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      if (++calls === 12) throw new Error("worker unavailable");
      return success;
    }, { onProgress: progress, imageWidthLimit: 60 }))!;
    const restored = parseSigmaDocument(JSON.parse(JSON.stringify(result.document)));
    const shapes = restored.pageLayout!.overlay!.overlaySnapshot!.shapes;
    expect(maximum).toBe(1);
    expect(shapes).toHaveLength(31);
    expect(new Set(shapes.map(s => s.id)).size).toBe(31);
    expect(shapes.every(s => s.type === "image" && s.props.w === 60)).toBe(true);
    expect(result.failures).toBe(1);
    expect(progress).toHaveBeenLastCalledWith(32, 32);
  });

  it("does not consume grouped text after a macro declaration", () => {
    const plan = planTexTikzPaste(String.raw`\newcommand{\radius}{1}{残す本文。}${a}${b}`)!;
    expect(plan.figures[0].input.environment.preamble).toBe(String.raw`\newcommand{\radius}{1}`);
    expect(JSON.stringify(plan.document.content)).toContain("残す本文");
  });
});
