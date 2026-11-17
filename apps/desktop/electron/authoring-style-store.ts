import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { SigmaDocument } from "@/features/document";
import { AUTHORING_STYLE_NOTE_LIMIT, type AuthoringStyleOutcomes, type AuthoringStyleProfile } from "@/lib/ai/authoring-style";
import { createTranslator, getAppLocale, type AppLocale } from "@/lib/i18n";
import type { AiResourceContextItem, AiResourceRunContext } from "./ai-resource-store";
import {
  documentEvidence, fragmentHash, mergeObservations, observeCorrections, observeWriting, projectDocument, textSimilarity,
  MAX_FRAGMENT_LENGTH, type DocumentProjection, type EvidenceUnit, type Fragment, type StyleExample,
} from "./authoring-style-features";
import { itemText, memoLabels, SECTION_ORDER } from "./authoring-style-items";
import { AuthoringStyleMemory, atomicStyleWrite, renderMemo, type StyleMemory } from "./authoring-style-memory";
import { planReview, planSummary } from "./authoring-style-review";
import { isSuspicious, scanLines } from "./authoring-style-scan";
import { buildSummaryPrompt, isSummaryText, parseSummaryReply, type SummaryInput } from "./authoring-style-summary";
import type { AiEditProvider } from "./ai-edit-provider";
import { acquireFileLock } from "./file-lock";
import { logLedgerEvent } from "./ledger-log";
import type { LocalDocumentMetadata, LocalDocumentSavedEvent } from "./local-sigma-doc-store";

export type { StyleExample } from "./authoring-style-features";

const MAX_EXAMPLES = 160;
const MAX_EXAMPLE_FILE_BYTES = 2_000_000;
const MAX_PROMPT_LENGTH = 7000;
const MAX_PROMPT_EXAMPLES = 6;
const MAX_PENDING = 400;
const MAX_AI_BLOCKS = 3000;
const MAX_REJECTIONS = 300;
const MAX_OVERFLOW_FILES = 2000;
const FLUSH_DELAY_MS = 750;
/** The review reads a few recently edited documents, never the whole library. */
export const DEFAULT_REVIEW_DOCUMENTS = 10;
export const MAX_REVIEW_DOCUMENT_CHARACTERS = 20_000;
export const MAX_REVIEW_CHARACTERS = 100_000;
/** What one AI summary may read: excerpts of the author's own text, never whole documents. */
export const MAX_SUMMARY_SAMPLE_CHARACTERS = 6000;
const MAX_SUMMARY_EXCERPT = 300;
const MIN_SUMMARY_SAMPLE_CHARACTERS = 400;
const MAX_SUMMARY_CORRECTIONS = 6;
/** An unattended summary is asked for at most this often per workspace. */
const SUMMARY_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const REVIEW_IDLE_MS = 15_000;
const REVIEW_MAX_AGE_MS = 30 * 60 * 1000;
const REVIEW_AFTER = { saves: 5, corrections: 2, rejections: 2 };
/** Below this similarity a corrected AI block reads as the author's own text again. */
const REWRITTEN_BELOW = 0.5;

/** A block an accepted AI proposal wrote, and what the author later did with it. */
interface AiBlock {
  workspaceId: string;
  fileId: string;
  blockId: string;
  hash: string;
  /** The block before the proposal ("" when the proposal added it). Returning to it is a revert. */
  previousHash: string;
  acceptedRevision: number;
  acceptedAt: string;
  state: "accepted" | "kept" | "edited" | "rewritten" | "reverted";
  /**
   * Accepted while learning was off, or before a reset. Still known to be AI text,
   * but left out of the outcome counts.
   */
  uncounted?: true;
}
interface Counters { saves: number; corrections: number; rejections: number; kept: number; reviewedAt: string | null }
interface Outcomes {
  version: 1;
  blocks: AiBlock[];
  rejected: { workspaceId: string; fileId: string; at: string }[];
  counters: Record<string, Counters>;
  /** Documents whose AI blocks no longer all fit in `blocks`. They are not read as the author's writing. */
  overflow?: string[];
}

type PendingRecord =
  | { type: "accept"; workspaceId: string; fileId: string; blockId: string; hash: string; previousHash: string; revision: number }
  | { type: "edit"; example: StyleExample; beforeHash: string; afterHash: string }
  | { type: "save"; workspaceId: string; fileId: string; revision: number; changed: string[] }
  | { type: "reject"; fileId: string };

export interface AuthoringStyleStoreOptions {
  listFiles?: () => Promise<LocalDocumentMetadata[]>;
  /** Reads a personal document for the review. Without it only corrections are learned. */
  loadDocument?: (fileId: string) => Promise<SigmaDocument | null>;
  /** How many recently edited documents of the workspace a review reads. */
  reviewDocuments?: number;
  /**
   * Ask the AI provider the user already uses for a plain-text reply, without tools.
   * Without it the review only counts habits on this device.
   */
  summarize?: (request: { provider: AiEditProvider; prompt: string }) => Promise<string>;
  now?: () => Date;
  /** Quiet time after the last save before a due review starts. Null never starts one automatically. */
  reviewIdleMs?: number | null;
}

function same(a: Fragment | null | undefined, b: Fragment | null | undefined): boolean {
  return a?.area === b?.area && a?.format === b?.format && a?.digest === b?.digest;
}

const emptyCounters = (): Counters => ({ saves: 0, corrections: 0, rejections: 0, kept: 0, reviewedAt: null });

/**
 * Learns how the author writes from their own documents and from what they do
 * with AI proposals. Everything here is derived data: it never rewrites a
 * document, and its failures never fail a save or an AI request.
 */
export class LocalAuthoringStyleStore {
  private readonly dataDir: string;
  private readonly root: string;
  private readonly filePath: string;
  private readonly outcomesPath: string;
  private readonly providerPath: string;
  private provider: AiEditProvider | null = null;
  private readonly memory: AuthoringStyleMemory;
  private readonly options: AuthoringStyleStoreOptions;
  private pending: PendingRecord[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private queue: Promise<void> = Promise.resolve();
  private readonly reviewTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly reviews = new Map<string, Promise<void>>();
  /** Bumped by a reset so a review already under way cannot write back what was just erased. */
  private generation = 0;
  private readonly summaryAttempts = new Map<string, number>();

  constructor(userDataPath: string, options: AuthoringStyleStoreOptions = {}) {
    this.options = options;
    this.dataDir = path.join(userDataPath, "data");
    this.root = path.join(this.dataDir, "ai-authoring-style");
    this.filePath = path.join(this.root, "examples.json");
    this.outcomesPath = path.join(this.root, "outcomes.json");
    this.providerPath = path.join(this.root, "provider.json");
    this.memory = new AuthoringStyleMemory(this.root);
  }

  private now(): Date { return this.options.now?.() ?? new Date(); }

  observe(event: LocalDocumentSavedEvent): void {
    // Restoration and shared materialization are neither the author's writing nor an AI outcome.
    if (event.file.sharing || event.file.sharingPending || event.origin === "restore-backup" || !event.previousDocument) return;
    const before = projectDocument(event.previousDocument).fragments;
    const after = projectDocument(event.document).fragments;
    const { workspaceId, fileId, title, revision } = event.file;
    const changed: string[] = [];
    for (const blockId of new Set([...before.keys(), ...after.keys()])) {
      const oldFragment = before.get(blockId) ?? null;
      const newFragment = after.get(blockId) ?? null;
      if (same(oldFragment, newFragment)) continue;
      changed.push(blockId);
      if (event.origin === "ai") {
        // Accepting a proposal says nothing about style yet. Remember what the AI wrote so a
        // later hand edit is recognized as a correction, and untouched AI text is not mistaken
        // for the author's own.
        if (blockId !== "$structure" && newFragment) {
          this.pending.push({ type: "accept", workspaceId, fileId, blockId, hash: fragmentHash(newFragment), previousHash: fragmentHash(oldFragment), revision });
        }
        continue;
      }
      this.pending.push({ type: "edit", beforeHash: fragmentHash(oldFragment), afterHash: fragmentHash(newFragment),
        example: { workspaceId, fileId, title, blockId, revision, before: oldFragment, after: newFragment } });
    }
    if (event.origin !== "ai" && changed.length) this.pending.push({ type: "save", workspaceId, fileId, revision, changed });
    this.schedule();
  }

  /** The author rejected AI proposals for these documents. No reason is inferred from it. */
  recordRejected(fileIds: readonly string[]): void {
    for (const fileId of fileIds) this.pending.push({ type: "reject", fileId });
    this.schedule();
  }

  private schedule(): void {
    // Shed the oldest edits only. Losing an acceptance would later pass AI text off as the author's.
    for (let index = 0; this.pending.length > MAX_PENDING && index < this.pending.length;) {
      if (this.pending[index].type === "edit") this.pending.splice(index, 1);
      else index++;
    }
    if (!this.pending.length || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, FLUSH_DELAY_MS);
    this.timer.unref();
  }

  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const pending = this.pending.splice(0);
    if (pending.length) {
      this.queue = this.queue.then(() => this.withLock(() => this.apply(pending))).catch(error => {
        logLedgerEvent(this.dataDir, "authoring-style-write-failed", { error: String(error) });
      });
    }
    await this.queue;
  }

  private async apply(pending: readonly PendingRecord[]): Promise<void> {
    const globallyEnabled = await this.memory.enabled(null);
    // While learning is off nothing is collected, except which blocks the AI wrote and whether they
    // were touched since (hashes only): without that, turning learning back on would take AI text
    // for the author's own.
    const files = await this.personalFiles();
    const enabled = new Map<string, boolean>();
    const personal = (workspaceId: string, fileId: string) => !files || files.get(fileId)?.workspaceId === workspaceId;
    const usable = async (workspaceId: string, fileId: string) => {
      if (!enabled.has(workspaceId)) enabled.set(workspaceId, globallyEnabled && await this.memory.enabled(workspaceId));
      return enabled.get(workspaceId)! && personal(workspaceId, fileId);
    };
    let examples = await this.eligible(await this.read(), false);
    const outcomes = await this.readOutcomes();
    const counters = (workspaceId: string) => outcomes.counters[workspaceId] ??= emptyCounters();
    const block = (fileId: string, blockId: string) => outcomes.blocks.find(b => b.fileId === fileId && b.blockId === blockId);
    const at = this.now().toISOString();
    for (const record of pending) {
      if (record.type === "reject") {
        const file = files?.get(record.fileId);
        if (!file || !await usable(file.workspaceId, file.fileId)) continue;
        outcomes.rejected.push({ workspaceId: file.workspaceId, fileId: file.fileId, at });
        counters(file.workspaceId).rejections++;
      } else if (record.type === "accept") {
        if (!personal(record.workspaceId, record.fileId)) continue;
        const replaced = block(record.fileId, record.blockId);
        if (replaced) outcomes.blocks.splice(outcomes.blocks.indexOf(replaced), 1);
        outcomes.blocks.push({ workspaceId: record.workspaceId, fileId: record.fileId, blockId: record.blockId, hash: record.hash,
          previousHash: record.previousHash, acceptedRevision: record.revision, acceptedAt: at, state: "accepted",
          ...(await usable(record.workspaceId, record.fileId) ? {} : { uncounted: true as const }) });
      } else if (record.type === "save") {
        if (!await usable(record.workspaceId, record.fileId)) continue;
        counters(record.workspaceId).saves++;
        // AI text that outlives a later editing session was good enough to keep.
        for (const tracked of outcomes.blocks) {
          if (tracked.fileId !== record.fileId || tracked.uncounted || tracked.state !== "accepted" || tracked.acceptedRevision >= record.revision || record.changed.includes(tracked.blockId)) continue;
          tracked.state = "kept";
          counters(record.workspaceId).kept++;
        }
      } else {
        const edit = record.example;
        const tracked = block(edit.fileId, edit.blockId);
        // A block too long to keep has no text to compare or to learn from, but what the AI wrote
        // in it is still the AI's after a small cut.
        const oversized = edit.before?.format === "" || edit.after?.format === "";
        if (tracked && tracked.hash && record.afterHash === tracked.hash && tracked.state !== "accepted" && tracked.state !== "kept" && personal(edit.workspaceId, edit.fileId)) {
          // Redoing an undone proposal (or typing a correction back out) puts the AI's text back as it
          // was accepted. It is the AI's again, not something the author wrote.
          tracked.state = "accepted";
          tracked.acceptedRevision = edit.revision;
          examples = examples.filter(e => !(e.fileId === edit.fileId && e.blockId === edit.blockId));
          continue;
        }
        if (!await usable(edit.workspaceId, edit.fileId)) {
          // Not learned from, but a touched-up AI block must not look like new writing later.
          if (tracked && (tracked.state === "accepted" || tracked.state === "kept") && record.beforeHash === tracked.hash && personal(edit.workspaceId, edit.fileId)) {
            tracked.state = record.afterHash === tracked.previousHash ? "reverted" : oversized || !edit.after || textSimilarity(edit.before?.text ?? "", edit.after.text) >= REWRITTEN_BELOW ? "edited" : "rewritten";
            tracked.uncounted = true;
          }
          continue;
        }
        if (tracked && (tracked.state === "accepted" || tracked.state === "kept") && record.beforeHash === tracked.hash) {
          if (record.afterHash === tracked.previousHash) {
            // Undoing the proposal restores what was there. That is a rejection, not a way of writing.
            tracked.state = "reverted";
            counters(edit.workspaceId).rejections++;
            continue;
          }
          tracked.state = oversized || !edit.after || textSimilarity(edit.before?.text ?? "", edit.after.text) >= REWRITTEN_BELOW ? "edited" : "rewritten";
          if (oversized) continue;
          counters(edit.workspaceId).corrections++;
          edit.source = "post-accept";
        } else if (tracked?.state === "edited" && record.afterHash === tracked.previousHash) {
          // A correction that ends up back at the pre-AI text was a revert after all.
          tracked.state = "reverted";
          counters(edit.workspaceId).rejections++;
          examples = examples.filter(e => !(e.fileId === edit.fileId && e.blockId === edit.blockId));
          continue;
        } else {
          // Any other edit of a block still attributed to the AI is a correction of AI text, whether or
          // not an earlier example of it survives (a reset or the example limit may have dropped it).
          // So is an edit in a document whose AI marks no longer all fit in the record.
          edit.source = (!tracked && !outcomes.overflow?.includes(edit.fileId)) || tracked?.state === "reverted" || tracked?.state === "rewritten" ? "manual" : "post-accept";
        }
        if (oversized) continue;
        const index = examples.findIndex(e => e.workspaceId === edit.workspaceId && e.fileId === edit.fileId && e.blockId === edit.blockId);
        const previous = index < 0 ? undefined : examples[index];
        if (previous && previous.revision >= edit.revision) continue;
        if (index >= 0) examples.splice(index, 1);
        // Collapse successive autosaves, retaining the original before-state and where it came from.
        const merged = previous && same(previous.after, edit.before)
          ? { ...edit, before: previous.before, source: previous.source === "post-accept" ? "post-accept" as const : edit.source } : edit;
        if (!same(merged.before, merged.after)) examples.push(merged);
        // Further edits can leave so little of the AI's sentence that the block is the author's own again.
        if (tracked?.state === "edited" && merged.source === "post-accept" && merged.before && merged.after
          && textSimilarity(merged.before.text, merged.after.text) < REWRITTEN_BELOW) tracked.state = "rewritten";
        examples = examples.slice(-MAX_EXAMPLES);
      }
    }
    await this.persist(examples);
    await this.writeOutcomes(outcomes);
    for (const [workspaceId, value] of Object.entries(outcomes.counters)) if (this.due(value)) this.scheduleReview(workspaceId);
  }

  private due(counters: Counters | undefined): boolean {
    if (!counters) return false;
    const activity = counters.saves + counters.corrections + counters.rejections;
    if (!activity) return false;
    return counters.corrections >= REVIEW_AFTER.corrections || counters.rejections >= REVIEW_AFTER.rejections || counters.saves >= REVIEW_AFTER.saves
      || !counters.reviewedAt || this.now().getTime() - Date.parse(counters.reviewedAt) > REVIEW_MAX_AGE_MS;
  }

  /** Start the review once editing has gone quiet. It runs apart from saving and from AI requests. */
  private scheduleReview(workspaceId: string): void {
    const idle = this.options.reviewIdleMs === undefined ? REVIEW_IDLE_MS : this.options.reviewIdleMs;
    if (idle === null) return;
    clearTimeout(this.reviewTimers.get(workspaceId));
    const timer = setTimeout(() => {
      this.reviewTimers.delete(workspaceId);
      void this.review(workspaceId);
    }, idle);
    timer.unref();
    this.reviewTimers.set(workspaceId, timer);
  }

  /**
   * Background review: read a few recently edited personal documents of the
   * workspace, combine the habits found in the author's own text with repeated
   * corrections, and refine the memo. Never throws; a failure is only logged.
   */
  review(workspaceId: string, requested = false): Promise<void> {
    const running = this.reviews.get(workspaceId);
    if (running) return running;
    const run = this.runReview(workspaceId, requested).catch(error => {
      logLedgerEvent(this.dataDir, "authoring-style-review-failed", { error: String(error) });
    }).finally(() => { this.reviews.delete(workspaceId); });
    this.reviews.set(workspaceId, run);
    return run;
  }

  private async runReview(workspaceId: string, requested: boolean): Promise<void> {
    await this.flush();
    const generation = this.generation;
    const recent = await this.exclusive(async () => {
      if (!await this.memory.enabled(null) || !await this.memory.enabled(workspaceId)) return null;
      const files = await this.personalFiles();
      return files ? [...files.values()].filter(f => f.workspaceId === workspaceId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, this.options.reviewDocuments ?? DEFAULT_REVIEW_DOCUMENTS) : [];
    });
    if (!recent) return;
    // Documents are read outside the style lock so a long read never delays a save's bookkeeping.
    const loaded: { file: LocalDocumentMetadata; projection: DocumentProjection }[] = [];
    let characters = 0;
    for (const file of recent) {
      // Stop once the budget is all but spent rather than opening documents that cannot be read.
      if (MAX_REVIEW_CHARACTERS - characters < MAX_REVIEW_DOCUMENT_CHARACTERS / 10 || !this.options.loadDocument) break;
      let document: SigmaDocument | null;
      try { document = await this.options.loadDocument(file.fileId); }
      catch (error) { logLedgerEvent(this.dataDir, "authoring-style-read-failed", { fileId: file.fileId, error: String(error) }); continue; }
      if (!document) continue;
      const projection = projectDocument(document);
      loaded.push({ file, projection });
      let length = 0;
      for (const fragment of projection.fragments.values()) length += fragment.area === "structure" ? 0 : fragment.text.length;
      characters += Math.min(length, MAX_REVIEW_DOCUMENT_CHARACTERS);
    }
    // Bring in acceptances saved while reading, so their text is attributed to the AI below.
    await this.flush();
    const summary = await this.exclusive(async () => {
      if (generation !== this.generation || !await this.memory.enabled(null) || !await this.memory.enabled(workspaceId)) return null;
      const files = await this.personalFiles();
      const eligibleFiles = files ? new Set([...files.values()].filter(f => f.workspaceId === workspaceId).map(f => f.fileId)) : null;
      const outcomes = await this.readOutcomes();
      const units: EvidenceUnit[] = [];
      const authored: { fileId: string; texts: string[] }[] = [];
      let remaining = MAX_REVIEW_CHARACTERS;
      let reviewed = 0;
      for (const { file, projection } of loaded) {
        // A document shared, moved, deleted or saved again while it was being read is not evidence:
        // what was read may no longer match what is recorded about it.
        if (outcomes.overflow?.includes(file.fileId)) continue;
        const current = files?.get(file.fileId);
        if (files && (current?.workspaceId !== workspaceId || current.revision !== file.revision)) continue;
        const tracked = new Map(outcomes.blocks.filter(b => b.fileId === file.fileId).map(b => [b.blockId, b]));
        // Text the AI wrote and the author left alone, or only touched up, is not the author's writing.
        const isAiText = (blockId: string, fragment: Fragment) => {
          const ai = tracked.get(blockId);
          return Boolean(ai) && (ai!.state === "edited" || ((ai!.state === "accepted" || ai!.state === "kept") && fragmentHash(fragment) === ai!.hash));
        };
        const evidence = documentEvidence(file.fileId, projection, isAiText, { characters: Math.min(remaining, MAX_REVIEW_DOCUMENT_CHARACTERS) });
        remaining -= evidence.characters;
        units.push(...evidence.units);
        authored.push({ fileId: file.fileId, texts: evidence.texts });
        reviewed++;
      }
      const examples = (await this.eligible(await this.read())).filter(e => e.workspaceId === workspaceId);
      const counters = outcomes.counters[workspaceId] ??= emptyCounters();
      const now = this.now();
      const memory = await this.memory.load(workspaceId, getAppLocale(), now);
      const planned = planReview(memory, mergeObservations(observeWriting(units), observeCorrections(examples)),
        { now, locale: memory.locale, eligibleFiles, keptSinceLastReview: counters.kept > 0 });
      memory.lastReviewedAt = now.toISOString();
      memory.reviewedDocuments = reviewed;
      await this.memory.commit(workspaceId, memory, planned.entries);
      outcomes.counters[workspaceId] = { ...emptyCounters(), reviewedAt: now.toISOString() };
      await this.writeOutcomes(outcomes);
      return this.summaryRequest(workspaceId, memory, authored, examples, eligibleFiles, requested, now);
    });
    if (!summary) return;
    // The AI is asked outside the lock: saving and AI requests never wait for it.
    let raw: string;
    try { raw = await this.options.summarize!({ provider: summary.provider, prompt: buildSummaryPrompt(summary.input) }); }
    catch (error) { logLedgerEvent(this.dataDir, "authoring-style-summary-failed", { error: String(error) }); return; }
    const reply = parseSummaryReply(raw, summary.input);
    if (!reply) { logLedgerEvent(this.dataDir, "authoring-style-summary-failed", { error: "Unreadable summary reply" }); return; }
    await this.exclusive(async () => {
      if (generation !== this.generation || !await this.memory.enabled(null) || !await this.memory.enabled(workspaceId)
        || !await this.memory.aiSummary(null) || !await this.memory.aiSummary(workspaceId)) return;
      const files = await this.personalFiles();
      const sources = summary.sources.filter(id => !files || files.get(id)?.workspaceId === workspaceId);
      if (!sources.length) return;
      const now = this.now();
      const memory = await this.memory.load(workspaceId, getAppLocale(), now);
      const planned = planSummary(memory, reply, summary.candidates, { now, locale: memory.locale, sources });
      memory.summary = { hash: summary.hash, at: now.toISOString() };
      await this.memory.commit(workspaceId, memory, planned.entries);
    });
  }

  /**
   * What to ask the AI, or null when there is nothing new to ask about. Only
   * excerpts of the author's own text and a few corrections leave the device,
   * and only to the provider the author last used.
   */
  private async summaryRequest(workspaceId: string, memory: StyleMemory, authored: readonly { fileId: string; texts: string[] }[],
    examples: readonly StyleExample[], eligibleFiles: ReadonlySet<string> | null, requested: boolean, now: Date) {
    if (!this.options.summarize || !await this.memory.aiSummary(null) || !await this.memory.aiSummary(workspaceId)) return null;
    const provider = await this.lastProvider();
    if (!provider) return null;
    const sample: string[] = [];
    const sources: string[] = [];
    const share = Math.floor(MAX_SUMMARY_SAMPLE_CHARACTERS / Math.max(1, authored.filter(a => a.texts.length).length));
    for (const { fileId, texts } of authored) {
      let used = 0;
      for (const text of texts) {
        const excerpt = text.slice(0, MAX_SUMMARY_EXCERPT);
        if (used + excerpt.length > share) break;
        // Text that reads like an instruction to a model is not handed to one.
        if (!excerpt.trim() || isSuspicious(excerpt)) continue;
        sample.push(excerpt);
        used += excerpt.length;
      }
      if (used) sources.push(fileId);
    }
    if (sample.join("").length < MIN_SUMMARY_SAMPLE_CHARACTERS) return null;
    // A correction of accepted AI text is mostly the AI's sentence, so only edits of the author's own text are sent.
    const corrections = this.selectExamples(examples.filter(e => e.source !== "post-accept"), "").flatMap(e => e.before?.text && e.after?.text
      ? [{ before: e.before.text.slice(0, MAX_SUMMARY_EXCERPT), after: e.after.text.slice(0, MAX_SUMMARY_EXCERPT) }] : []).slice(0, MAX_SUMMARY_CORRECTIONS);
    const hash = createHash("sha256").update(JSON.stringify([sample, corrections])).digest("hex");
    if (memory.summary?.hash === hash) return null;
    if (!requested) {
      const last = Math.max(this.summaryAttempts.get(workspaceId) ?? 0, memory.summary ? Date.parse(memory.summary.at) : 0);
      if (now.getTime() - last < SUMMARY_MIN_INTERVAL_MS) return null;
    }
    this.summaryAttempts.set(workspaceId, now.getTime());
    // As for an ordinary request: a habit whose documents were all shared, moved or deleted is not passed on.
    // Nor is an automatic sentence that no longer passes the check made of it.
    const usable = memory.items.filter(i => i.origin === "user"
      || ((!eligibleFiles || i.sources.some(id => eligibleFiles.has(id))) && Boolean(i.key) && itemText(i.key!, i.value, memory.locale) === i.text));
    const suggested = usable.filter(i => i.origin === "auto" && i.basis === "summary" && i.key);
    const input: SummaryInput = {
      locale: memory.locale, sample, corrections,
      existing: scanLines(usable.map(i => i.text.replace(/^- /, "")).join("\n")).text.split("\n").filter(Boolean),
      candidates: suggested.map(i => i.text), declined: memory.declined.filter(isSummaryText),
    };
    return { provider, input, hash, sources, candidates: suggested.map(i => i.key!) };
  }

  /** Remember which AI the author uses, so the review asks that one and no other. */
  noteProvider(provider: AiEditProvider): void {
    if (this.provider === provider) return;
    this.provider = provider;
    void atomicStyleWrite(this.providerPath, JSON.stringify({ provider })).catch(error => {
      logLedgerEvent(this.dataDir, "authoring-style-write-failed", { error: String(error) });
    });
  }

  private async lastProvider(): Promise<AiEditProvider | null> {
    if (this.provider) return this.provider;
    try {
      const { provider } = JSON.parse(await fs.readFile(this.providerPath, "utf8"));
      return provider === "claude" || provider === "chatgpt" || provider === "antigravity" ? provider : null;
    } catch { return null; }
  }

  /** Cancel timers. Pending observations are written by flush(), not here. */
  dispose(): void {
    for (const timer of this.reviewTimers.values()) clearTimeout(timer);
    this.reviewTimers.clear();
  }

  async augmentRunContext(context: AiResourceRunContext, input: {
    workspaceId: string | null; fileId: string; locale: AppLocale; visibleFileIds: ReadonlySet<string>;
  }): Promise<AiResourceRunContext> {
    try { return await this.buildRunContext(context, input); }
    catch (error) {
      logLedgerEvent(this.dataDir, "authoring-style-read-failed", { error: String(error) });
      return context;
    }
  }

  /**
   * The memo as it stands when the request starts. Nothing is learned here and
   * the request is never asked to do learning work: the review runs separately.
   */
  private async buildRunContext(context: AiResourceRunContext, input: {
    workspaceId: string | null;
    fileId: string;
    locale: AppLocale;
    visibleFileIds: ReadonlySet<string>;
  }): Promise<AiResourceRunContext> {
    await this.flush();
    return this.exclusive(async () => {
      const workspaceId = input.workspaceId;
      if (!workspaceId || !input.visibleFileIds.has(input.fileId)) return context;
      if (!await this.memory.enabled(null) || !await this.memory.enabled(workspaceId)) return context;
      const examples = (await this.eligible(await this.read())).filter(e => e.workspaceId === workspaceId && input.visibleFileIds.has(e.fileId));
      const files = await this.personalFiles();
      const stored = await this.memory.load(workspaceId, getAppLocale(), this.now());
      const learned = this.promptText(scanLines(this.injectedMemo(stored, input.locale, files, workspaceId)).text);
      const notes = [await this.memory.readNote(null), await this.memory.readNote(workspaceId)].map(note => this.promptText(scanLines(note.content).text));
      const selected = this.selectExamples(examples, input.fileId);
      const recent = [...examples].reverse().sort((a, b) => Number(b.fileId === input.fileId) - Number(a.fileId === input.fileId));
      const references = [...new Map(recent.map(e => [e.fileId, { fileId: e.fileId, title: isSuspicious(e.title) ? "" : e.title.slice(0, 100), ...(e.blockId !== "$structure" ? { blockId: e.blockId } : {}) }])).values()].slice(0, 8);
      while (JSON.stringify(references).length > 1400) references.pop();
      if (this.due((await this.readOutcomes()).counters[workspaceId])) this.scheduleReview(workspaceId);
      if (!selected.length && !learned && !notes.some(Boolean)) return context;
      const t = createTranslator(input.locale, "prompt");
      const resource: AiResourceContextItem = {
        id: "automatic-authoring-style", kind: "skill", loadMode: "always",
        title: t("authoringStyle.title"), description: t("authoringStyle.description"), tags: [],
        content: `${t("authoringStyle.guidance")}\n${JSON.stringify(selected)}`,
      };
      const memory = [{ scope: "user", manual: notes[0] }, { scope: "workspace", workspaceId, manual: notes[1], learned }];
      const resourceNotes: AiResourceContextItem = {
        id: "authoring-style-memory", kind: "skill", loadMode: "always",
        title: t("authoringStyle.memoryTitle"), description: "", tags: [],
        content: `${t("authoringStyle.memoryGuidance")}\n${JSON.stringify({ memory, references })}`,
      };
      return { ...context, always: [...context.always, ...(selected.length ? [resource] : []), resourceNotes] };
    });
  }

  /** The memo in the language of the request. A habit whose documents were all shared, moved or deleted is left out. */
  private injectedMemo(memory: StyleMemory, locale: AppLocale, files: Map<string, LocalDocumentMetadata> | null, workspaceId: string): string {
    const labels = memoLabels(locale);
    const lines: string[] = [];
    for (const section of SECTION_ORDER) {
      const items = memory.items.filter(item => item.section === section).flatMap(item => {
        if (item.origin === "user") return [item.text];
        if (files && !item.sources.some(id => files.get(id)?.workspaceId === workspaceId)) return [];
        const text = item.key ? itemText(item.key, item.value, locale) : null;
        return text ? [`- ${text}`] : [];
      });
      if (items.length) lines.push(labels.sections[section], ...items);
    }
    return lines.join("\n");
  }

  private selectExamples(examples: readonly StyleExample[], fileId: string): StyleExample[] {
    // Corrections of accepted AI text first, then the document at hand, then the most recent.
    const ranked = [...examples].reverse().sort((a, b) =>
      Number(b.source === "post-accept") - Number(a.source === "post-accept") || Number(b.fileId === fileId) - Number(a.fileId === fileId));
    const selected: StyleExample[] = [];
    const seen = new Set<string>();
    let length = 2;
    for (const example of ranked) {
      // Scan the text itself: JSON escaping would hide a line break inside an instruction.
      if ([example.title, example.before?.text, example.before?.context, example.after?.text, example.after?.context].some(text => text && isSuspicious(text))) continue;
      const fingerprint = createHash("sha256").update(JSON.stringify([example.before, example.after])).digest("hex");
      if (seen.has(fingerprint)) continue;
      const size = JSON.stringify(example).length + (selected.length ? 1 : 0);
      if (length + size > MAX_PROMPT_LENGTH) continue;
      selected.push(example); seen.add(fingerprint); length += size;
      if (selected.length === MAX_PROMPT_EXAMPLES) break;
    }
    return selected;
  }

  private promptText(text: string): string {
    // Bound the encoded JSON too (control characters and escaping can expand it).
    while (JSON.stringify(text).length > 2200) text = text.slice(0, Math.floor(text.length * 0.9));
    return text;
  }

  private async withLock<T>(run: () => Promise<T>): Promise<T> {
    const lock = await acquireFileLock(path.join(this.dataDir, "locks", "authoring-style.lock"), { op: "authoring-style" });
    try { return await run(); } finally { await lock.release(); }
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => this.withLock(run));
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  private async personalFiles(): Promise<Map<string, LocalDocumentMetadata> | null> {
    return this.options.listFiles ? new Map((await this.options.listFiles()).filter(f => !f.sharing && !f.sharingPending).map(f => [f.fileId, f])) : null;
  }

  private async eligible(examples: StyleExample[], respectEnabled = true): Promise<StyleExample[]> {
    const files = await this.personalFiles();
    const enabled = new Map<string, boolean>();
    for (const e of examples) if (!enabled.has(e.workspaceId)) enabled.set(e.workspaceId, !respectEnabled || await this.memory.enabled(e.workspaceId));
    return examples.filter(e => enabled.get(e.workspaceId) && (!files || files.get(e.fileId)?.workspaceId === e.workspaceId));
  }

  private async persist(examples: StyleExample[]): Promise<StyleExample[]> {
    const bounded: StyleExample[] = [];
    let bytes = Buffer.byteLength(JSON.stringify({ version: 1, examples: [] }));
    for (const example of examples.slice(-MAX_EXAMPLES).reverse()) {
      const size = Buffer.byteLength(JSON.stringify(example)) + (bounded.length ? 1 : 0);
      if (bytes + size > MAX_EXAMPLE_FILE_BYTES) continue;
      bounded.unshift(example);
      bytes += size;
    }
    await atomicStyleWrite(this.filePath, JSON.stringify({ version: 1, examples: bounded }));
    return bounded;
  }

  async getProfile(workspaceId: string | null): Promise<AuthoringStyleProfile> {
    await this.flush();
    return this.exclusive(() => this.profile(workspaceId));
  }

  /** Caller holds the lock. Evidence from deleted, shared or moved documents is dropped first. */
  private async profile(workspaceId: string | null): Promise<AuthoringStyleProfile> {
    const stored = await this.read();
    const examples = await this.eligible(stored, false);
    if (examples.length !== stored.length) await this.persist(examples);
    const files = await this.personalFiles();
    const outcomes = await this.readOutcomes();
    if (files) {
      // What the AI wrote stays AI-written when its document moves to another workspace.
      const blocks = outcomes.blocks.filter(b => files.has(b.fileId)).map(b => ({ ...b, workspaceId: files.get(b.fileId)!.workspaceId }));
      if (JSON.stringify(blocks) !== JSON.stringify(outcomes.blocks)) await this.writeOutcomes({ ...outcomes, blocks });
      outcomes.blocks = blocks;
    }
    const inScope = <T extends { workspaceId: string }>(list: readonly T[]) => list.filter(e => workspaceId === null || e.workspaceId === workspaceId);
    const blocks = inScope(outcomes.blocks).filter(b => !b.uncounted);
    const tally: AuthoringStyleOutcomes = {
      kept: blocks.filter(b => b.state === "kept").length,
      edited: blocks.filter(b => b.state === "edited" || b.state === "rewritten").length,
      reverted: blocks.filter(b => b.state === "reverted").length,
      rejected: inScope(outcomes.rejected).length,
    };
    const note = await this.memory.readNote(workspaceId);
    const memory = workspaceId === null ? null : await this.memory.load(workspaceId, getAppLocale(), this.now());
    const generatedContent = memory ? renderMemo(memory, memory.locale) : "";
    return {
      workspaceId, enabled: await this.memory.enabled(workspaceId),
      aiSummary: await this.memory.aiSummary(workspaceId), aiSummaryProvider: this.options.summarize ? await this.lastProvider() : null,
      userContent: note.content, userPath: note.path, revision: note.revision,
      generatedContent, generatedPath: workspaceId === null ? "" : this.memory.generatedPath(workspaceId), generatedRevision: memory?.renderedHash ?? "",
      exampleCount: inScope(examples).length,
      items: (memory?.items ?? []).map(({ id, section, text, origin, basis, support, documents, firstSeenAt, lastConfirmedAt }) =>
        ({ id, section, text, origin, basis, support, documents, firstSeenAt, lastConfirmedAt })),
      pending: (memory?.pending ?? []).map(p => ({ id: p.id, kind: p.kind, reason: p.reason, currentText: p.expectedText,
        proposedText: p.kind === "remove" ? "" : itemText(p.key, p.value, memory!.locale) ?? "", support: p.support })),
      usage: { characters: generatedContent.length, limit: AUTHORING_STYLE_NOTE_LIMIT },
      outcomes: tally,
      lastReviewedAt: memory?.lastReviewedAt ?? null, reviewedDocuments: memory?.reviewedDocuments ?? 0, lastUpdate: memory?.lastUpdate ?? null,
      canUndo: Boolean(memory?.undo.length),
      // Counted with the lines the scan holds back: an added sentence that no longer passes the check for one.
      blockedLines: scanLines(note.content).blocked + scanLines(generatedContent).blocked
        + (memory?.items ?? []).filter(i => i.origin === "auto" && i.key && !isSuspicious(i.text) && !itemText(i.key, i.value, memory!.locale)).length,
    };
  }

  private async change(workspaceId: string | null, run: () => Promise<unknown>): Promise<AuthoringStyleProfile> {
    await this.flush();
    return this.exclusive(async () => { await run(); return this.profile(workspaceId); });
  }

  saveProfile(input: { workspaceId: string | null; content: string; expectedRevision: string }): Promise<AuthoringStyleProfile> {
    return this.change(input.workspaceId, () => this.memory.saveNote(input.workspaceId, input.content, input.expectedRevision));
  }

  /** Hand-edit the learned memo. Changed and added lines become the user's own and are no longer updated automatically. */
  saveLearned(input: { workspaceId: string; content: string; expectedRevision: string }): Promise<AuthoringStyleProfile> {
    return this.change(input.workspaceId, () => this.memory.saveLearned(input.workspaceId, input.content, input.expectedRevision, getAppLocale(), this.now()));
  }

  removeItem(input: { workspaceId: string; id: string }): Promise<AuthoringStyleProfile> {
    return this.change(input.workspaceId, () => this.memory.removeItem(input.workspaceId, input.id, getAppLocale(), this.now()));
  }

  resolvePending(input: { workspaceId: string; id: string; approve: boolean }): Promise<AuthoringStyleProfile> {
    return this.change(input.workspaceId, () => this.memory.resolvePending(input.workspaceId, input.id, input.approve, getAppLocale(), this.now()));
  }

  undo(workspaceId: string): Promise<AuthoringStyleProfile> {
    return this.change(workspaceId, () => this.memory.undo(workspaceId, getAppLocale(), this.now()));
  }

  setEnabled(workspaceId: string | null, enabled: boolean): Promise<AuthoringStyleProfile> {
    return this.change(workspaceId, () => this.memory.setEnabled(workspaceId, enabled));
  }

  setAiSummary(workspaceId: string | null, enabled: boolean): Promise<AuthoringStyleProfile> {
    return this.change(workspaceId, () => this.memory.setAiSummary(workspaceId, enabled));
  }

  async reviewNow(workspaceId: string): Promise<AuthoringStyleProfile> {
    await this.review(workspaceId, true);
    return this.getProfile(workspaceId);
  }

  reset(workspaceId: string | null): Promise<AuthoringStyleProfile> {
    for (const [id, timer] of this.reviewTimers) if (workspaceId === null || id === workspaceId) { clearTimeout(timer); this.reviewTimers.delete(id); }
    return this.change(workspaceId, async () => {
      this.generation++;
      for (const id of [...this.summaryAttempts.keys()]) if (workspaceId === null || id === workspaceId) this.summaryAttempts.delete(id);
      const keep = <T extends { workspaceId: string }>(list: readonly T[]) => list.filter(e => workspaceId !== null && e.workspaceId !== workspaceId);
      await this.persist(keep(await this.read()));
      const outcomes = await this.readOutcomes();
      // Which text the AI wrote is kept (hashes only), so a reset does not make it the author's writing.
      const blocks = outcomes.blocks.map(b => workspaceId === null || b.workspaceId === workspaceId ? { ...b, uncounted: true as const } : b);
      await this.writeOutcomes({ version: 1, blocks, overflow: outcomes.overflow, rejected: keep(outcomes.rejected),
        counters: Object.fromEntries(Object.entries(outcomes.counters).filter(([id]) => workspaceId !== null && id !== workspaceId)) });
      if (workspaceId === null) await this.memory.resetAllGenerated();
      else await this.memory.resetGenerated(workspaceId);
    });
  }

  private async readOutcomes(): Promise<Outcomes> {
    try {
      const stat = await fs.stat(this.outcomesPath);
      if (stat.size > MAX_EXAMPLE_FILE_BYTES) throw new Error("Authoring outcome data exceeds the size limit");
      const data = JSON.parse(await fs.readFile(this.outcomesPath, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.blocks) || !Array.isArray(data.rejected) || !data.counters || typeof data.counters !== "object") throw new Error("Invalid authoring outcome data");
      const text = (value: unknown, max = 256) => typeof value === "string" && value.length <= max;
      const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
      return {
        version: 1,
        blocks: data.blocks.filter((b: AiBlock) => text(b?.workspaceId) && text(b.fileId) && text(b.blockId) && text(b.hash, 64) && text(b.previousHash, 64)
          && Number.isSafeInteger(b.acceptedRevision) && text(b.acceptedAt, 40) && ["accepted", "kept", "edited", "rewritten", "reverted"].includes(b.state))
          .map(({ uncounted, ...b }: AiBlock) => uncounted === true ? { ...b, uncounted } : b).slice(-MAX_AI_BLOCKS),
        rejected: data.rejected.filter((r: Outcomes["rejected"][number]) => text(r?.workspaceId) && text(r.fileId) && text(r.at, 40)).slice(-MAX_REJECTIONS),
        overflow: Array.isArray(data.overflow) ? data.overflow.filter((id: unknown) => text(id)).slice(-MAX_OVERFLOW_FILES) : [],
        counters: Object.fromEntries(Object.entries(data.counters as Record<string, Partial<Counters>>).slice(0, 500).map(([id, c]) => [id, {
          saves: count(c?.saves), corrections: count(c?.corrections), rejections: count(c?.rejections), kept: count(c?.kept),
          reviewedAt: text(c?.reviewedAt, 40) ? c.reviewedAt as string : null,
        }])),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") logLedgerEvent(this.dataDir, "authoring-style-read-failed", { error: String(error) });
      return { version: 1, blocks: [], rejected: [], counters: {} };
    }
  }

  private async writeOutcomes(outcomes: Outcomes): Promise<void> {
    // Past the limit the oldest marks go. Their documents may still hold that AI text, so from then
    // on those documents are left out of what is read as the author's writing.
    const dropped = outcomes.blocks.slice(0, Math.max(0, outcomes.blocks.length - MAX_AI_BLOCKS)).map(b => b.fileId);
    const overflow = [...new Set([...(outcomes.overflow ?? []), ...dropped])].slice(-MAX_OVERFLOW_FILES);
    await atomicStyleWrite(this.outcomesPath, JSON.stringify({ ...outcomes, overflow, blocks: outcomes.blocks.slice(-MAX_AI_BLOCKS), rejected: outcomes.rejected.slice(-MAX_REJECTIONS) }));
  }

  private async read(): Promise<StyleExample[]> {
    try {
      const stat = await fs.stat(this.filePath);
      if (stat.size > MAX_EXAMPLE_FILE_BYTES) throw new Error("Authoring style data exceeds the size limit");
      const data = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.examples)) throw new Error("Invalid authoring style data");
      return data.examples.filter((e: StyleExample) => typeof e?.workspaceId === "string" && typeof e.fileId === "string"
        && typeof e.blockId === "string" && e.blockId.length <= 256 && typeof e.title === "string" && e.title.length <= 1000 && Number.isSafeInteger(e.revision)
        && (e.source === undefined || e.source === "manual" || e.source === "post-accept")
        && [e.before, e.after].every(f => f === null || (typeof f?.area === "string" && typeof f.text === "string" && f.text.length <= MAX_FRAGMENT_LENGTH
          && typeof f.format === "string" && f.format.length <= MAX_FRAGMENT_LENGTH && typeof f.context === "string" && f.context.length <= 300))).slice(-MAX_EXAMPLES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logLedgerEvent(this.dataDir, "authoring-style-read-failed", { error: String(error) });
      }
      return [];
    }
  }
}
