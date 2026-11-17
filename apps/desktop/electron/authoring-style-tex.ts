import type { StyleExample } from "./authoring-style-features";

interface Formula { tex: string; display: boolean; outside: string }
const spacing = /\\(?:(?:qquad|quad)(?![a-zA-Z])|[,;:!])/g;
const environment = /\\(?:begin|end)\{(?:aligned|align\*?|equation\*?)\}/g;
const vector = /\\(?:vec|overrightarrow|mathbf|boldsymbol|bm)(?![a-zA-Z])/g;
const units = "(?:cm|mm|km|kg|mg|ms|mol|Hz|Pa|m|g|s|K|N|J|W|V|A)";
const uprightUnit = new RegExp(String.raw`\\mathrm\{(${units})\}`, "g");

/** Read only the bounded saved projection, including delimiters in text runs. */
export function formulas(fragment: StyleExample["before"]): Formula[] {
  if (!fragment || fragment.format.length > 1800) return [];
  let runs: unknown;
  try { runs = JSON.parse(fragment.format).runs; } catch { return []; }
  if (!Array.isArray(runs)) return [];
  const result: Formula[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!run || typeof run !== "object") continue;
    if (run.type === "mathInline" && typeof run.tex === "string") {
      const next = runs[i + 1];
      result.push({ tex: run.tex, display: run.display === true || run.display === "display" || run.display === "block",
        outside: next?.type === "text" && typeof next.text === "string" ? next.text.match(/^\s*([,.。、])/u)?.[1] ?? "" : "" });
    } else if (run.type === "text" && typeof run.text === "string") {
      // Never treat ordinary prose as TeX. Only explicit, balanced math delimiters.
      const pattern = /\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\\begin\{(equation\*?|align\*?)\}([\s\S]*?)\\end\{\3\}|(?<![\\$])\$(?!\$)([^$\n]+)\$(?!\$)|\\\(([\s\S]*?)\\\)/g;
      for (const match of run.text.matchAll(pattern)) {
        const tex = match[1] ?? match[2] ?? (match[3] ? `\\begin{${match[3]}}${match[4]}\\end{${match[3]}}` : match[5] ?? match[6]);
        result.push({ tex, display: match[1] !== undefined || match[2] !== undefined || Boolean(match[3]),
          outside: run.text.slice(match.index! + match[0].length).match(/^\s*([,.。、])/u)?.[1] ?? "" });
      }
    }
  }
  return result;
}

/** Conservative notation equivalence, not symbolic algebra. Keep values, variables,
 * operators and partial-vs-ordinary derivatives. Unknown syntax stays distinct. */
function identity(formula: Formula): string {
  return (formula.tex + formula.outside)
    .replace(/\\(?:dfrac|tfrac|frac)(?![a-zA-Z])/g, "\\frac")
    .replace(/\\(?:left|right)(?![a-zA-Z])/g, "")
    .replace(/\\(?:cdot|times)(?![a-zA-Z])|[×·]/g, "\\multiply")
    .replace(spacing, "").replace(environment, "").replace(/&|\\\\/g, "")
    .replace(vector, "\\vector")
    .replace(/\\mathrm\{d\}(?=\s*(?:[a-zA-Z]|\\[a-zA-Z]))/g, "d")
    .replace(uprightUnit, "$1")
    .replace(/\\[\[\]()]|\$\$/g, "").replace(/\s+/g, "");
}

/** Fixed labels only: never emit problem-specific formulas or units as prose. */
function features(formula: Formula): Map<string, string> {
  const tex = formula.tex;
  const result = new Map<string, string>();
  const commands = (pattern: RegExp) => [...new Set(tex.match(pattern) ?? [])].sort().join(" / ");
  const put = (key: string, value: string) => { if (value) result.set(key, value); };
  put("fraction", commands(/\\(?:dfrac|tfrac|frac)(?![a-zA-Z])/g));
  result.set("display", formula.display || /\\\[|\$\$|\\begin\{(?:equation|align)\*?\}/.test(tex) ? "display" : "inline");
  if (/[()[\]]|\\[{}]/.test(tex)) result.set("brackets", /\\left(?![a-zA-Z])/.test(tex) && /\\right(?![a-zA-Z])/.test(tex) ? "scalable" : "fixed");
  put("multiply", commands(/\\(?:cdot|times)(?![a-zA-Z])|[×·]/g));
  result.set("spacing", commands(spacing) || "none");
  result.set("alignment", commands(/\\begin\{(?:aligned|align\*?)\}/g) || "none");
  put("vector", commands(vector));
  put("differential", /\\mathrm\{d\}(?=\s*(?:[a-zA-Z]|\\[a-zA-Z]))/.test(tex) ? "\\mathrm{d}" : /(?:^|[^a-zA-Z\\])d\s*[a-zA-Z](?![a-zA-Z])/.test(tex) ? "d" : /\\partial(?![a-zA-Z])/.test(tex) ? "\\partial" : "");
  if (uprightUnit.test(tex)) result.set("units", "upright");
  uprightUnit.lastIndex = 0;
  const plainUnit = new RegExp(String.raw`\d\s*(?:\\[,;:]\s*)?${units}(?![a-zA-Z])`);
  if (!result.has("units") && plainUnit.test(tex)) result.set("units", "plain");
  if (/[,.。、]\s*$/.test(tex)) result.set("punctuation", "inside");
  else if (formula.outside) result.set("punctuation", "outside");
  return result;
}

export function changedTexFeatures(example: StyleExample): Map<string, Set<string>> {
  const before = formulas(example.before);
  const after = formulas(example.after);
  const result = new Map<string, Set<string>>();
  // Match by notation-neutral content, never by index after insertion/reordering.
  // Ambiguous repeated formulas and additions/deletions are not evidence.
  for (const current of after) {
    const key = identity(current);
    const originals = before.filter(f => identity(f) === key);
    if (originals.length !== 1 || after.filter(f => identity(f) === key).length !== 1) continue;
    const previous = features(originals[0]);
    for (const [category, value] of features(current)) {
      if (!previous.has(category) || previous.get(category) === value) continue;
      const values = result.get(category) ?? new Set<string>();
      values.add(value);
      result.set(category, values);
    }
  }
  return result;
}
