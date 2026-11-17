import { AUTHORING_STYLE_NOTE_LIMIT } from "@/lib/ai/authoring-style";
import type { AppLocale } from "@/lib/i18n";
import type { Observation } from "./authoring-style-features";
import { itemText, sectionOf } from "./authoring-style-items";
import { renderMemo, snapshotForUndo, type LedgerDraft, type PendingChange, type StyleMemory } from "./authoring-style-memory";

/** A habit nothing has confirmed for this long stops being sent to the AI. It is kept, not deleted. */
export const STALE_AFTER_MS = 45 * 24 * 60 * 60 * 1000;
/** A stale habit is then offered for removal. Removing it is always the user's decision. */
export const SUGGEST_REMOVAL_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

export interface ReviewContext {
  now: Date;
  locale: AppLocale;
  /** Personal documents currently in this workspace; null when membership is unknown. */
  eligibleFiles: ReadonlySet<string> | null;
  /** Accepted AI text survived a later editing session since the previous review. */
  keptSinceLastReview: boolean;
}

export interface ReviewResult { added: number; staged: number; entries: LedgerDraft[] }

/**
 * The unattended pass. It may add a grounded habit and refresh evidence. Anything
 * destructive (rewriting or removing an existing habit, or adding past the size
 * limit) is staged for the user instead. User-written items are never touched.
 */
export function planReview(memory: StyleMemory, observations: readonly Observation[], context: ReviewContext): ReviewResult {
  const now = context.now.toISOString();
  const entries: LedgerDraft[] = [];
  let added = 0;
  let staged = 0;
  let snapshotTaken = false;
  const beforeContentChange = () => {
    if (!snapshotTaken) snapshotForUndo(memory, "review", now);
    snapshotTaken = true;
  };
  const stage = (change: PendingChange) => {
    const existing = memory.pending.findIndex(p => p.key === change.key);
    if (existing >= 0 && memory.pending[existing].kind === change.kind && memory.pending[existing].value === change.value) {
      memory.pending[existing] = { ...change, createdAt: memory.pending[existing].createdAt };
      return;
    }
    if (existing >= 0) memory.pending.splice(existing, 1);
    memory.pending.push(change);
    staged++;
    entries.push({ actor: "review", action: "stage", key: change.key, before: change.expectedText, after: change.kind === "remove" ? "" : itemText(change.key, change.value, context.locale) ?? "" });
  };
  const unstage = (key: string) => {
    const index = memory.pending.findIndex(p => p.key === key);
    if (index < 0) return;
    memory.pending.splice(index, 1);
    entries.push({ actor: "review", action: "unstage", key });
  };

  const observed = new Set<string>();
  for (const observation of observations) {
    const { key, value } = observation;
    if (memory.suppressed.includes(key)) continue;
    const text = itemText(key, value, context.locale);
    if (!text) continue;
    observed.add(key);
    const evidence = { basis: observation.basis, support: observation.support, documents: observation.documents, sources: observation.sources.slice(0, 8) };
    const item = memory.items.find(i => i.key === key);
    if (!item) {
      if (memory.dismissed.includes(`add:${key}:${value}`)) continue;
      const candidate = { id: `auto:${key}`, key, value, section: sectionOf(key), text, origin: "auto" as const, ...evidence, firstSeenAt: now, lastConfirmedAt: now, status: "active" as const };
      if (renderMemo({ ...memory, items: [...memory.items, candidate] }, context.locale).length > AUTHORING_STYLE_NOTE_LIMIT) {
        // Never make room by dropping something silently: the user decides what goes.
        stage({ id: `add:${key}`, kind: "add", reason: "limit", key, value, expectedText: "", ...evidence, createdAt: now });
        continue;
      }
      beforeContentChange();
      memory.items.push(candidate);
      unstage(key);
      added++;
      entries.push({ actor: "review", action: "add", key, after: text });
    } else if (item.origin !== "auto") {
      continue;
    } else if (item.value === value) {
      Object.assign(item, evidence, { lastConfirmedAt: now });
      if (item.status === "stale") {
        beforeContentChange();
        item.status = "active";
        delete item.staleSince;
        entries.push({ actor: "review", action: "revive", key, after: item.text });
      }
      unstage(key);
    } else if (!memory.dismissed.includes(`rewrite:${key}:${value}`)) {
      // New evidence contradicts the habit. Replace the sentence, do not append a second one.
      stage({ id: `rewrite:${key}`, kind: "rewrite", reason: "contradicted", key, value, expectedText: item.text, ...evidence, createdAt: now });
    }
  }

  for (const item of memory.items) {
    if (item.origin !== "auto" || !item.key || observed.has(item.key)) continue;
    const sources = context.eligibleFiles ? item.sources.filter(id => context.eligibleFiles!.has(id)) : item.sources;
    if (item.status === "active") {
      if (context.keptSinceLastReview && sources.length) item.lastConfirmedAt = now;
      if (!sources.length || context.now.getTime() - Date.parse(item.lastConfirmedAt) > STALE_AFTER_MS) {
        beforeContentChange();
        item.status = "stale";
        item.staleSince = now;
        entries.push({ actor: "review", action: "stale", key: item.key, before: item.text });
      }
    } else if (context.now.getTime() - Date.parse(item.staleSince ?? now) > SUGGEST_REMOVAL_AFTER_MS
      && !memory.dismissed.includes(`remove:${item.key}:${item.value}`)) {
      stage({ id: `remove:${item.key}`, kind: "remove", reason: "stale", key: item.key, value: item.value, expectedText: item.text,
        basis: item.basis ?? "writing", support: item.support, documents: item.documents, sources: item.sources, createdAt: now });
    }
  }
  if (added || staged) memory.lastUpdate = { at: now, added, staged };
  return { added, staged, entries };
}
