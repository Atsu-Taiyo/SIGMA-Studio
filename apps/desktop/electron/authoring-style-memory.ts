import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { AUTHORING_STYLE_NOTE_LIMIT, type AuthoringStyleSection } from "@/lib/ai/authoring-style";
import type { AppLocale } from "@/lib/i18n";
import { itemText, memoLabels, SECTION_ORDER, sectionOf } from "./authoring-style-items";

export const styleHash = (text: string) => createHash("sha256").update(text).digest("hex");

export async function boundedRead(file: string, limit = 30_000): Promise<string> {
  try {
    // Reject links so a user-editable memory cannot redirect writes/reads outside its directory.
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > limit * 4) throw new Error("Invalid authoring memory file");
    const text = await fs.readFile(file, "utf8");
    if (text.length > limit) throw new Error("Authoring memory exceeds the size limit");
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export async function atomicStyleWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

export interface StyleItem {
  id: string;
  /** The habit this sentence states; one item per key. Null for a line the user wrote. */
  key: string | null;
  value: string;
  section: AuthoringStyleSection;
  text: string;
  origin: "auto" | "user";
  basis: "writing" | "corrections" | null;
  support: number;
  documents: number;
  sources: string[];
  firstSeenAt: string;
  lastConfirmedAt: string;
  status: "active" | "stale";
  staleSince?: string;
}

export interface PendingChange {
  id: string;
  kind: "add" | "rewrite" | "remove";
  reason: "contradicted" | "stale" | "limit";
  key: string;
  value: string;
  /** The sentence this change was staged against. Approval is refused once it differs. */
  expectedText: string;
  basis: "writing" | "corrections";
  support: number;
  documents: number;
  sources: string[];
  createdAt: string;
}

interface UndoSnapshot { at: string; reason: string; items: StyleItem[]; suppressed: string[]; pending: PendingChange[] }

export interface StyleMemory {
  version: 2;
  locale: AppLocale;
  items: StyleItem[];
  /** Habits whose sentence the user deleted or rewrote. They are not learned again until a reset. */
  suppressed: string[];
  pending: PendingChange[];
  /** Staged changes the user declined; the same change is not offered twice. */
  dismissed: string[];
  undo: UndoSnapshot[];
  renderedHash: string;
  lastReviewedAt: string | null;
  reviewedDocuments: number;
  lastUpdate: { at: string; added: number; staged: number } | null;
}

export interface LedgerDraft { actor: "review" | "user"; action: string; key?: string; before?: string; after?: string }

const MAX_UNDO = 5;
const MAX_LEDGER_LINES = 400;
const MEMORY_FILE_LIMIT = 400_000;
// Adopting a hand edit adds headings, so the stored text may run slightly past the editing limit.
const MEMO_READ_LIMIT = AUTHORING_STYLE_NOTE_LIMIT + 1000;
const GENERATED_FILES = ["learned.md", "learned.sha256", "learned-evidence.json", "memory.json", "ledger.jsonl"];

const emptyMemory = (locale: AppLocale): StyleMemory => ({
  version: 2, locale, items: [], suppressed: [], pending: [], dismissed: [], undo: [],
  renderedHash: styleHash(""), lastReviewedAt: null, reviewedDocuments: 0, lastUpdate: null,
});

const line = (item: StyleItem) => item.origin === "auto" ? `- ${item.text}` : item.text;

/** The memo as the user reads and edits it. Evidence counts stay out so the text is stable. */
export function renderMemo(memory: Pick<StyleMemory, "items">, locale: AppLocale): string {
  if (!memory.items.length) return "";
  const labels = memoLabels(locale);
  const lines = [labels.title, "", labels.policy];
  for (const section of SECTION_ORDER) {
    const items = memory.items.filter(i => i.section === section && i.status === "active");
    if (items.length) lines.push("", labels.sections[section], ...items.map(line));
  }
  const stale = memory.items.filter(i => i.status === "stale");
  if (stale.length) lines.push("", labels.stale, ...stale.map(line));
  return `${lines.join("\n")}\n`;
}

export function snapshotForUndo(memory: StyleMemory, reason: string, at: string): void {
  memory.undo.push(structuredClone({ at, reason, items: memory.items, suppressed: memory.suppressed, pending: memory.pending }));
  memory.undo = memory.undo.slice(-MAX_UNDO);
}

/**
 * Adopt a hand-edited memo. Lines the user left alone keep their item; a new or
 * changed line becomes a user item; an automatic sentence that disappeared is
 * suppressed so the review cannot bring it back.
 */
function reconcile(memory: StyleMemory, content: string, now: string): LedgerDraft[] {
  const labels = memoLabels(memory.locale);
  const headings = new Map<string, AuthoringStyleSection | "stale">([...SECTION_ORDER.map(s => [labels.sections[s], s] as const), [labels.stale, "stale"]]);
  const unclaimed = [...memory.items];
  const items: StyleItem[] = [];
  const entries: LedgerDraft[] = [];
  let section: AuthoringStyleSection = "custom";
  for (const raw of content.split("\n")) {
    const text = raw.trimEnd();
    if (!text.trim() || text === labels.title || text === labels.policy) continue;
    const heading = headings.get(text);
    if (heading) { section = heading === "stale" ? "custom" : heading; continue; }
    const index = unclaimed.findIndex(item => line(item) === text);
    if (index >= 0) { items.push(...unclaimed.splice(index, 1)); continue; }
    items.push({ id: `user:${styleHash(`${text}\n${items.length}`).slice(0, 16)}`, key: null, value: "", section, text, origin: "user",
      basis: null, support: 0, documents: 0, sources: [], firstSeenAt: now, lastConfirmedAt: now, status: "active" });
    entries.push({ actor: "user", action: "user-edit", after: text });
  }
  for (const item of unclaimed) {
    if (item.key && !memory.suppressed.includes(item.key)) memory.suppressed.push(item.key);
    entries.push({ actor: "user", action: "user-remove", ...(item.key ? { key: item.key } : {}), before: item.text });
  }
  if (!entries.length) return entries;
  snapshotForUndo(memory, "user-edit", now);
  memory.items = items;
  memory.pending = memory.pending.filter(p => !memory.suppressed.includes(p.key));
  return entries;
}

function parseMemory(text: string, locale: AppLocale): StyleMemory {
  const data = JSON.parse(text);
  if (data?.version !== 2 || !Array.isArray(data.items) || !Array.isArray(data.pending)) throw new Error("Invalid authoring memory");
  const strings = (value: unknown, max: number) => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").slice(-max) : [];
  const items = (list: unknown[]): StyleItem[] => list.filter((i): i is StyleItem => Boolean(i) && typeof i === "object"
    && typeof (i as StyleItem).id === "string" && typeof (i as StyleItem).text === "string" && (i as StyleItem).text.length <= AUTHORING_STYLE_NOTE_LIMIT
    && ((i as StyleItem).origin === "auto" || (i as StyleItem).origin === "user") && SECTION_ORDER.includes((i as StyleItem).section)
    && ((i as StyleItem).status === "active" || (i as StyleItem).status === "stale") && Array.isArray((i as StyleItem).sources)).slice(0, 200);
  const pending = (list: unknown[]): PendingChange[] => list.filter((p): p is PendingChange => Boolean(p) && typeof p === "object"
    && typeof (p as PendingChange).id === "string" && typeof (p as PendingChange).key === "string" && typeof (p as PendingChange).value === "string"
    && ["add", "rewrite", "remove"].includes((p as PendingChange).kind)).slice(0, 60);
  return {
    ...emptyMemory(locale),
    locale: data.locale === "en" || data.locale === "ja" ? data.locale : locale,
    items: items(data.items), suppressed: strings(data.suppressed, 100), pending: pending(data.pending), dismissed: strings(data.dismissed, 60),
    undo: (Array.isArray(data.undo) ? data.undo : []).slice(-MAX_UNDO).map((u: UndoSnapshot) => ({
      at: String(u?.at ?? ""), reason: String(u?.reason ?? ""), items: items(Array.isArray(u?.items) ? u.items : []),
      suppressed: strings(u?.suppressed, 100), pending: pending(Array.isArray(u?.pending) ? u.pending : []),
    })),
    renderedHash: typeof data.renderedHash === "string" ? data.renderedHash : styleHash(""),
    lastReviewedAt: typeof data.lastReviewedAt === "string" ? data.lastReviewedAt : null,
    reviewedDocuments: Number.isSafeInteger(data.reviewedDocuments) ? data.reviewedDocuments : 0,
    lastUpdate: data.lastUpdate && typeof data.lastUpdate.at === "string"
      ? { at: data.lastUpdate.at, added: Number(data.lastUpdate.added) || 0, staged: Number(data.lastUpdate.staged) || 0 } : null,
  };
}

/** Callers hold the cross-process style lock. Automatic updates never write the user note. */
export class AuthoringStyleMemory {
  constructor(private readonly root: string) {}

  private dir(workspaceId: string | null): string {
    return workspaceId === null ? this.root : path.join(this.root, "workspaces", styleHash(workspaceId));
  }

  generatedPath(workspaceId: string): string { return path.join(this.dir(workspaceId), "learned.md"); }

  async enabled(workspaceId: string | null): Promise<boolean> {
    const text = await boundedRead(path.join(this.dir(workspaceId), "settings.json"), 1000);
    return !text || JSON.parse(text).enabled !== false;
  }

  async setEnabled(workspaceId: string | null, enabled: boolean): Promise<void> {
    await atomicStyleWrite(path.join(this.dir(workspaceId), "settings.json"), JSON.stringify({ enabled }));
  }

  async readNote(workspaceId: string | null): Promise<{ content: string; path: string; revision: string }> {
    const file = path.join(this.dir(workspaceId), workspaceId === null ? "user.md" : "workspace.md");
    const content = await boundedRead(file, AUTHORING_STYLE_NOTE_LIMIT);
    return { content, path: file, revision: styleHash(content) };
  }

  async saveNote(workspaceId: string | null, content: string, expectedRevision: string): Promise<void> {
    if (typeof content !== "string" || content.length > AUTHORING_STYLE_NOTE_LIMIT) throw new Error("Style note exceeds 3000 characters");
    const note = await this.readNote(workspaceId);
    if (note.revision !== expectedRevision) throw new Error("Style note changed. Reload before saving.");
    await atomicStyleWrite(note.path, content);
  }

  /** Read the memo, first adopting any edit made to learned.md by hand. */
  async load(workspaceId: string, locale: AppLocale, now: Date): Promise<StyleMemory> {
    const dir = this.dir(workspaceId);
    const stored = await boundedRead(path.join(dir, "memory.json"), MEMORY_FILE_LIMIT);
    const content = await boundedRead(path.join(dir, "learned.md"), MEMO_READ_LIMIT);
    let memory: StyleMemory;
    if (stored) memory = parseMemory(stored, locale);
    else {
      memory = emptyMemory(locale);
      // A first-generation summary was one generated text. Keep it only if its author edited it.
      const baseline = await boundedRead(path.join(dir, "learned.sha256"), 100);
      if (content && baseline === styleHash(content)) memory.renderedHash = styleHash(content);
    }
    const entries = styleHash(content) === memory.renderedHash ? [] : reconcile(memory, content, now.toISOString());
    const relabel = memory.locale !== locale;
    if (relabel) {
      for (const item of memory.items) if (item.origin === "auto" && item.key) item.text = itemText(item.key, item.value, locale) ?? item.text;
      memory.locale = locale;
    }
    if (entries.length || relabel || renderMemo(memory, locale) !== content) await this.commit(workspaceId, memory, entries);
    return memory;
  }

  /** Write the memo and append what changed, and who changed it, to the ledger. */
  async commit(workspaceId: string, memory: StyleMemory, entries: readonly LedgerDraft[]): Promise<void> {
    const dir = this.dir(workspaceId);
    const content = renderMemo(memory, memory.locale);
    const before = memory.renderedHash;
    memory.renderedHash = styleHash(content);
    await atomicStyleWrite(path.join(dir, "learned.md"), content);
    await atomicStyleWrite(path.join(dir, "memory.json"), JSON.stringify(memory));
    if (!entries.length) return;
    const ledger = path.join(dir, "ledger.jsonl");
    const at = new Date().toISOString();
    await fs.appendFile(ledger, entries.map(entry => `${JSON.stringify({ at, ...entry, beforeHash: before, afterHash: memory.renderedHash })}\n`).join(""), { mode: 0o600 });
    const lines = (await fs.readFile(ledger, "utf8")).split("\n").filter(Boolean);
    if (lines.length > MAX_LEDGER_LINES) await atomicStyleWrite(ledger, `${lines.slice(-Math.floor(MAX_LEDGER_LINES * 0.75)).join("\n")}\n`);
  }

  /** Save the memo edited in the settings pane. Goes through the same adoption as an external edit. */
  async saveLearned(workspaceId: string, content: string, expectedRevision: string, locale: AppLocale, now: Date): Promise<StyleMemory> {
    if (typeof content !== "string" || content.length > AUTHORING_STYLE_NOTE_LIMIT) throw new Error("Style memo exceeds 3000 characters");
    const current = await this.load(workspaceId, locale, now);
    if (current.renderedHash !== expectedRevision) throw new Error("Style memo changed. Reload before saving.");
    await atomicStyleWrite(path.join(this.dir(workspaceId), "learned.md"), content);
    return this.load(workspaceId, locale, now);
  }

  /** Apply or decline a staged change. The target must still read as it did when the change was staged. */
  async resolvePending(workspaceId: string, id: string, approve: boolean, locale: AppLocale, now: Date): Promise<StyleMemory> {
    const memory = await this.load(workspaceId, locale, now);
    const index = memory.pending.findIndex(p => p.id === id);
    if (index < 0) throw new Error("Staged style change not found");
    const change = memory.pending[index];
    const at = now.toISOString();
    if (!approve) {
      memory.pending.splice(index, 1);
      memory.dismissed = [...memory.dismissed, `${change.kind}:${change.key}:${change.value}`].slice(-60);
      await this.commit(workspaceId, memory, [{ actor: "user", action: "dismiss", key: change.key }]);
      return memory;
    }
    const item = memory.items.find(i => i.key === change.key);
    const text = itemText(change.key, change.value, locale);
    if (change.kind === "add" ? Boolean(item) || !text : !item || item.origin !== "auto" || item.text !== change.expectedText || (change.kind === "rewrite" && !text)) {
      throw new Error("Style memo changed. The staged change no longer applies.");
    }
    if (change.kind !== "remove") {
      const next = change.kind === "add" ? [...memory.items, { section: sectionOf(change.key), status: "active", origin: "auto", text }] : memory.items.map(i => i === item ? { ...i, text } : i);
      if (renderMemo({ items: next as StyleItem[] }, locale).length > AUTHORING_STYLE_NOTE_LIMIT) throw new Error("Style memo is full. Remove an item before adding another.");
    }
    snapshotForUndo(memory, "approve", at);
    memory.pending.splice(index, 1);
    const evidence = { basis: change.basis, support: change.support, documents: change.documents, sources: change.sources, lastConfirmedAt: at };
    if (change.kind === "remove") memory.items = memory.items.filter(i => i !== item);
    else if (change.kind === "rewrite") Object.assign(item!, evidence, { value: change.value, text, status: "active" });
    else memory.items.push({ id: `auto:${change.key}`, key: change.key, value: change.value, section: sectionOf(change.key), text: text!, origin: "auto", ...evidence, firstSeenAt: at, status: "active" });
    await this.commit(workspaceId, memory, [{ actor: "user", action: `approve-${change.kind}`, key: change.key, before: change.expectedText, after: change.kind === "remove" ? "" : text! }]);
    return memory;
  }

  /** Step back to the memo before its last change. Undoing again returns to where you were. */
  async undo(workspaceId: string, locale: AppLocale, now: Date): Promise<StyleMemory> {
    const memory = await this.load(workspaceId, locale, now);
    const previous = memory.undo.pop();
    if (!previous) throw new Error("Nothing to undo");
    const current = structuredClone({ at: now.toISOString(), reason: "rollback", items: memory.items, suppressed: memory.suppressed, pending: memory.pending });
    Object.assign(memory, { items: previous.items, suppressed: previous.suppressed, pending: previous.pending });
    memory.undo.push(current);
    await this.commit(workspaceId, memory, [{ actor: "user", action: "rollback", before: previous.reason }]);
    return memory;
  }

  async resetAllGenerated(): Promise<void> {
    for (const name of GENERATED_FILES) await fs.rm(path.join(this.root, name), { force: true });
    let scopes;
    try { scopes = await fs.readdir(path.join(this.root, "workspaces"), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const dir of scopes) {
      if (!dir.isDirectory() || !/^[a-f0-9]{64}$/.test(dir.name)) continue;
      for (const name of GENERATED_FILES) await fs.rm(path.join(this.root, "workspaces", dir.name, name), { force: true });
    }
  }

  async resetGenerated(workspaceId: string): Promise<void> {
    for (const name of GENERATED_FILES) await fs.rm(path.join(this.dir(workspaceId), name), { force: true });
  }
}
