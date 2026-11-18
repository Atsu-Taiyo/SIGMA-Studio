import { AUTHORING_STYLE_LEARNED_LIMIT } from "@/lib/ai/authoring-style";
import type { AppLocale } from "@/lib/i18n";
import type { Observation } from "./authoring-style-features";
import { itemText, sectionOf } from "./authoring-style-items";
import { MAX_APPLIED, renderMemo, snapshotForUndo, styleHash, type AppliedChange, type LedgerDraft, type PendingChange, type StyleItem, type StyleMemory } from "./authoring-style-memory";
import { summaryKey, type SummaryReply } from "./authoring-style-summary";

/** A habit nothing has confirmed for this long is taken out (or, with automatic changes off, offered for removal). */
export const STALE_AFTER_MS = 45 * 24 * 60 * 60 * 1000;
/** Habits the AI summary may hold at once, so it cannot fill the memo by itself. */
export const MAX_SUMMARY_ITEMS = 10;

export interface ReviewContext {
  now: Date;
  locale: AppLocale;
  /** Personal documents currently in this workspace; null when membership is unknown. */
  eligibleFiles: ReadonlySet<string> | null;
  /** Accepted AI text survived a later editing session since the previous review. */
  keptSinceLastReview: boolean;
  /** The user's switch: rewrite and remove automatic habits without asking. Off: such changes are only staged. */
  autoApply: boolean;
  /**
   * This pass saw everything it should have. When it did not (a document or the list of shared documents could
   * not be read), it changes nothing by itself that it cannot be sure of: rewrites and removals are only staged.
   */
  complete: boolean;
}

export interface ReviewResult { added: number; staged: number; rewritten: number; removed: number; entries: LedgerDraft[] }

type Evidence = Pick<StyleItem, "support" | "documents" | "sources"> & { basis: NonNullable<StyleItem["basis"]> };

/**
 * What an unattended pass does: add a grounded habit, refresh evidence, and rewrite or remove an automatic
 * habit that the evidence no longer supports. Each change that passed the checks is applied, written to the
 * ledger, kept in the list of applied changes (so it can be put back) and covered by the memo's undo.
 * With `autoApply` off, rewriting and removing are only staged for the user, as is adding past the size limit.
 * Lines the user wrote are never touched, and neither are the notes.
 */
function unattended(memory: StyleMemory, context: Pick<ReviewContext, "now" | "locale" | "autoApply" | "complete">) {
  const now = context.now.toISOString();
  const apply = context.autoApply && context.complete;
  const result: ReviewResult = { added: 0, staged: 0, rewritten: 0, removed: 0, entries: [] };
  let snapshotTaken = false;
  const touch = () => { if (!snapshotTaken) snapshotForUndo(memory, "review", now); snapshotTaken = true; };
  const applied = (change: Omit<AppliedChange, "id" | "at">) => {
    memory.applied = [...memory.applied, { ...change, id: `${change.kind}:${styleHash(`${now}\n${change.before.key}\n${change.key}\n${change.value}`).slice(0, 16)}`, at: now }].slice(-MAX_APPLIED);
  };
  const stage = (staged: PendingChange) => {
    // The id names the exact proposal, so approving one the user saw can never apply a later, different one.
    const change = { ...staged, id: `${staged.id}:${styleHash(`${staged.value}\n${staged.expectedText}`).slice(0, 8)}` };
    const existing = memory.pending.findIndex(p => p.key === change.key);
    if (existing >= 0 && memory.pending[existing].kind === change.kind && memory.pending[existing].value === change.value) {
      memory.pending[existing] = { ...change, createdAt: memory.pending[existing].createdAt };
      return;
    }
    if (existing >= 0) memory.pending.splice(existing, 1);
    memory.pending.push(change);
    result.staged++;
    result.entries.push({ actor: "review", action: "stage", key: change.key, before: change.expectedText, after: change.kind === "remove" ? "" : itemText(change.key, change.value, context.locale) ?? "" });
  };
  const unstage = (key: string) => {
    const index = memory.pending.findIndex(p => p.key === key);
    if (index < 0) return;
    memory.pending.splice(index, 1);
    result.entries.push({ actor: "review", action: "unstage", key });
  };
  /** Add a habit the memo does not have yet, or stage it when the memo is full. */
  const add = (key: string, value: string, text: string, evidence: Evidence, action: "add" | "add-summary" = "add") => {
    // Neither what the user declined or took back as an addition, nor a wording they put a habit back from.
    if (memory.dismissed.includes(`add:${key}:${value}`) || memory.dismissed.includes(`rewrite:${key}:${value}`)) return;
    const candidate: StyleItem = { id: `auto:${key}`, key, value, section: sectionOf(key), text, origin: "auto", ...evidence, firstSeenAt: now, lastConfirmedAt: now };
    if (renderMemo({ ...memory, items: [...memory.items, candidate] }, context.locale).length > AUTHORING_STYLE_LEARNED_LIMIT) {
      // Never make room by dropping something silently: the user decides what goes.
      stage({ id: `add:${key}`, kind: "add", reason: "limit", key, value, expectedText: "", ...evidence, createdAt: now });
      return;
    }
    touch();
    memory.items.push(candidate);
    unstage(key);
    result.added++;
    result.entries.push({ actor: "review", action, key, after: text });
  };
  const confirm = (item: StyleItem, evidence?: Evidence) => {
    Object.assign(item, evidence ?? {}, { lastConfirmedAt: now });
    unstage(item.key!);
  };
  /** Replace what an automatic habit says. Returns whether the memo was changed. */
  const rewrite = (item: StyleItem, value: string, text: string, evidence: Evidence): boolean => {
    if (item.origin !== "auto" || !item.key || memory.dismissed.includes(`rewrite:${item.key}:${value}`)) return false;
    const changed: StyleItem = { ...item, ...evidence, value, text, lastConfirmedAt: now };
    const fits = renderMemo({ items: memory.items.map(i => i === item ? changed : i) }, context.locale).length <= AUTHORING_STYLE_LEARNED_LIMIT;
    if (!apply || !fits) {
      stage({ id: `rewrite:${item.key}`, kind: "rewrite", reason: "contradicted", key: item.key, value, expectedText: item.text, ...evidence, createdAt: now });
      return false;
    }
    touch();
    applied({ kind: "rewrite", reason: "contradicted", before: structuredClone(item), key: item.key, value });
    result.entries.push({ actor: "review", action: "auto-rewrite", reason: "contradicted", key: item.key, before: item.text, after: text });
    unstage(item.key);
    memory.items = memory.items.map(i => i === item ? changed : i);
    result.rewritten++;
    return true;
  };
  /** Take an automatic habit out. It is not suppressed: evidence that comes back brings it back. */
  const remove = (item: StyleItem, reason: AppliedChange["reason"]): boolean => {
    if (item.origin !== "auto" || !item.key || memory.dismissed.includes(`remove:${item.key}:${item.value}`)) return false;
    if (!apply) {
      stage({ id: `remove:${item.key}`, kind: "remove", reason, key: item.key, value: item.value, expectedText: item.text,
        basis: item.basis ?? "writing", support: item.support, documents: item.documents, sources: item.sources, createdAt: now });
      return false;
    }
    touch();
    applied({ kind: "remove", reason, before: structuredClone(item), key: item.key, value: item.value });
    result.entries.push({ actor: "review", action: "auto-remove", reason, key: item.key, before: item.text, after: "" });
    unstage(item.key);
    memory.items = memory.items.filter(i => i !== item);
    result.removed++;
    return true;
  };
  const finish = () => {
    if (result.added || result.staged || result.rewritten || result.removed) memory.lastUpdate = { at: now, added: result.added, staged: result.staged, rewritten: result.rewritten, removed: result.removed };
    return result;
  };
  return { now, add, confirm, rewrite, remove, finish };
}

/** The local pass over what the author wrote and corrected. */
export function planReview(memory: StyleMemory, observations: readonly Observation[], context: ReviewContext): ReviewResult {
  const pass = unattended(memory, context);
  const observed = new Set<string>();
  for (const observation of observations) {
    const { key, value } = observation;
    if (memory.suppressed.includes(key)) continue;
    const evidence: Evidence = { basis: observation.basis, support: observation.support, documents: observation.documents, sources: observation.sources.slice(0, 8) };
    const item = memory.items.find(i => i.key === key);
    if (observation.absent) {
      // The author mostly leaves this out now. There is no sentence for that, but one that said otherwise is contradicted.
      if (item?.origin === "auto" && item.value !== value) { observed.add(key); pass.remove(item, "contradicted"); }
      continue;
    }
    const text = itemText(key, value, context.locale);
    if (!text) continue;
    observed.add(key);
    if (!item) pass.add(key, value, text, evidence);
    else if (item.origin !== "auto") continue;
    else if (item.value === value) pass.confirm(item, evidence);
    // New evidence contradicts the habit. The sentence is replaced; a second one is never put next to it.
    else pass.rewrite(item, value, text, evidence);
  }

  for (const item of [...memory.items]) {
    if (item.origin !== "auto" || !item.key || observed.has(item.key)) continue;
    const sources = context.eligibleFiles ? item.sources.filter(id => context.eligibleFiles!.has(id)) : item.sources;
    if (context.keptSinceLastReview && sources.length) item.lastConfirmedAt = pass.now;
    // Documents on another device of the same account still count as evidence.
    const orphaned = !sources.length && !item.devices?.length;
    const aged = context.now.getTime() - Date.parse(item.lastConfirmedAt) > STALE_AFTER_MS;
    // Counting cannot confirm a sentence the AI suggested: only the AI's next summary can. So age alone does not
    // take such a sentence out here; the summary pass does, once the AI was asked and did not stand by it.
    if (orphaned || (aged && !(context.autoApply && item.basis === "summary"))) pass.remove(item, "stale");
  }
  return pass.finish();
}

/**
 * What the configured AI read out of the author's writing. It adds habits and confirms the ones it suggested
 * before; it does not reword or withdraw anything. A suggestion it was asked about again and did not confirm,
 * for long enough, has gone stale like any habit nothing confirms. Its sentences are free text, so each was
 * checked before it got here, is checked again every time it is placed in an AI request, is recorded in the
 * ledger as the AI's addition, and can be taken back.
 */
export function planSummary(memory: StyleMemory, reply: SummaryReply, candidates: readonly string[],
  context: Pick<ReviewContext, "now" | "locale" | "autoApply" | "complete"> & { sources: readonly string[] }): ReviewResult {
  const pass = unattended(memory, context);
  const evidence: Evidence = { basis: "summary", support: context.sources.length, documents: context.sources.length, sources: context.sources.slice(0, 8) };
  const suggested = (number: number) => memory.items.find(i => i.origin === "auto" && i.basis === "summary" && i.key === candidates[number - 1]);
  const confirmed = new Set<number>();
  for (const number of reply.confirm) {
    const item = suggested(number);
    if (item) { pass.confirm(item, evidence); confirmed.add(number); }
  }
  // Counting cannot confirm a sentence the AI suggested, so this is where one goes stale. (With automatic changes
  // off, the counting pass has staged its removal instead; after a pass that did not see everything, it stays.)
  if (context.autoApply && context.complete && reply.whole) candidates.forEach((_, index) => {
    const item = suggested(index + 1);
    if (item && !confirmed.has(index + 1) && context.now.getTime() - Date.parse(item.lastConfirmedAt) > STALE_AFTER_MS) pass.remove(item, "stale");
  });
  const taken = new Set(memory.items.map(i => i.text.replace(/^- /, "")));
  let held = memory.items.filter(i => i.origin === "auto" && i.basis === "summary").length
    + memory.pending.filter(p => p.kind === "add" && p.basis === "summary").length;
  for (const { section, text } of reply.add) {
    const key = summaryKey(section, text);
    if (held >= MAX_SUMMARY_ITEMS || taken.has(text) || memory.declined.includes(text) || memory.suppressed.includes(key)
      || memory.items.some(i => i.key === key) || memory.pending.some(p => p.key === key)
      || memory.dismissed.includes(`add:${key}:${text}`) || itemText(key, text, context.locale) !== text) continue;
    pass.add(key, text, text, evidence, "add-summary");
    held++;
    taken.add(text);
  }
  return pass.finish();
}
