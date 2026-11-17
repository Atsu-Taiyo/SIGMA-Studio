import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { AUTHORING_STYLE_NOTE_LIMIT, type AuthoringStyleSection, type AuthoringStyleSyncView } from "@/lib/ai/authoring-style";
import type { AppLocale } from "@/lib/i18n";
import { itemText, SECTION_ORDER, sectionOf } from "./authoring-style-items";
import { atomicStyleWrite, renderMemo, type AuthoringStyleMemory, type LedgerDraft, type StyleItem, type StyleMemory } from "./authoring-style-memory";

/**
 * Keeps the learned memo, the notes and the learning settings the same on every
 * device of one account. The files on this device stay the source of truth: sync
 * merges a copy held by the collaboration server into them and sends the result
 * back. Document text, correction examples and the record of AI-written blocks
 * never leave the device.
 */

/** The server's per-user store, reached with the signed-in account's token. */
export interface PersonalDataPort {
  read(key: string): Promise<{ revision: string | null; content: unknown }>;
  /** Writes only when the stored revision is still `expectedRevision` (null: nothing stored yet). */
  write(key: string, content: unknown, expectedRevision: string | null): Promise<{ revision: string } | "conflict">;
  removeAll(): Promise<void>;
}

export const MAX_SYNCED_ITEMS = 400;
export const MAX_SYNCED_LEDGER_LINES = 200;
export const MAX_BUNDLE_BYTES = 256 * 1024;
const MAX_LEDGER_LINE = 2000;
const GLOBAL_KEY = "style-global";
const PROVIDERS = ["claude", "chatgpt", "antigravity"];

/** A habit as other devices see it: no document ids, only which devices hold evidence for it. */
export interface SyncedItem {
  id: string;
  key: string | null;
  value: string;
  section: AuthoringStyleSection;
  text: string;
  origin: "auto" | "user";
  basis: StyleItem["basis"];
  support: number;
  documents: number;
  firstSeenAt: string;
  lastConfirmedAt: string;
  devices: string[];
}

interface Settings { enabled: boolean; aiSummary: boolean }
interface Learned { generation: number; items: SyncedItem[]; suppressed: string[]; dismissed: string[]; declined: string[] }
export interface WorkspaceBundle extends Learned {
  version: 1; kind: "workspace"; locale: AppLocale; note: string; settings: Settings; ledger: string[]; updatedAt: string; device: string;
}
export interface GlobalBundle { version: 1; kind: "global"; note: string; settings: Settings; provider: string | null; updatedAt: string; device: string }

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const strings = (value: unknown, max: number, length: number) => Array.isArray(value) ? value.filter((v): v is string => text(v, length)).slice(-max) : [];
const settings = (value: unknown): Settings => ({ enabled: !isRecord(value) || value.enabled !== false, aiSummary: !isRecord(value) || value.aiSummary !== false });
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;

/** Null for anything this version cannot read. Such a copy is neither merged nor overwritten. */
export function parseBundle(value: unknown, kind: "workspace"): WorkspaceBundle | null;
export function parseBundle(value: unknown, kind: "global"): GlobalBundle | null;
export function parseBundle(value: unknown, kind: "workspace" | "global"): WorkspaceBundle | GlobalBundle | null {
  if (!isRecord(value) || value.version !== 1 || value.kind !== kind || !text(value.note, AUTHORING_STYLE_NOTE_LIMIT)) return null;
  const common = { version: 1 as const, note: value.note, settings: settings(value.settings),
    updatedAt: text(value.updatedAt, 40) ? value.updatedAt : "", device: text(value.device, 64) ? value.device : "" };
  if (kind === "global") return { ...common, kind, provider: PROVIDERS.includes(value.provider as string) ? value.provider as string : null };
  if (!Array.isArray(value.items)) return null;
  const items = value.items.filter((item): item is SyncedItem => isRecord(item) && text(item.id, 200) && (item.key === null || text(item.key, 200))
    && text(item.value, 200) && text(item.text, AUTHORING_STYLE_NOTE_LIMIT) && (item.origin === "auto" || item.origin === "user")
    && SECTION_ORDER.includes(item.section as AuthoringStyleSection) && text(item.firstSeenAt, 40) && text(item.lastConfirmedAt, 40))
    .slice(0, MAX_SYNCED_ITEMS).map(item => ({
      id: item.id, key: item.key, value: item.value, section: item.section, text: item.text, origin: item.origin,
      basis: item.basis === "writing" || item.basis === "corrections" || item.basis === "summary" ? item.basis : null,
      support: count(item.support), documents: count(item.documents), firstSeenAt: item.firstSeenAt, lastConfirmedAt: item.lastConfirmedAt,
      devices: strings(item.devices, 20, 64),
    }));
  return { ...common, kind, locale: value.locale === "en" ? "en" : "ja", generation: count(value.generation), items,
    suppressed: strings(value.suppressed, 100, 200), dismissed: strings(value.dismissed, 60, 500), declined: strings(value.declined, 30, 200),
    ledger: strings(value.ledger, MAX_SYNCED_LEDGER_LINES, MAX_LEDGER_LINE) };
}

/** One habit per key; a line the user wrote is the line itself. */
const identity = (item: Pick<SyncedItem, "origin" | "key" | "section" | "text">) =>
  item.origin === "auto" && item.key ? `auto:${item.key}` : `user:${item.section}:${item.text}`;
/** What a habit says, apart from how well it is supported. Automatic sentences are compared by value: their text depends on the language. */
const statement = (item: Pick<SyncedItem, "origin" | "key" | "value" | "section" | "text">) =>
  item.origin === "auto" && item.key ? `${item.key}\n${item.value}` : `${item.section}\n${item.text}`;

/** The value both sides agree on, the one side's change, or on a true conflict the copy the server already holds. */
function pick<T>(base: T | undefined, local: T, remote: T): T {
  const same = (a: T | undefined, b: T) => JSON.stringify(a) === JSON.stringify(b);
  return same(local, remote) ? local : base !== undefined && same(base, remote) ? local : remote;
}

/** A switch both sides set differently stays off: sync never turns learning, or sending text to an AI, on by itself. */
function pickSwitch(base: boolean | undefined, local: boolean, remote: boolean): boolean {
  return local === remote ? local : base !== undefined && base === remote ? local : base !== undefined && base === local ? remote : false;
}
const mergeSettings = (base: Settings | undefined, local: Settings, remote: Settings): Settings => ({
  enabled: pickSwitch(base?.enabled, local.enabled, remote.enabled), aiSummary: pickSwitch(base?.aiSummary, local.aiSummary, remote.aiSummary),
});

/** Union of two lists, minus what either side removed since they last agreed. */
export function mergeList(base: readonly string[] | undefined, local: readonly string[], remote: readonly string[], max: number): string[] {
  const removed = new Set((base ?? []).filter(value => !local.includes(value) || !remote.includes(value)));
  return [...new Set([...local, ...remote])].filter(value => !removed.has(value)).slice(-max);
}

export function mergeItems(base: readonly SyncedItem[] | undefined, local: readonly SyncedItem[], remote: readonly SyncedItem[]): SyncedItem[] {
  const index = (list: readonly SyncedItem[]) => new Map(list.map(item => [identity(item), item]));
  const before = index(base ?? []);
  const theirs = index(remote);
  const result: SyncedItem[] = [];
  const seen = new Set<string>();
  for (const mine of local) {
    const id = identity(mine);
    if (seen.has(id)) continue;
    seen.add(id);
    const other = theirs.get(id);
    const was = before.get(id);
    if (!other) {
      // Removed on another device, unless it was changed here since.
      if (!was || statement(was) !== statement(mine)) result.push(mine);
      continue;
    }
    const winner = statement(mine) === statement(other) || (was && statement(was) === statement(other)) ? mine : other;
    const fresher = other.lastConfirmedAt > mine.lastConfirmedAt ? other : mine;
    result.push({ ...winner, id: mine.id, basis: winner === mine ? mine.basis : other.basis, support: fresher.support, documents: fresher.documents,
      firstSeenAt: other.firstSeenAt < mine.firstSeenAt ? other.firstSeenAt : mine.firstSeenAt, lastConfirmedAt: fresher.lastConfirmedAt,
      devices: [...new Set([...mine.devices, ...other.devices])].slice(0, 20) });
  }
  for (const other of remote) {
    const id = identity(other);
    if (seen.has(id)) continue;
    seen.add(id);
    const was = before.get(id);
    // Removed here, unless another device changed it since.
    if (!was || statement(was) !== statement(other)) result.push(other);
  }
  return result;
}

/**
 * Merge two versions of a note by line. A line either side added stays; a line
 * one side removed and the other left alone goes. Nothing anyone wrote is
 * dropped without its author removing it.
 */
export function mergeNote(base: string | undefined, local: string, remote: string): string {
  if (local === remote || (base !== undefined && remote === base)) return local;
  if (base !== undefined && local === base) return remote;
  const was = new Set((base ?? "").split("\n"));
  const mine = local.split("\n");
  const theirs = remote.split("\n");
  const kept = mine.filter(line => !line.trim() || !was.has(line) || theirs.includes(line));
  const added = theirs.filter(line => line.trim() && !mine.includes(line) && !was.has(line));
  return (local.trim() ? [...kept, ...added] : added).join("\n");
}

function mergeLedger(local: readonly string[], remote: readonly string[]): string[] {
  const at = (line: string) => { try { const value = JSON.parse(line).at; return typeof value === "string" ? value : ""; } catch { return ""; } };
  return [...new Set([...local, ...remote])].map((line, index) => ({ line, at: at(line), index }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.index - b.index).map(entry => entry.line);
}

/** A reset counts up the generation. The side that reset last replaces the other's learned habits instead of being merged with them. */
function mergeLearned(base: Learned | undefined, local: Learned, remote: Learned): Learned {
  if (local.generation !== remote.generation) {
    const { generation, items, suppressed, dismissed, declined } = local.generation > remote.generation ? local : remote;
    return { generation, items, suppressed, dismissed, declined };
  }
  const was = base && base.generation === local.generation ? base : undefined;
  const suppressed = mergeList(was?.suppressed, local.suppressed, remote.suppressed, 100);
  const declined = mergeList(was?.declined, local.declined, remote.declined, 30);
  return {
    generation: local.generation, suppressed, declined, dismissed: mergeList(was?.dismissed, local.dismissed, remote.dismissed, 60),
    // A removal always wins: no device learns again, or keeps, what its author took out.
    items: mergeItems(was?.items, local.items, remote.items)
      .filter(item => item.origin !== "auto" || !item.key || (!suppressed.includes(item.key) && !(item.basis === "summary" && declined.includes(item.text)))),
  };
}

export function mergeWorkspace(base: WorkspaceBundle | null, local: WorkspaceBundle, remote: WorkspaceBundle | null): WorkspaceBundle {
  if (!remote) return local;
  return {
    ...local, ...mergeLearned(base ?? undefined, local, remote),
    note: mergeNote(base?.note, local.note, remote.note),
    settings: mergeSettings(base?.settings, local.settings, remote.settings),
    // A reset empties the ledger too.
    ledger: local.generation !== remote.generation ? (local.generation > remote.generation ? local : remote).ledger
      : mergeLedger(local.ledger, remote.ledger).slice(-MAX_SYNCED_LEDGER_LINES),
  };
}

export function mergeGlobal(base: GlobalBundle | null, local: GlobalBundle, remote: GlobalBundle | null): GlobalBundle {
  if (!remote) return local;
  return {
    ...local, note: mergeNote(base?.note, local.note, remote.note),
    settings: mergeSettings(base?.settings, local.settings, remote.settings),
    provider: pick(base?.provider, local.provider, remote.provider),
  };
}

/** Equal as far as other devices are concerned: who wrote the copy, and when, is not content. */
const comparable = (bundle: WorkspaceBundle | GlobalBundle) => JSON.stringify({ ...bundle, updatedAt: "", device: "" });

interface ScopeState { revision: string | null; base: WorkspaceBundle | GlobalBundle | null; syncedAt: string | null }
interface SyncState {
  version: 1;
  enabled: boolean;
  /** A random name for this installation. It says nothing about the machine or its user. */
  device: string;
  /** Hash of the account these files were last merged with. */
  account: string | null;
  /** The server key each local workspace syncs under. Workspace ids differ from device to device. */
  keys: Record<string, string>;
  generations: Record<string, number>;
  scopes: Record<string, ScopeState>;
  lastSyncedAt: string | null;
  problem: AuthoringStyleSyncView["state"] | null;
}

export interface SyncHost {
  root: string;
  memory: AuthoringStyleMemory;
  /** Runs under the same lock as every other change to the style files. */
  exclusive<T>(run: () => Promise<T>): Promise<T>;
  now(): Date;
  locale(): AppLocale;
  /** Personal workspaces on this device. Shared ones are never learned from, so never synced. */
  workspaces(): Promise<{ id: string; name: string }[]>;
  provider(): Promise<string | null>;
  setProvider(provider: string): Promise<void>;
  /** Caller holds the lock. Drop this device's evidence for a workspace that was reset on another device. */
  forget(workspaceId: string): Promise<void>;
  log(error: unknown): void;
}

export interface SyncAccount { client: PersonalDataPort; userId(): string | null; /** False when the app was built without a server. */ available?(): boolean }

class SyncProblem extends Error { constructor(readonly state: NonNullable<SyncState["problem"]>) { super(state); } }

export class AuthoringStyleSync {
  private running: Promise<void> | null = null;
  private again = false;
  private timer?: ReturnType<typeof setTimeout>;
  private lastAttempt = 0;

  constructor(private readonly host: SyncHost, private readonly account: SyncAccount | null) {}

  private get file() { return path.join(this.host.root, "sync.json"); }

  private async state(): Promise<SyncState> {
    let data: unknown = null;
    try { data = JSON.parse(await fs.readFile(this.file, "utf8")); } catch { /* first use, or unreadable: start over without a merge base */ }
    const value = isRecord(data) && data.version === 1 ? data : {};
    const record = <T>(input: unknown, valid: (entry: unknown) => entry is T): Record<string, T> =>
      isRecord(input) ? Object.fromEntries(Object.entries(input).filter((entry): entry is [string, T] => valid(entry[1])).slice(0, 500)) : {};
    return {
      version: 1, enabled: value.enabled === true, device: text(value.device, 64) && value.device ? value.device : randomUUID(),
      account: text(value.account, 64) ? value.account : null,
      keys: record(value.keys, (entry): entry is string => text(entry, 80)),
      generations: record(value.generations, (entry): entry is number => Number.isSafeInteger(entry)),
      scopes: record(value.scopes, (entry): entry is ScopeState => isRecord(entry) && (entry.revision === null || text(entry.revision, 200))),
      lastSyncedAt: text(value.lastSyncedAt, 40) ? value.lastSyncedAt : null,
      problem: typeof value.problem === "string" ? value.problem as SyncState["problem"] : null,
    };
  }

  private write(state: SyncState): Promise<void> { return atomicStyleWrite(this.file, JSON.stringify(state)); }

  /** Caller holds the style lock. */
  async view(): Promise<AuthoringStyleSyncView> {
    const state = await this.state();
    const userId = this.account?.userId() ?? null;
    const available = Boolean(this.account) && this.account!.available?.() !== false;
    const status: AuthoringStyleSyncView["state"] = !available ? "unavailable" : !state.enabled ? "off" : !userId ? "signed-out"
      : state.account && state.account !== hash(userId) ? "other-account" : state.problem ?? "ok";
    return { available, signedIn: Boolean(userId), enabled: state.enabled, state: status, lastSyncedAt: state.lastSyncedAt };
  }

  /** Caller holds the style lock. Turning sync on for the first time links these files to the signed-in account. */
  async setEnabled(enabled: boolean): Promise<void> {
    const state = await this.state();
    const userId = this.account?.userId() ?? null;
    await this.write({ ...state, enabled, problem: null, account: enabled && !state.account && userId ? hash(userId) : state.account });
  }

  /** Caller holds the style lock. Merge these files with the account now signed in, which is not the one they were merged with before. */
  async relink(): Promise<void> {
    const state = await this.state();
    const userId = this.account?.userId() ?? null;
    if (!userId) throw new Error("Sign in to sync");
    // What was agreed with the previous account says nothing about this one: start from a plain union.
    await this.write({ ...state, account: hash(userId), scopes: {}, problem: null });
  }

  /** Caller holds the style lock. A reset must not be undone by another device's older copy. */
  async noteReset(workspaceId: string | null): Promise<void> {
    const state = await this.state();
    for (const id of workspaceId === null ? Object.keys(state.keys) : [workspaceId]) state.generations[id] = (state.generations[id] ?? 0) + 1;
    await this.write(state);
  }

  /** Remove this account's copy from the server and stop syncing. The files on this device stay. */
  async removeRemote(): Promise<void> {
    if (!this.account?.userId()) throw new Error("Sign in to sync");
    await this.account.client.removeAll();
    await this.host.exclusive(async () => this.write({ ...await this.state(), enabled: false, scopes: {}, problem: null }));
  }

  /** Sync shortly, once changes have stopped arriving. */
  soon(delay = 5000): void {
    if (!this.account) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.run(); }, delay);
    this.timer.unref();
  }

  /** Sync when the last attempt is not recent, e.g. when the settings pane opens. */
  refresh(): void { if (Date.now() - this.lastAttempt > 60_000) this.soon(200); }

  dispose(): void { clearTimeout(this.timer); }

  /** Never throws: a failed sync is recorded and retried at the next opportunity. */
  run(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.lastAttempt = Date.now();
    this.running = this.sync().catch(async error => {
      const problem = error instanceof SyncProblem ? error.state : (error as { status?: number })?.status === 404 ? "unavailable" : "error";
      if (!(error instanceof SyncProblem)) this.host.log(error);
      await this.host.exclusive(async () => this.write({ ...await this.state(), problem })).catch(() => {});
    }).finally(() => {
      this.running = null;
      if (this.again) { this.again = false; this.soon(1000); }
    });
    return this.running;
  }

  private async sync(): Promise<void> {
    const userId = this.account?.userId() ?? null;
    if (!this.account || !userId) return;
    const start = await this.host.exclusive(() => this.state());
    if (!start.enabled || (start.account && start.account !== hash(userId))) return;
    const stillSame = () => { if (this.account?.userId() !== userId) throw new Error("ACCOUNT_CHANGED"); };
    await this.scope(GLOBAL_KEY, null, stillSame);
    const workspaces = await this.host.workspaces();
    const keys = await this.host.exclusive(async () => {
      const state = await this.state();
      const taken = new Set(Object.entries(state.keys).filter(([id]) => workspaces.some(w => w.id === id)).map(([, key]) => key));
      for (const workspace of workspaces) {
        if (state.keys[workspace.id]) continue;
        // The same name on two devices is the same workspace. The name itself is not sent.
        const named = `style-ws-${hash(`workspace\n${workspace.name.normalize("NFKC").trim().toLowerCase()}`).slice(0, 32)}`;
        const key = taken.has(named) ? `style-ws-${hash(`workspace\n${state.device}\n${workspace.id}`).slice(0, 32)}` : named;
        state.keys[workspace.id] = key;
        taken.add(key);
      }
      await this.write({ ...state, account: state.account ?? hash(userId) });
      return state.keys;
    });
    let limited = false;
    for (const workspace of workspaces) {
      try { await this.scope(keys[workspace.id], workspace.id, stillSame); }
      catch (error) { if (error instanceof SyncProblem && error.state === "limit") limited = true; else throw error; }
    }
    await this.host.exclusive(async () => this.write({ ...await this.state(), problem: limited ? "limit" : null, lastSyncedAt: this.host.now().toISOString() }));
  }

  private valid(item: SyncedItem, locale: AppLocale): boolean {
    return item.origin === "user" || (Boolean(item.key) && itemText(item.key!, item.value, locale) !== null);
  }

  private async snapshot(workspaceId: string, state: SyncState, key: string): Promise<WorkspaceBundle> {
    const memory = await this.host.memory.load(workspaceId, this.host.locale(), this.host.now());
    // Sending only part of a memo would read, on the other side, as the rest having been deleted.
    if (memory.items.length > MAX_SYNCED_ITEMS) throw new SyncProblem("limit");
    const base = state.scopes[key]?.base;
    // Habits this version cannot read came from a newer one. They are carried along untouched, never used here.
    const carried = base?.kind === "workspace" ? base.items.filter(item => !this.valid(item, memory.locale) && !memory.suppressed.includes(item.key ?? "")) : [];
    return {
      version: 1, kind: "workspace", locale: memory.locale, generation: state.generations[workspaceId] ?? 0,
      items: [...memory.items.map(item => this.synced(item, state.device)), ...carried],
      suppressed: memory.suppressed, dismissed: memory.dismissed, declined: memory.declined,
      note: (await this.host.memory.readNote(workspaceId)).content, settings: await this.host.memory.settingsOf(workspaceId),
      ledger: (await this.host.memory.ledgerLines(workspaceId)).filter(line => line.length <= MAX_LEDGER_LINE).slice(-MAX_SYNCED_LEDGER_LINES),
      updatedAt: this.host.now().toISOString(), device: state.device,
    };
  }

  private synced(item: StyleItem, device: string): SyncedItem {
    const { id, key, value, section, text: sentence, origin, basis, support, documents, firstSeenAt, lastConfirmedAt } = item;
    return { id, key, value, section, text: sentence, origin, basis, support, documents, firstSeenAt, lastConfirmedAt,
      devices: [...(item.devices ?? []).filter(d => d !== device), ...(item.sources.length ? [device] : [])] };
  }

  /** Turn merged habits back into this device's items, keeping the evidence it holds itself. */
  private restore(items: readonly SyncedItem[], pools: readonly (readonly StyleItem[])[], locale: AppLocale, device: string): StyleItem[] {
    const known = new Map<string, StyleItem>();
    for (const pool of pools) for (const item of pool) if (!known.has(identity(item))) known.set(identity(item), item);
    return items.flatMap(item => {
      const sentence = item.origin === "user" ? item.text : item.key ? itemText(item.key, item.value, locale) : null;
      if (sentence === null) return [];
      const mine = known.get(identity(item));
      return [{ id: mine?.id ?? item.id, key: item.origin === "auto" ? item.key : null, value: item.value,
        section: item.origin === "auto" && item.key ? sectionOf(item.key) : item.section, text: sentence, origin: item.origin, basis: item.basis,
        support: item.support, documents: item.documents, sources: mine?.sources ?? [], firstSeenAt: item.firstSeenAt, lastConfirmedAt: item.lastConfirmedAt,
        devices: item.devices.filter(d => d !== device) }];
    });
  }

  /** Caller holds the style lock. Bring the merged habits into the memo on this device. */
  private async adopt(workspaceId: string, local: WorkspaceBundle, merged: WorkspaceBundle, device: string): Promise<void> {
    const { memory: files } = this.host;
    const memory = await files.load(workspaceId, this.host.locale(), this.host.now());
    const items = this.restore(merged.items, [memory.items], memory.locale, device);
    if (renderMemo({ items }, memory.locale).length > AUTHORING_STYLE_NOTE_LIMIT) throw new SyncProblem("limit");
    if (merged.note.length > AUTHORING_STYLE_NOTE_LIMIT) throw new SyncProblem("limit");
    const before = new Map(memory.items.map(item => [identity(item), item]));
    const after = new Map(items.map(item => [identity(item), item]));
    const entries: LedgerDraft[] = [
      ...items.filter(item => !before.has(identity(item))).map(item => ({ actor: "sync" as const, action: "sync-add", ...(item.key ? { key: item.key } : {}), after: item.text })),
      ...items.filter(item => before.has(identity(item)) && before.get(identity(item))!.text !== item.text)
        .map(item => ({ actor: "sync" as const, action: "sync-update", ...(item.key ? { key: item.key } : {}), before: before.get(identity(item))!.text, after: item.text })),
      ...memory.items.filter(item => !after.has(identity(item))).map(item => ({ actor: "sync" as const, action: "sync-remove", ...(item.key ? { key: item.key } : {}), before: item.text })),
    ];
    // Undo steps back over what was done on this device. What another device changed is applied to each
    // step too, so stepping back does not take it out again.
    const was: Learned = { generation: 0, items: local.items, suppressed: local.suppressed, dismissed: local.dismissed, declined: local.declined };
    const now: Learned = { ...merged, generation: 0 };
    memory.undo = merged.generation !== local.generation ? [] : memory.undo.map(step => {
      const rebased = mergeLearned(was, { generation: 0, items: step.items.map(item => this.synced(item, device)), suppressed: step.suppressed,
        dismissed: step.dismissed, declined: step.declined ?? local.declined }, now);
      return { ...step, items: this.restore(rebased.items, [step.items, items], memory.locale, device), suppressed: rebased.suppressed,
        dismissed: rebased.dismissed, declined: rebased.declined, pending: step.pending.filter(p => !rebased.suppressed.includes(p.key)) };
    });
    Object.assign(memory, { items, suppressed: merged.suppressed, dismissed: merged.dismissed, declined: merged.declined } satisfies Partial<StyleMemory>);
    // A staged change whose habit is gone, or already there, has nothing left to decide.
    memory.pending = memory.pending.filter(p => !merged.suppressed.includes(p.key) && (p.kind !== "add" || !items.some(item => item.key === p.key)));
    await files.writeLedger(workspaceId, merged.generation !== local.generation ? merged.ledger : mergeLedger(await files.ledgerLines(workspaceId), merged.ledger));
    await files.commit(workspaceId, memory, entries);
    if (merged.note !== local.note) await files.writeNote(workspaceId, merged.note);
    if (JSON.stringify(merged.settings) !== JSON.stringify(local.settings)) await files.writeSettings(workspaceId, merged.settings);
  }

  private async snapshotGlobal(state: SyncState): Promise<GlobalBundle> {
    return { version: 1, kind: "global", note: (await this.host.memory.readNote(null)).content, settings: await this.host.memory.settingsOf(null),
      provider: await this.host.provider(), updatedAt: this.host.now().toISOString(), device: state.device };
  }

  /** One key: read the server's copy, merge it into this device under the lock, send the result, remember what was agreed. */
  private async scope(key: string, workspaceId: string | null, stillSame: () => void): Promise<void> {
    const client = this.account!.client;
    for (let attempt = 0; attempt < 3; attempt++) {
      const remote = await client.read(key);
      stillSame();
      const kind = workspaceId === null ? "global" : "workspace";
      const theirs = remote.revision === null ? null : kind === "global" ? parseBundle(remote.content, "global") : parseBundle(remote.content, "workspace");
      // A copy this version cannot read was written by a newer one. Leave it alone.
      if (remote.revision !== null && !theirs) return;
      const merged = await this.host.exclusive(async () => {
        const state = await this.state();
        const known = state.scopes[key];
        const base = known?.base?.kind === kind ? known.base : null;
        if (workspaceId === null) {
          const local = await this.snapshotGlobal(state);
          const result = mergeGlobal(base as GlobalBundle | null, local, theirs as GlobalBundle | null);
          if (result.note.length > AUTHORING_STYLE_NOTE_LIMIT) throw new SyncProblem("limit");
          if (result.note !== local.note) await this.host.memory.writeNote(null, result.note);
          if (JSON.stringify(result.settings) !== JSON.stringify(local.settings)) await this.host.memory.writeSettings(null, result.settings);
          if (result.provider && result.provider !== local.provider) await this.host.setProvider(result.provider);
          return { result, empty: !result.note && result.settings.enabled && result.settings.aiSummary && !result.provider };
        }
        const local = await this.snapshot(workspaceId, state, key);
        const result = mergeWorkspace(base as WorkspaceBundle | null, local, theirs as WorkspaceBundle | null);
        // Reset on another device: what this device collected before the reset goes as well.
        if (result.generation > local.generation) await this.host.forget(workspaceId);
        if (comparable(result) !== comparable(local)) await this.adopt(workspaceId, local, result, state.device);
        if (result.generation !== local.generation) await this.write({ ...await this.state(), generations: { ...state.generations, [workspaceId]: result.generation } });
        return { result, empty: !result.items.length && !result.note && !result.ledger.length && !result.suppressed.length && result.settings.enabled && result.settings.aiSummary };
      });
      let revision = remote.revision;
      const changed = theirs ? comparable(merged.result) !== comparable(theirs) : !merged.empty;
      if (changed) {
        if (Buffer.byteLength(JSON.stringify(merged.result)) > MAX_BUNDLE_BYTES) throw new SyncProblem("limit");
        const written = await client.write(key, merged.result, remote.revision);
        stillSame();
        // Another device wrote in between: read its copy and merge again.
        if (written === "conflict") continue;
        revision = written.revision;
      }
      await this.host.exclusive(async () => {
        const state = await this.state();
        await this.write({ ...state, scopes: { ...state.scopes, [key]: { revision, base: revision === null ? null : merged.result, syncedAt: this.host.now().toISOString() } } });
      });
      return;
    }
    throw new Error("Style sync kept conflicting");
  }
}
