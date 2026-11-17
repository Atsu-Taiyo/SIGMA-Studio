import { createHash } from "node:crypto";

import { inlineNodesToPlainText, type InlineNode, type SigmaBlock, type SigmaDocument } from "@/features/document";
import { changedTexFeatures, formulas, notationVotes } from "./authoring-style-tex";

export const MAX_FRAGMENT_LENGTH = 1800;

export interface Fragment {
  area: string;
  text: string;
  format: string;
  context: string;
  /** Only for a block too long to keep (`text` and `format` are empty): a hash that tells its versions apart. */
  digest?: string;
}

/** A committed manual edit. `post-accept` marks a hand correction of text an accepted AI proposal wrote. */
export interface StyleExample {
  workspaceId: string;
  fileId: string;
  blockId: string;
  title: string;
  revision: number;
  before: Fragment | null;
  after: Fragment | null;
  source?: "post-accept" | "manual";
}

const PROBLEM_AREAS = ["lead", "prompt", "hints", "solution"] as const;
export interface ProblemShape { id: string; areas: Record<(typeof PROBLEM_AREAS)[number], string[]> }
export interface DocumentProjection { fragments: Map<string, Fragment>; problems: ProblemShape[] }

export const fragmentHash = (fragment: Fragment | null | undefined): string =>
  fragment ? createHash("sha256").update(`${fragment.area}\n${fragment.format || (fragment.digest ?? "")}`).digest("hex").slice(0, 32) : "";

// IDs and timestamps are not authoring preferences. Keep actual line breaks,
// TeX and inline formatting so a notation change survives this projection.
export function projectDocument(document: SigmaDocument): DocumentProjection {
  const fragments = new Map<string, Fragment>();
  const problems: ProblemShape[] = [];
  function add(id: string, area: string, children: InlineNode[], context: string, sink: string[] | null, align?: string) {
    const text = inlineNodesToPlainText(children);
    const format = JSON.stringify({ align, runs: children.map(node => node.type === "mathInline" ? { ...node, id: undefined } : node) });
    if (!text.trim()) return;
    fragments.set(id, format.length <= MAX_FRAGMENT_LENGTH ? { area, text, format, context }
      : { area, text: "", format: "", context, digest: createHash("sha256").update(format).digest("hex").slice(0, 32) });
    sink?.push(id);
  }
  function walk(blocks: readonly SigmaBlock[], area: string, context: string, sink: string[] | null) {
    for (const block of blocks) {
      switch (block.type) {
        case "problem": {
          const prompt = block.prompt.flatMap(b => "children" in b && Array.isArray(b.children)
            ? b.children.filter((n): n is InlineNode => n.type === "text" || n.type === "mathInline") : []);
          const problemContext = inlineNodesToPlainText(prompt).slice(0, 300);
          const shape: ProblemShape = { id: block.id, areas: { lead: [], prompt: [], hints: [], solution: [] } };
          for (const name of PROBLEM_AREAS) walk(block[name], name, problemContext, shape.areas[name]);
          problems.push(shape);
          break;
        }
        case "paragraph":
        case "heading": add(block.id, area, block.children, context, sink, block.align); break;
        case "section": add(block.id, area, [{ type: "text", text: block.title }], context, sink, block.align); break;
        case "boxBlock":
          if (block.title) add(`${block.id}:title`, area, block.title, context, sink);
          walk(block.blocks, area, context, sink);
          break;
        case "quote": walk(block.blocks, area, context, sink); break;
        case "layoutSection": walk(block.children, area, context, sink); break;
        case "list":
          for (const item of block.items) {
            add(item.id, area, item.children, context, sink, item.align);
            walk(item.continuations ?? [], area, context, sink);
            walk(item.nested ?? [], area, context, sink);
          }
          break;
      }
    }
  }
  walk(document.content, "body", "", null);
  const structure = JSON.stringify(document.content.slice(0, 80).map(b => b.type === "problem"
    ? { type: b.type, areas: PROBLEM_AREAS.filter(key => b[key].length > 0) }
    : { type: b.type }));
  if (structure.length <= MAX_FRAGMENT_LENGTH) fragments.set("$structure", { area: "structure", text: structure, format: structure, context: "" });
  return { fragments, problems };
}

/** Share of character bigrams two texts have in common (0..1). */
export function textSimilarity(a: string, b: string): number {
  const grams = (text: string) => {
    const result = new Map<string, number>();
    const compact = text.replace(/\s+/g, "");
    for (let i = 0; i < compact.length - 1; i++) result.set(compact.slice(i, i + 2), (result.get(compact.slice(i, i + 2)) ?? 0) + 1);
    return result;
  };
  const left = grams(a);
  const right = grams(b);
  let shared = 0;
  let total = 0;
  for (const count of left.values()) total += count;
  for (const [gram, count] of right) { total += count; shared += Math.min(count, left.get(gram) ?? 0); }
  return total ? (2 * shared) / total : 1;
}

const POLITE = /(?:です|ます|でしょう|ません|ました|でした|ましょう|ください|下さい)$/u;
const COMMAND = /(?:[めべえ]よ|せよ|[示表]せ|[解書描]け|選べ)$/u;
const PLAIN = /(?:である|だ|る|ない|た|よい|う)$/u;
const CONNECTIVES: readonly (readonly [RegExp, string])[] = [
  [/^(?:よって)/u, "yotte"], [/^(?:したがって|従って)/u, "shitagatte"], [/^(?:ゆえに|故に)/u, "yueni"], [/^以上より/u, "ijou-yori"],
];
const NUMBERING: readonly (readonly [RegExp, string])[] = [
  [/^\(\d+\)/u, "(1)"], [/^（[0-9０-９]+）/u, "（1）"], [/^[①-⑳]/u, "①"], [/^\[\d+\]/u, "[1]"],
];

function sentences(text: string): string[] {
  return text.split(/(?<=[。．！？!?])|\n/u).map(s => s.trim().replace(/[。．！？!?\s）)」』]+$/u, "")).filter(Boolean);
}

/** The single most frequent value, or nothing when the fragment itself is mixed. */
function dominant(values: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  return ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : undefined;
}

/** One vote per habit per fragment: a block is the unit of independent evidence. */
export function proseVotes(fragment: Fragment): Map<string, string> {
  const votes = new Map<string, string>();
  if (fragment.area === "structure" || !fragment.text) return votes;
  const put = (key: string, value: string | undefined) => { if (value) votes.set(key, value); };
  const parts = sentences(fragment.text);
  const question = fragment.area === "prompt" || fragment.area === "lead";
  put("ending.question", dominant(parts.flatMap(s => COMMAND.test(s) ? ["imperative"] : /なさい$/u.test(s) ? ["nasai"]
    : question && /[てで](?:ください|下さい)$/u.test(s) ? ["kudasai"] : [])));
  if (!question) {
    put("tone.explanation", dominant(parts.flatMap(s => POLITE.test(s) ? ["polite"] : COMMAND.test(s) || /なさい$/u.test(s) ? [] : PLAIN.test(s) ? ["plain"] : [])));
  }
  put("connective.conclusion", dominant(parts.flatMap(s => CONNECTIVES.filter(([pattern]) => pattern.test(s)).map(([, value]) => value))));
  const comma = dominant([...fragment.text.matchAll(/[、，]/gu)].map(m => m[0]));
  const period = dominant([...fragment.text.matchAll(/[。．]/gu)].map(m => m[0]));
  if (comma && period) votes.set("punctuation.style", comma + period);
  put("numbering.subquestion", dominant(fragment.text.split("\n").flatMap(line => {
    const match = NUMBERING.find(([pattern]) => pattern.test(line.trim()));
    return match ? [match[1]] : [];
  })));
  return votes;
}

export function texVotes(fragment: Fragment): Map<string, string> {
  const votes = new Map<string, string>();
  for (const [key, values] of notationVotes(formulas(fragment))) {
    const value = dominant(values);
    if (value) votes.set(`tex.${key}`, value);
  }
  return votes;
}

export interface EvidenceUnit { fileId: string; blockId: string; votes: Map<string, string> }
export interface Observation {
  key: string;
  value: string;
  basis: "writing" | "corrections";
  /** Independent blocks (writing) or edits (corrections) supporting the value. */
  support: number;
  documents: number;
  sources: string[];
}

export const MIN_WRITING_BLOCKS = 3;
export const MIN_WRITING_SHARE = 0.7;
export const MIN_CORRECTIONS = 2;
/** "The author leaves this empty" is not a rule worth teaching; only a positive habit is. */
const NOT_A_RULE = new Set(["procedure.solution:empty", "procedure.hints:empty", "tex.inlineSize:none", "tex.integralSpacing:none"]);

/** Habits visible in the author's own text. A value needs several independent blocks and a clear majority. */
export function observeWriting(units: readonly EvidenceUnit[]): Observation[] {
  const byKey = new Map<string, Map<string, EvidenceUnit[]>>();
  for (const unit of units) {
    for (const [key, value] of unit.votes) {
      const values = byKey.get(key) ?? new Map<string, EvidenceUnit[]>();
      values.set(value, [...(values.get(value) ?? []), unit]);
      byKey.set(key, values);
    }
  }
  const result: Observation[] = [];
  for (const [key, values] of byKey) {
    const total = [...values.values()].reduce((sum, list) => sum + list.length, 0);
    const [value, supporters] = [...values].sort((a, b) => b[1].length - a[1].length)[0];
    if (supporters.length < MIN_WRITING_BLOCKS || supporters.length / total < MIN_WRITING_SHARE || NOT_A_RULE.has(`${key}:${value}`)) continue;
    const files = [...new Set(supporters.map(unit => unit.fileId))];
    result.push({ key, value, basis: "writing", support: supporters.length, documents: files.length, sources: files.slice(0, 8) });
  }
  return result;
}

/** What one manual edit switched to. Unchanged text in the edited block is not evidence. */
export function correctionVotes(example: StyleExample): Map<string, string> {
  const votes = new Map<string, string>();
  if (!example.before || !example.after || example.after.area === "structure") return votes;
  const before = proseVotes(example.before);
  for (const [key, value] of proseVotes(example.after)) {
    if (before.has(key) && before.get(key) !== value) votes.set(key, value);
  }
  for (const [category, values] of changedTexFeatures(example)) {
    if (values.size === 1) votes.set(`tex.${category}`, [...values][0]);
  }
  return votes;
}

/** Repeated corrections. Fixing accepted AI text counts double when two values compete. */
export function observeCorrections(examples: readonly StyleExample[]): Observation[] {
  const byKey = new Map<string, Map<string, { sources: Set<string>; files: Set<string>; weight: number }>>();
  for (const example of examples) {
    for (const [key, value] of correctionVotes(example)) {
      const values = byKey.get(key) ?? new Map();
      const entry = values.get(value) ?? { sources: new Set<string>(), files: new Set<string>(), weight: 0 };
      const source = `${example.fileId}:${example.blockId}`;
      if (!entry.sources.has(source)) entry.weight += example.source === "post-accept" ? 2 : 1;
      entry.sources.add(source);
      entry.files.add(example.fileId);
      values.set(value, entry);
      byKey.set(key, values);
    }
  }
  const result: Observation[] = [];
  for (const [key, values] of byKey) {
    const ranked = [...values].sort((a, b) => b[1].weight - a[1].weight);
    const [value, entry] = ranked[0];
    if (entry.sources.size < MIN_CORRECTIONS || (ranked[1] && ranked[1][1].weight >= entry.weight)) continue;
    result.push({ key, value, basis: "corrections", support: entry.sources.size, documents: entry.files.size, sources: [...entry.files].slice(0, 8) });
  }
  return result;
}

/** One fact per habit. An explicit, repeated correction outranks what the surrounding text suggests. */
export function mergeObservations(writing: readonly Observation[], corrections: readonly Observation[]): Observation[] {
  const merged = new Map(writing.map(o => [o.key, o]));
  for (const observation of corrections) merged.set(observation.key, observation);
  return [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Votes of one personal document, leaving out blocks the predicate attributes to the AI. */
export function documentEvidence(fileId: string, projection: DocumentProjection, isAiText: (blockId: string, fragment: Fragment) => boolean, budget: { characters: number }): { units: EvidenceUnit[]; skippedAi: number; characters: number; texts: string[] } {
  const units: EvidenceUnit[] = [];
  const texts: string[] = [];
  const authored = new Set<string>();
  let skippedAi = 0;
  let characters = 0;
  for (const [blockId, fragment] of projection.fragments) {
    if (fragment.area === "structure" || !fragment.format) continue;
    if (isAiText(blockId, fragment)) { skippedAi++; continue; }
    if (characters + fragment.text.length > budget.characters) break;
    characters += fragment.text.length;
    authored.add(blockId);
    texts.push(fragment.text);
    const votes = new Map([...proseVotes(fragment), ...texVotes(fragment)]);
    if (votes.size) units.push({ fileId, blockId, votes });
  }
  for (const problem of projection.problems) {
    // A problem the AI wrote and nobody touched says nothing about how the author builds one.
    if (!Object.values(problem.areas).flat().some(id => authored.has(id))) continue;
    units.push({ fileId, blockId: problem.id, votes: new Map([
      ["procedure.solution", problem.areas.solution.length ? "filled" : "empty"],
      ["procedure.hints", problem.areas.hints.length ? "filled" : "empty"],
    ]) });
  }
  return { units, skippedAi, characters, texts };
}
