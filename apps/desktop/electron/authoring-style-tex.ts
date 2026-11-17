import type { StyleExample } from "./authoring-style-features";

export interface Formula { tex: string; display: boolean; outside: string }
type Patterns = readonly (readonly [RegExp, string])[];
const command = (name: string) => new RegExp(String.raw`\\${name}(?![a-zA-Z])`);
const NUMBER_SET = /\\(mathbb|mathbf|bm|boldsymbol)\s*\{\s*([NZQRC])\s*\}/g;

/**
 * Notations that are a plain choice between commands. The same table reads the
 * author's own formulas and tells which command a correction switched to.
 */
export const TOKEN_HABITS: readonly (readonly [category: string, patterns: Patterns])[] = [
  ["ellipsis", [[command("cdots"), "\\cdots"], [command("ldots"), "\\ldots"], [command("dots"), "\\dots"]]],
  ["arrow", [[command("to"), "\\to"], [command("rightarrow"), "\\rightarrow"]]],
  ["implies", [[command("Rightarrow"), "\\Rightarrow"], [command("Longrightarrow"), "\\Longrightarrow"], [command("implies"), "\\implies"]]],
  ["iff", [[command("Leftrightarrow"), "\\Leftrightarrow"], [command("Longleftrightarrow"), "\\Longleftrightarrow"], [command("iff"), "\\iff"]]],
  ["approx", [[/\\fallingdotseq(?![a-zA-Z])|≒/, "\\fallingdotseq"], [command("approx"), "\\approx"], [command("simeq"), "\\simeq"]]],
  ["overline", [[command("overline"), "\\overline"], [command("bar"), "\\bar"]]],
  ["numberSet", [[/\\mathbb\s*\{\s*[NZQRC]\s*\}/, "\\mathbb"], [/\\(?:mathbf|bm|boldsymbol)\s*\{\s*[NZQRC]\s*\}/, "\\mathbf"]]],
];
const TOKEN_NEUTRAL = TOKEN_HABITS.filter(([category]) => category !== "numberSet")
  .map(([category, patterns]) => [new RegExp(patterns.map(([pattern]) => pattern.source).join("|"), "g"), `\\${category}`] as const);
/** The one notation a formula uses for a habit; nothing when it mixes two. */
const only = (tex: string, patterns: Patterns): string[] => {
  const used = patterns.filter(([pattern]) => pattern.test(tex)).map(([, value]) => value);
  return used.length === 1 ? used : [];
};
const spacing = /\\(?:(?:qquad|quad)(?![a-zA-Z])|[,;:!])/g;
const environment = /\\(?:begin|end)\{(?:aligned|align\*?|equation\*?)\}/g;
const vector = /\\(?:vec|vv|overrightarrow|mathbf|boldsymbol|bm)(?![a-zA-Z])/g;
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
  let tex = (formula.tex + formula.outside).replace(NUMBER_SET, "\\numberSet{$2}");
  for (const [pattern, neutral] of TOKEN_NEUTRAL) tex = tex.replace(pattern, neutral);
  return tex
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
  // A bold number set is not a vector.
  const tex = formula.tex.replace(NUMBER_SET, "");
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
  for (const [category, patterns] of TOKEN_HABITS) put(category, only(formula.tex, patterns)[0] ?? "");
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

const D = String.raw`(?:d|\\mathrm\{d\})`;
const POWER = String.raw`(?:\^\{?\d\}?)?`;
const LEIBNIZ = new RegExp(String.raw`\\[dt]?frac\{\s*${D}\s*${POWER}\s*[a-zA-Z]\s*\}\{\s*${D}\s*[a-zA-Z]`);
const OPERATOR = new RegExp(String.raw`\\[dt]?frac\{\s*${D}\s*${POWER}\s*\}\{\s*${D}\s*[a-zA-Z]`);
const NUMBER_MARK = String.raw`(?:\\cdots|\\dots|…|\\qquad|\\quad)\s*(?:\\text\{)?\s*`;
const LONG_UNITS = "(?:cm|mm|km|kg|mg|mol|Hz|Pa)";
const TALL = String.raw`\\(?:[dt]?frac|sum|int|prod)(?![a-zA-Z])`;

type Habit = readonly [key: string, read: (formula: Formula, tex: string) => string[], inlineOnly?: boolean];
const choice = (patterns: Patterns) => (_: Formula, tex: string) => only(tex, patterns);

/**
 * How the author's own formulas are written. Each reader returns the single
 * notation one formula uses, as a command name or a fixed label, never as text
 * from the formula. `tex` has number sets removed so a bold R is not a vector.
 */
const WRITING_HABITS: readonly Habit[] = [
  ["fraction", choice([[command("dfrac"), "\\dfrac"], [command("tfrac"), "\\tfrac"], [command("frac"), "\\frac"]]), true],
  ["multiply", choice([[command("cdot"), "\\cdot"], [command("times"), "\\times"]])],
  ["vector", choice([[command("vec"), "\\vec"], [command("overrightarrow"), "\\overrightarrow"], [command("vv"), "\\vv"],
    [/\\(?:mathbf|boldsymbol|bm)(?![a-zA-Z])/, "\\mathbf / \\bm"]])],
  ["inequality", choice([[/\\[lg]eqq(?![a-zA-Z])/, "\\leqq / \\geqq"], [/\\[lg]eqslant(?![a-zA-Z])/, "\\leqslant / \\geqslant"], [/\\[lg]eq?(?![a-zA-Z])/, "\\leq / \\geq"]])],
  ["differential", choice([[/\\int[\s\S]*\\mathrm\{d\}\s*[a-zA-Z]/, "\\mathrm{d}"], [/\\int[\s\S]*[^a-zA-Z\\{]d\s*[a-zA-Z](?![a-zA-Z])/, "d"]])],
  ["derivative", choice([[LEIBNIZ, "leibniz"], [OPERATOR, "operator"], [/(?<![\\a-zA-Z])[a-z]\s*(?:'+|\^\{?\\prime\}?)/, "prime"]])],
  ["combination", choice([[/\{\}_\{?[^{}]+\}?\s*\\mathrm\{C\}\s*_/, "upright"], [/\{\}_\{?[^{}]+\}?\s*C\s*_/, "italic"], [/\\[dt]?binom(?![a-zA-Z])/, "binom"]])],
  ["equationNumber", choice([[/\\tag\*?\{/, "tag"], [new RegExp(String.raw`${NUMBER_MARK}[①-⑳]\s*\}?\s*$`), "circled"],
    [new RegExp(String.raw`${NUMBER_MARK}[(（]\d+[)）]\s*\}?\s*$`), "parenthesized"]])],
  // Where a long equation goes. Short formulas sit in the sentence for everyone.
  ["longEquation", (formula, tex) => tex.includes("=") && tex.replace(/\s+/g, "").length >= 30 ? [formula.display ? "display" : "inline"] : []],
  ["inlineSize", (_, tex) => {
    if (!/\\(?:sum|int|lim|prod)(?![a-zA-Z])/.test(tex)) return [];
    const used = [command("displaystyle"), command("limits")].map(pattern => pattern.test(tex));
    return used[0] && used[1] ? [] : [used[0] ? "\\displaystyle" : used[1] ? "\\limits" : "none"];
  }, true],
  ["integralSpacing", (_, tex) => {
    // One choice per integral: a formula that spaces one dx and not another shows no preference.
    const differentials = tex.match(new RegExp(String.raw`(?<![a-zA-Z\\{])${D}\s*[a-zA-Z](?![a-zA-Z])`, "g"))?.length ?? 0;
    const spaced = tex.match(new RegExp(String.raw`\\[,;:]\s*${D}\s*[a-zA-Z](?![a-zA-Z])`, "g"))?.length ?? 0;
    return !command("int").test(tex) || !differentials ? [] : spaced === 0 ? ["none"] : spaced === differentials ? ["spaced"] : [];
  }],
  ["brackets", choice([[/\\left\s*(?:[(\[]|\\\{)/, "scalable"], [/\\(?:big|Big|bigg|Bigg)l?\s*(?:[(\[]|\\\{)/, "sized"],
    [new RegExp(String.raw`(?<!\\left\s*)(?<!\\[bB]igg?l?\s*)[(\[]\s*${TALL}`), "fixed"]])],
  ["setBuilder", (_, tex) => {
    const used = new Set<string>();
    for (const [, inner] of tex.matchAll(/\\\{([\s\S]*?)\\\}/g)) {
      if (command("mid").test(inner)) used.add("mid");
      else if (/\\middle\s*\|/.test(inner) || inner.split("|").length === 2) used.add("bar");
      else if (command("colon").test(inner) || /^[^:,=]{1,12}:/.test(inner)) used.add("colon");
    }
    return used.size === 1 ? [...used] : [];
  }],
  ["interval", (_, tex) => {
    const used = new Set<string>();
    for (const [, open, close] of tex.matchAll(/\\in\s*(?:\\left)?\s*([\[\]()])[^\[\]()]*,[^\[\]()]*?(?:\\right)?\s*([\[\]()])/g)) {
      used.add(open === "]" || close === "[" ? "reversed" : "brackets");
    }
    return used.size === 1 ? [...used] : [];
  }],
  ["therefore", choice([[/\\(?:therefore|because)(?![a-zA-Z])|[∴∵]/, "\\therefore / \\because"]])],
  ["units", choice([[new RegExp(String.raw`\d\s*(?:\\[,;:]\s*)?\\mathrm\{\s*${units}\s*\}`), "upright"], [new RegExp(String.raw`\d\s*(?:\\[,;:]\s*)?\\text\{\s*${units}\s*\}`), "\\text"],
    [new RegExp(String.raw`\d\s*(?:\\[,;:]\s*)?${LONG_UNITS}(?![a-zA-Z])`), "plain"]])],
  ["degree", choice([[/\^\{?\s*\\circ\s*\}?/, "circ"], [/°/, "symbol"]])],
  ...TOKEN_HABITS.map(([category, patterns]): Habit => [category, (formula) => only(formula.tex, patterns)]),
];

/** The notation each formula uses, per habit. One formula gives at most one value per habit. */
export function notationVotes(found: readonly Formula[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [key, read, inlineOnly] of WRITING_HABITS) {
    const values = found.filter(f => !inlineOnly || !f.display).flatMap(f => read(f, f.tex.replace(NUMBER_SET, "")));
    if (values.length) result.set(key, values);
  }
  return result;
}
