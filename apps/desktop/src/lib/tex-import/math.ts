import { readEnvironmentAt, startsWithUnescaped, findUnescaped, findInlineDollarEnd } from "./scanner";

const DISPLAY_MATH_ENVIRONMENTS = new Set([
  "aligned",
  "gathered",
  "cases",
  "matrix",
  "pmatrix",
  "bmatrix",
  "Bmatrix",
  "vmatrix",
  "Vmatrix",
  "smallmatrix",
  "equation",
  "equation*",
  "align",
  "align*",
  "gather",
  "gather*",
  "multline",
  "multline*",
  "eqnarray",
  "eqnarray*",
]);

/** A complete math span is opaque to document/list/area scanners. */
export function readMathAt(source: string, index: number): { tex: string; display: boolean; endIndex: number } | null {
  const environment = readEnvironmentAt(source, index);
  if (environment && DISPLAY_MATH_ENVIRONMENTS.has(environment.name)) {
    return { tex: normalizeMathEnvironmentTex(environment.name, environment.body), display: true, endIndex: environment.endIndex };
  }
  for (const [open, close, display] of [["$$", "$$", true], ["$", "$", false], ["\\(", "\\)", false], ["\\[", "\\]", true]] as const) {
    if (!startsWithUnescaped(source, index, open)) continue;
    const end = open === "$" ? findInlineDollarEnd(source, index + open.length) : findUnescaped(source, close, index + open.length);
    if (end >= 0) return { tex: normalizeMathTex(source.slice(index + open.length, end)), display, endIndex: end + close.length };
    return null;
  }
  return null;
}

function normalizeMathEnvironmentTex(environmentName: string, body: string): string {
  const tex = normalizeMathTex(body);
  if (/^(?:align|eqnarray)\*?$/.test(environmentName)) {
    return `\\begin{aligned}${tex}\\end{aligned}`;
  }
  if (/^gather\*?$/.test(environmentName)) {
    return `\\begin{gathered}${tex}\\end{gathered}`;
  }
  if (/^(?:cases|.*matrix|aligned|gathered)$/.test(environmentName)) {
    return `\\begin{${environmentName}}${tex}\\end{${environmentName}}`;
  }
  return tex;
}

function normalizeMathTex(tex: string): string {
  return tex
    .replace(/\\label\s*\{(?:\\.|[^{}])*\}/g, "")
    .replace(/\s*\n\s*/g, " ")
    .trim();
}
