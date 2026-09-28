import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { renderTikz } from "./tikz-renderer";
import { EMPTY_TIKZ_ENVIRONMENT } from "../src/features/document/tikz";

let directory: string;
let workerPath: string;
beforeAll(async () => {
  const root = path.resolve(process.cwd(), "../../tmp");
  await mkdir(root, { recursive: true });
  directory = await mkdtemp(path.join(root, "tikz-test-"));
  workerPath = path.join(directory, "worker.cjs");
  await build({ entryPoints: [path.resolve("electron/tikz-worker.ts")], outfile: workerPath, bundle: true, packages: "external", platform: "node", format: "cjs" });
});
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe("isolated TikZ renderer", () => {
  it.each(["snippet", "document"])("renders Latex arrows with an empty saved environment (%s)", async (kind) => {
    const snippet = String.raw`\begin{tikzpicture}
\draw[-Latex] (-1,0) -- (3,0) node[right] {$x$};
\draw[-Latex] (0,-1) -- (0,2) node[above] {$y$};
\draw[thick] (0,0) circle (1);
\end{tikzpicture}`;
    // Existing images persist an empty library list; changing UI defaults alone would
    // leave those images broken on re-edit. The compile environment must supply it.
    const input = JSON.parse(JSON.stringify({
      source: kind === "document" ? `\\documentclass{standalone}\n\\begin{document}\n${snippet}\n\\end{document}` : snippet,
      environment: EMPTY_TIKZ_ENVIRONMENT,
    }));
    const result = await renderTikz(input, { workerPath });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(Buffer.from(result.image.src.split(",")[1], "base64").toString()).toContain("<path");
    expect(input.environment.libraries).toBe("");
  });

  it("renders paths and embeds math fonts for offline images", async () => {
    const result = await renderTikz({ source: String.raw`\begin{tikzpicture}\draw[->] (0,0) -- (2,0) node[right] {$x^2$};\end{tikzpicture}`, environment: EMPTY_TIKZ_ENVIRONMENT }, { workerPath });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const svg = Buffer.from(result.image.src.split(",")[1], "base64").toString();
    expect(svg).toContain("<path");
    expect(svg).toContain("data:font/ttf;base64,");
    expect(svg).not.toContain("@import");
    expect(result.image.width).toBeGreaterThan(50);
  });

  it("compiles a package, a library and a custom environment", async () => {
    const result = await renderTikz({ source: String.raw`\begin{diagram}\draw[Latex-Latex] (0,0) -- (2,1) node {$\mathbb{R}$};\end{diagram}`, environment: {
      packages: String.raw`\usepackage{amssymb}`, libraries: "arrows.meta",
      preamble: String.raw`\newenvironment{diagram}{\begin{tikzpicture}}{\end{tikzpicture}}`,
    } }, { workerPath });
    expect(result).toMatchObject({ ok: true });
  });

  it("returns compiler errors, then successfully renders a corrected input", async () => {
    const input = { source: String.raw`\begin{tikzpicture}\doesnotexist;\end{tikzpicture}`, environment: EMPTY_TIKZ_ENVIRONMENT };
    expect(await renderTikz(input, { workerPath })).toMatchObject({ ok: false });
    expect(await renderTikz({ ...input, source: String.raw`\begin{tikzpicture}\draw (0,0) circle (1);\end{tikzpicture}` }, { workerPath })).toMatchObject({ ok: true });
  });

  it("terminates runaway TeX and releases the render slot", async () => {
    const result = await renderTikz({ source: String.raw`\def\forever{\forever}\forever`, environment: EMPTY_TIKZ_ENVIRONMENT }, { workerPath, timeoutMs: 300 });
    expect(result).toEqual({ ok: false, error: "timeout" });
    expect(await renderTikz(null, { workerPath })).toEqual({ ok: false, error: "invalid-input" });
  });

  it("reports unsupported Unicode labels instead of inserting an incomplete image", async () => {
    const result = await renderTikz({ source: String.raw`\begin{tikzpicture}\node {原点};\end{tikzpicture}`, environment: EMPTY_TIKZ_ENVIRONMENT }, { workerPath });
    expect(result).toEqual({ ok: false, error: "unsupported-unicode" });
  });
});
