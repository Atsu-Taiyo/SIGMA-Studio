import { AUTHORING_STYLE_NOTE_LIMIT } from "@/lib/ai/authoring-style";
import type { AppLocale } from "@/lib/i18n";
import type { Observation } from "./authoring-style-features";
import { itemText, sectionOf } from "./authoring-style-items";
import { renderMemo, snapshotForUndo, styleHash, type LedgerDraft, type PendingChange, type StyleItem, type StyleMemory } from "./authoring-style-memory";
import { summaryKey, type SummaryReply } from "./authoring-style-summary";

/** A habit nothing has confirmed for this long is offered for removal. Removing it is always the user's decision. */
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
}

export interface ReviewResult { added: number; staged: number; entries: LedgerDraft[] }

type Evidence = Pick<StyleItem, "support" | "documents" | "sources"> & { basis: NonNullable<StyleItem["basis"]> };

/**
 * What an unattended pass is allowed to do: add a grounded habit and refresh
 * evidence. Rewriting or removing an existing habit, however strong the
 * evidence against it, and adding past the size limit, are only staged for the
 * user. User-written items are never touched.
 */
function unattended(memory: StyleMemory, context: Pick<ReviewContext, "now" | "locale">) {
  const now = context.now.toISOString();
  const result: ReviewResult = { added: 0, staged: 0, entries: [] };
  let snapshotTaken = false;
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
  const add = (key: string, value: string, text: string, evidence: Evidence) => {
    if (memory.dismissed.includes(`add:${key}:${value}`)) return;
    const candidate: StyleItem = { id: `auto:${key}`, key, value, section: sectionOf(key), text, origin: "auto", ...evidence, firstSeenAt: now, lastConfirmedAt: now };
    if (renderMemo({ ...memory, items: [...memory.items, candidate] }, context.locale).length > AUTHORING_STYLE_NOTE_LIMIT) {
      // Never make room by dropping something silently: the user decides what goes.
      stage({ id: `add:${key}`, kind: "add", reason: "limit", key, value, expectedText: "", ...evidence, createdAt: now });
      return;
    }
    if (!snapshotTaken) snapshotForUndo(memory, "review", now);
    snapshotTaken = true;
    memory.items.push(candidate);
    unstage(key);
    result.added++;
    result.entries.push({ actor: "review", action: "add", key, after: text });
  };
  const confirm = (item: StyleItem, evidence?: Evidence) => {
    Object.assign(item, evidence ?? {}, { lastConfirmedAt: now });
    unstage(item.key!);
  };
  const finish = () => {
    if (result.added || result.staged) memory.lastUpdate = { at: now, added: result.added, staged: result.staged };
    return result;
  };
  return { now, stage, add, confirm, finish };
}

/** The local pass over what the author wrote and corrected. */
export function planReview(memory: StyleMemory, observations: readonly Observation[], context: ReviewContext): ReviewResult {
  const pass = unattended(memory, context);
  const observed = new Set<string>();
  for (const observation of observations) {
    const { key, value } = observation;
    if (memory.suppressed.includes(key)) continue;
    const text = itemText(key, value, context.locale);
    if (!text) continue;
    observed.add(key);
    const evidence: Evidence = { basis: observation.basis, support: observation.support, documents: observation.documents, sources: observation.sources.slice(0, 8) };
    const item = memory.items.find(i => i.key === key);
    if (!item) pass.add(key, value, text, evidence);
    else if (item.origin !== "auto") continue;
    else if (item.value === value) pass.confirm(item, evidence);
    else if (!memory.dismissed.includes(`rewrite:${key}:${value}`)) {
      // New evidence contradicts the habit. Propose replacing the sentence; do not append a second one.
      pass.stage({ id: `rewrite:${key}`, kind: "rewrite", reason: "contradicted", key, value, expectedText: item.text, ...evidence, createdAt: pass.now });
    }
  }

  for (const item of memory.items) {
    if (item.origin !== "auto" || !item.key || observed.has(item.key)) continue;
    const sources = context.eligibleFiles ? item.sources.filter(id => context.eligibleFiles!.has(id)) : item.sources;
    if (context.keptSinceLastReview && sources.length) item.lastConfirmedAt = pass.now;
    const unconfirmed = !sources.length || context.now.getTime() - Date.parse(item.lastConfirmedAt) > STALE_AFTER_MS;
    if (unconfirmed && !memory.dismissed.includes(`remove:${item.key}:${item.value}`)) {
      // The habit stays in the memo, and in use, until its author agrees to drop it.
      pass.stage({ id: `remove:${item.key}`, kind: "remove", reason: "stale", key: item.key, value: item.value, expectedText: item.text,
        basis: item.basis ?? "writing", support: item.support, documents: item.documents, sources: item.sources, createdAt: pass.now });
    }
  }
  return pass.finish();
}

/**
 * What the configured AI read out of the author's writing. Its sentences are
 * free text that would be kept and placed in later AI requests, so none enters
 * the memo unread: each is staged for the author to accept or decline. Besides
 * that it can confirm a habit it suggested before; it never rewrites or removes.
 */
export function planSummary(memory: StyleMemory, reply: SummaryReply, candidates: readonly string[],
  context: Pick<ReviewContext, "now" | "locale"> & { sources: readonly string[] }): ReviewResult {
  const pass = unattended(memory, context);
  const evidence: Evidence = { basis: "summary", support: context.sources.length, documents: context.sources.length, sources: context.sources.slice(0, 8) };
  for (const number of reply.confirm) {
    const item = memory.items.find(i => i.origin === "auto" && i.key === candidates[number - 1]);
    if (item) pass.confirm(item, evidence);
  }
  const taken = new Set(memory.items.map(i => i.text.replace(/^- /, "")));
  let held = memory.items.filter(i => i.origin === "auto" && i.basis === "summary").length
    + memory.pending.filter(p => p.kind === "add" && p.basis === "summary").length;
  for (const { section, text } of reply.add) {
    const key = summaryKey(section, text);
    if (held >= MAX_SUMMARY_ITEMS || taken.has(text) || memory.declined.includes(text) || memory.suppressed.includes(key)
      || memory.items.some(i => i.key === key) || memory.pending.some(p => p.key === key)
      || memory.dismissed.includes(`add:${key}:${text}`) || itemText(key, text, context.locale) !== text) continue;
    pass.stage({ id: `add:${key}`, kind: "add", reason: "summary", key, value: text, expectedText: "", ...evidence, createdAt: pass.now });
    held++;
    taken.add(text);
  }
  return pass.finish();
}
