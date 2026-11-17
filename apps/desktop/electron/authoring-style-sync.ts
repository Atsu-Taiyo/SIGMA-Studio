import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { AUTHORING_STYLE_NOTE_LIMIT, type AuthoringStyleSection, type AuthoringStyleSyncView } from "@/lib/ai/authoring-style";
import type { AppLocale } from "@/lib/i18n";
import { itemText, SECTION_ORDER, sectionOf } from "./authoring-style-items";
import { isSuspicious } from "./authoring-style-scan";
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
  /** Every call names the account it is meant for and fails when another one is signed in by then. */
  read(userId: string, key: string, signal?: AbortSignal): Promise<{ revision: string | null; content: unknown }>;
  /** Writes only when the stored revision is still `expectedRevision` (null: nothing stored yet). */
  write(userId: string, key: string, content: unknown, expectedRevision: string | null, signal?: AbortSignal): Promise<{ revision: string } | "conflict">;
  removeAll(userId: string): Promise<void>;
}

export const MAX_SYNCED_ITEMS = 400;
export const MAX_SYNCED_LEDGER_LINES = 200;
export const MAX_BUNDLE_BYTES = 256 * 1024;
const MAX_LEDGER_LINE = 2000;
const MAX_OPAQUE_ITEMS = 100;
const MAX_SUPPRESSED = 100;
const MAX_USER_LINE = 500;
/** A ledger line recording that a change arrived by sync. It stays on the device it arrived on: the change itself is on record where it was made. */
const ARRIVED = '"actor":"sync"';
const LINE_BREAK = new RegExp("[\\p{Cc}\\u2028\\u2029]", "u");
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
interface Learned {
  generation: number; items: SyncedItem[]; suppressed: string[]; dismissed: string[]; declined: string[];
  /** Entries a newer version wrote in a shape this one does not know. Kept as they are, never read. */
  opaque: unknown[];
}
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
  const known = (item: unknown): item is SyncedItem => isRecord(item) && text(item.id, 200) && (item.key === null || text(item.key, 200))
    && text(item.value, 200) && text(item.text, AUTHORING_STYLE_NOTE_LIMIT) && (item.origin === "auto" || item.origin === "user")
    && SECTION_ORDER.includes(item.section as AuthoringStyleSection) && text(item.firstSeenAt, 40) && text(item.lastConfirmedAt, 40);
  const extra = Array.isArray(value.opaque) ? value.opaque : [];
  const opaque = [...value.items.filter(item => !known(item)), ...extra];
  // Reading only part of a copy would later send it back with the rest missing.
  if (value.items.length - (opaque.length - extra.length) > MAX_SYNCED_ITEMS || opaque.length > MAX_OPAQUE_ITEMS || opaque.some(item => JSON.stringify(item).length > MAX_LEDGER_LINE)) return null;
  const items = value.items.filter(known).map(item => ({
      id: item.id, key: item.key, value: item.value, section: item.section, text: item.text, origin: item.origin,
      basis: item.basis === "writing" || item.basis === "corrections" || item.basis === "summary" ? item.basis : null,
      support: count(item.support), documents: count(item.documents), firstSeenAt: item.firstSeenAt, lastConfirmedAt: item.lastConfirmedAt,
      devices: strings(item.devices, 20, 64).sort(),
    }));
  return { ...common, kind, locale: value.locale === "en" ? "en" : "ja", generation: count(value.generation), items,
    suppressed: strings(value.suppressed, MAX_SUPPRESSED, 200), dismissed: strings(value.dismissed, 60, 500), declined: strings(value.declined, 30, 200),
    ledger: strings(value.ledger, MAX_SYNCED_LEDGER_LINES, MAX_LEDGER_LINE), opaque };
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

/**
 * What the account's copy should say about a switch. With nothing agreed before, the server's copy stands.
 * Whether a device turns the switch on is decided separately: sync only ever turns one off.
 */
function pickSwitch(base: boolean | undefined, local: boolean, remote: boolean): boolean {
  return local === remote ? local : base === undefined ? remote : base === remote ? local : base === local ? remote : false;
}
const mergeSettings = (base: Settings | undefined, local: Settings, remote: Settings): Settings => ({
  enabled: pickSwitch(base?.enabled, local.enabled, remote.enabled), aiSummary: pickSwitch(base?.aiSummary, local.aiSummary, remote.aiSummary),
});

/** Union of two lists, minus what either side removed since they last agreed. */
export function mergeList(base: readonly string[] | undefined, local: readonly string[], remote: readonly string[], max = Infinity): string[] {
  const removed = new Set((base ?? []).filter(value => !local.includes(value) || !remote.includes(value)));
  const merged = [...new Set([...local, ...remote])].filter(value => !removed.has(value));
  return Number.isFinite(max) ? merged.slice(-max) : merged;
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
    // The same on whichever device merges: otherwise two devices would keep sending each other their own version.
    const rank = (item: SyncedItem) => `${item.lastConfirmedAt}\n${String(item.support).padStart(9, "0")}\n${String(item.documents).padStart(9, "0")}\n${item.basis}`;
    const fresher = statement(mine) !== statement(other) ? winner : rank(other) > rank(mine) ? other : mine;
    result.push({ ...winner, id: mine.id, basis: fresher.basis, support: fresher.support, documents: fresher.documents,
      firstSeenAt: other.firstSeenAt < mine.firstSeenAt ? other.firstSeenAt : mine.firstSeenAt, lastConfirmedAt: fresher.lastConfirmedAt,
      devices: [...new Set([...mine.devices, ...other.devices])].sort().slice(0, 20) });
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
  return [...new Set([...local, ...remote])].map(line => ({ line, at: at(line) }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.line.localeCompare(b.line)).map(entry => entry.line);
}

/**
 * `merge`: both sides share a history. A reset counts up the generation, and the side that reset last replaces
 * the other's learned habits instead of being merged with them.
 * `link`: these files meet the account's copy for the first time. They have no resets in common, so both sides'
 * habits are kept and the account's count of resets stands.
 * `reset`: as `link`, but the memo was reset on this device since sync was turned on: the reset stands.
 */
export type MergeMode = "merge" | "link" | "reset";

function mergeLearned(base: Learned | undefined, local: Learned, remote: Learned, mode: MergeMode = "merge"): Learned {
  if (mode === "reset") return { generation: remote.generation + 1, items: local.items, suppressed: local.suppressed, dismissed: local.dismissed, declined: local.declined, opaque: [] };
  if (mode === "merge" && local.generation !== remote.generation) {
    const { generation, items, suppressed, dismissed, declined, opaque } = local.generation > remote.generation ? local : remote;
    return { generation, items, suppressed, dismissed, declined, opaque };
  }
  // While linking, the base is the account's copy as it was first merged in: what the account dropped since is dropped here too.
  const was = base && (mode === "link" || base.generation === local.generation) ? base : undefined;
  // Not cut short here: dropping a record of a removal would let the habit come back. An overlong list stops the sync instead.
  const suppressed = mergeList(was?.suppressed, local.suppressed, remote.suppressed);
  const declined = mergeList(was?.declined, local.declined, remote.declined, 30);
  return {
    generation: remote.generation, suppressed, declined, dismissed: mergeList(was?.dismissed, local.dismissed, remote.dismissed, 60),
    // A removal always wins: no device learns again, or keeps, what its author took out.
    items: mergeItems(was?.items, local.items, remote.items)
      .filter(item => item.origin !== "auto" || !item.key || (!suppressed.includes(item.key) && !(item.basis === "summary" && declined.includes(item.text)))),
    opaque: remote.opaque,
  };
}

export function mergeWorkspace(base: WorkspaceBundle | null, local: WorkspaceBundle, remote: WorkspaceBundle | null, mode: MergeMode = base ? "merge" : "link"): WorkspaceBundle {
  if (!remote) return local;
  const was = base ?? undefined;
  const replaced = mode === "merge" && local.generation !== remote.generation;
  return {
    ...local, ...mergeLearned(was, local, remote, mode),
    note: mergeNote(was?.note, local.note, remote.note),
    settings: mergeSettings(was?.settings, local.settings, remote.settings),
    // A reset empties the ledger too.
    ledger: mode === "reset" ? local.ledger : replaced ? (local.generation > remote.generation ? local : remote).ledger
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
function comparable(bundle: WorkspaceBundle | GlobalBundle): string {
  // Spelled out field by field: the order in which an object happened to be built is not content either.
  const switches = [bundle.settings.enabled, bundle.settings.aiSummary];
  if (bundle.kind === "global") return JSON.stringify([bundle.kind, bundle.note, switches, bundle.provider]);
  // Neither the order of a list nor the language an automatic sentence is shown in is content.
  const items = bundle.items.map(item => [identity(item), statement(item), item.basis, item.support, item.documents, item.firstSeenAt, item.lastConfirmedAt, item.devices.join(",")].join("\n")).sort();
  const sorted = (list: readonly string[]) => [...list].sort();
  return JSON.stringify([bundle.kind, bundle.generation, bundle.note, switches, items, sorted(bundle.suppressed), sorted(bundle.dismissed),
    sorted(bundle.declined), sorted(bundle.ledger), bundle.opaque.map(entry => JSON.stringify(entry)).sort()]);
}

interface ScopeState {
  revision: string | null; base: WorkspaceBundle | GlobalBundle | null; syncedAt: string | null;
  /** Switches the account has on and this device keeps off until its user turns them on here. */
  held?: { enabled?: boolean; aiSummary?: boolean };
  /** The first merge with the account's copy has begun and is not yet agreed. */
  linking?: boolean;
}
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
  /** Workspaces reset on this device before their first merge with the account. The reset is to stand. */
  resets: Record<string, boolean>;
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
/** The run was overtaken: sync was turned off, the copy was deleted, or another account signed in. */
class Cancelled extends Error {}


interface Run { userId: string; epoch: number; signal: AbortSignal }

export class AuthoringStyleSync {
  private running: Promise<void> | null = null;
  private again = false;
  private timer?: ReturnType<typeof setTimeout>;
  private lastAttempt = 0;
  /** Counts up whenever a run under way must not go on: sync turned off, copy deleted, another account linked. */
  private epoch = 0;
  /** Aborts the requests of a run that must not go on. */
  private controller = new AbortController();

  private cancel(): void {
    this.epoch++;
    this.controller.abort();
    this.controller = new AbortController();
  }

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
      resets: record(value.resets, (entry): entry is boolean => entry === true),
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
    if (!enabled) this.cancel();
    const state = await this.state();
    const userId = this.account?.userId() ?? null;
    await this.write({ ...state, enabled, problem: null, account: enabled && !state.account && userId ? hash(userId) : state.account });
  }

  /** Caller holds the style lock. Merge these files with the account now signed in, which is not the one they were merged with before. */
  async relink(): Promise<void> {
    const state = await this.state();
    const userId = this.account?.userId() ?? null;
    if (!userId) throw new Error("Sign in to sync");
    this.cancel();
    // What was agreed with the previous account, and how often it was reset, says nothing about this one.
    await this.write({ ...state, account: hash(userId), scopes: {}, resets: {}, problem: null });
  }

  /** Caller holds the style lock. A reset must not be undone by another device's older copy. */
  async noteReset(workspaceId: string | null): Promise<void> {
    const state = await this.state();
    const ids = workspaceId === null ? [...new Set([...Object.keys(state.keys), ...(await this.host.workspaces()).map(w => w.id)])] : [workspaceId];
    for (const id of ids) {
      state.generations[id] = (state.generations[id] ?? 0) + 1;
      // With nothing agreed yet there is no history to compare: remember that the reset is to stand.
      if (state.enabled && !state.scopes[state.keys[id] ?? ""]?.base) state.resets[id] = true;
    }
    await this.write(state);
  }

  /** Caller holds the style lock. The user set this switch here, so nothing holds it off for the account any more. */
  async noteSwitch(workspaceId: string | null, name: "enabled" | "aiSummary"): Promise<void> {
    const state = await this.state();
    const scope = state.scopes[workspaceId === null ? GLOBAL_KEY : state.keys[workspaceId] ?? ""];
    if (!scope?.held?.[name]) return;
    scope.held = { ...scope.held, [name]: false };
    await this.write(state);
  }

  /** Remove this account's copy from the server and stop syncing. The files on this device stay. */
  async removeRemote(): Promise<void> {
    const userId = this.account?.userId() ?? null;
    if (!this.account || !userId) throw new Error("Sign in to sync");
    await this.host.exclusive(async () => {
      const state = await this.state();
      if (state.account && state.account !== hash(userId)) throw new Error("These files are synced with another account");
      this.cancel();
      await this.write({ ...state, enabled: false, scopes: {}, resets: {}, problem: null });
    });
    // A run already under way stops at its next step; wait for it so it cannot write after the deletion.
    await this.running;
    await this.account.client.removeAll(userId);
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
    const signal = this.controller.signal;
    this.running = this.sync().catch(async error => {
      if (error instanceof Cancelled || signal.aborted) return;
      const problem = error instanceof SyncProblem ? error.state : (error as { status?: number })?.status === 404 ? "unavailable" : "error";
      if (!(error instanceof SyncProblem)) this.host.log(error);
      await this.host.exclusive(async () => this.write({ ...await this.state(), problem })).catch(() => {});
    }).finally(() => {
      this.running = null;
      if (this.again) { this.again = false; this.soon(1000); }
    });
    return this.running;
  }

  /** A whole run that starts now: one already under way may have read the files before the latest change. */
  async fresh(): Promise<void> {
    clearTimeout(this.timer);
    while (this.running) await this.running;
    this.again = false;
    await this.run();
  }

  /** Stop a run that was overtaken while it waited for the network or for the lock. */
  private alive(run: Run): void {
    if (this.epoch !== run.epoch || run.signal.aborted || this.account?.userId() !== run.userId) throw new Cancelled();
  }

  /** Caller holds the style lock. The state, if this run may still change the files. */
  private async current(run: Run): Promise<SyncState> {
    this.alive(run);
    const state = await this.state();
    if (!state.enabled || (state.account !== null && state.account !== hash(run.userId))) throw new Cancelled();
    return state;
  }

  private async sync(): Promise<void> {
    const userId = this.account?.userId() ?? null;
    if (!this.account || !userId) return;
    const run: Run = { userId, epoch: this.epoch, signal: this.controller.signal };
    const start = await this.host.exclusive(() => this.state());
    if (!start.enabled || (start.account && start.account !== hash(userId))) return;
    await this.scope(GLOBAL_KEY, null, run);
    const workspaces = await this.host.workspaces();
    const keys = await this.host.exclusive(async () => {
      const state = await this.current(run);
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
      try { await this.scope(keys[workspace.id], workspace.id, run); }
      catch (error) { if (error instanceof SyncProblem && error.state === "limit") limited = true; else throw error; }
    }
    await this.host.exclusive(async () => this.write({ ...await this.current(run), problem: limited ? "limit" : null, lastSyncedAt: this.host.now().toISOString() }));
  }

  /**
   * Whether a habit from the server may be used on this device. Its sentence is not taken on trust: an
   * automatic one must be a sentence this version makes itself, a hand-written one a plain single line.
   */
  private usable(item: SyncedItem, locale: AppLocale): boolean {
    if (item.origin === "auto") return Boolean(item.key) && itemText(item.key!, item.value, locale) !== null;
    return item.text.length <= MAX_USER_LINE && !LINE_BREAK.test(item.text) && !isSuspicious(item.text);
  }

  private async snapshot(workspaceId: string, state: SyncState, key: string): Promise<WorkspaceBundle> {
    const memory = await this.host.memory.load(workspaceId, this.host.locale(), this.host.now());
    // Sending only part of a memo would read, on the other side, as the rest having been deleted.
    if (memory.items.length > MAX_SYNCED_ITEMS) throw new SyncProblem("limit");
    const generation = state.generations[workspaceId] ?? 0;
    const known = state.scopes[key]?.base;
    // What this device could not use came from another one. It is carried along untouched, unless a reset erased it.
    const base = known?.kind === "workspace" && known.generation === generation ? known : null;
    const mine = new Set(memory.items.map(identity));
    const carried = (base?.items ?? []).filter(item => !mine.has(identity(item)) && !this.usable(item, memory.locale) && !memory.suppressed.includes(item.key ?? ""));
    return {
      version: 1, kind: "workspace", locale: memory.locale, generation,
      items: [...memory.items.map(item => this.synced(item, state.device)), ...carried], opaque: base?.opaque ?? [],
      suppressed: memory.suppressed, dismissed: memory.dismissed, declined: memory.declined,
      note: (await this.host.memory.readNote(workspaceId)).content, settings: await this.host.memory.settingsOf(workspaceId),
      ledger: (await this.host.memory.ledgerLines(workspaceId)).filter(line => line.length <= MAX_LEDGER_LINE && !line.includes(ARRIVED)).slice(-MAX_SYNCED_LEDGER_LINES),
      updatedAt: this.host.now().toISOString(), device: state.device,
    };
  }

  private synced(item: StyleItem, device: string): SyncedItem {
    const { id, key, value, section, text: sentence, origin, basis, support, documents, firstSeenAt, lastConfirmedAt } = item;
    return { id, key, value, section, text: sentence, origin, basis, support, documents, firstSeenAt, lastConfirmedAt,
      devices: [...new Set([...(item.devices ?? []).filter(d => d !== device), ...(item.sources.length ? [device] : [])])].sort() };
  }

  /** Turn merged habits back into this device's items, keeping the evidence it holds itself. */
  private restore(items: readonly SyncedItem[], pools: readonly (readonly StyleItem[])[], locale: AppLocale, device: string): StyleItem[] {
    const known = new Map<string, StyleItem>();
    for (const pool of pools) for (const item of pool) if (!known.has(identity(item))) known.set(identity(item), item);
    return items.flatMap(item => {
      const mine = known.get(identity(item));
      if (!mine && !this.usable(item, locale)) return [];
      const sentence = item.origin === "user" ? item.text : item.key ? itemText(item.key, item.value, locale) : null;
      if (sentence === null) return [];
      return [{ id: mine?.id ?? item.id, key: item.origin === "auto" ? item.key : null, value: item.value,
        section: item.origin === "auto" && item.key ? sectionOf(item.key) : item.section, text: sentence, origin: item.origin, basis: item.basis,
        support: item.support, documents: item.documents, sources: mine?.sources ?? [], firstSeenAt: item.firstSeenAt, lastConfirmedAt: item.lastConfirmedAt,
        devices: item.devices.filter(d => d !== device) }];
    });
  }

  /** Caller holds the style lock. Check that the merged result fits before anything on this device is changed. */
  private async plan(workspaceId: string, merged: WorkspaceBundle, device: string): Promise<{ memory: StyleMemory; items: StyleItem[] }> {
    const memory = await this.host.memory.load(workspaceId, this.host.locale(), this.host.now());
    const items = this.restore(merged.items, [memory.items], memory.locale, device);
    if (renderMemo({ items }, memory.locale).length > AUTHORING_STYLE_NOTE_LIMIT || merged.note.length > AUTHORING_STYLE_NOTE_LIMIT) throw new SyncProblem("limit");
    return { memory, items };
  }

  /** Caller holds the style lock. Bring the merged habits into the memo on this device. */
  private async adopt(workspaceId: string, local: WorkspaceBundle, merged: WorkspaceBundle, device: string, reset: boolean,
    { memory, items }: { memory: StyleMemory; items: StyleItem[] }): Promise<void> {
    const { memory: files } = this.host;
    const before = new Map(memory.items.map(item => [identity(item), item]));
    const after = new Map(items.map(item => [identity(item), item]));
    const entries: LedgerDraft[] = [
      ...items.filter(item => !before.has(identity(item))).map(item => ({ actor: "sync" as const, action: "sync-add", ...(item.key ? { key: item.key } : {}), after: item.text })),
      ...items.filter(item => before.has(identity(item)) && before.get(identity(item))!.text !== item.text)
        .map(item => ({ actor: "sync" as const, action: "sync-update", ...(item.key ? { key: item.key } : {}), before: before.get(identity(item))!.text, after: item.text })),
      ...memory.items.filter(item => !after.has(identity(item))).map(item => ({ actor: "sync" as const, action: "sync-remove", ...(item.key ? { key: item.key } : {}), before: item.text })),
    ];
    // Undo steps back over what was done on this device. What another device changed is applied to each
    // step too, so stepping back does not take it out again. Nothing from before a reset can be stepped back to.
    const was: Learned = { generation: 0, items: local.items, suppressed: local.suppressed, dismissed: local.dismissed, declined: local.declined, opaque: [] };
    const now: Learned = { ...merged, generation: 0 };
    memory.undo = reset ? [] : memory.undo.map(step => {
      const rebased = mergeLearned(was, { generation: 0, items: step.items.map(item => this.synced(item, device)), suppressed: step.suppressed,
        dismissed: step.dismissed, declined: step.declined ?? local.declined, opaque: [] }, now);
      return { ...step, items: this.restore(rebased.items, [step.items, items], memory.locale, device), suppressed: rebased.suppressed,
        dismissed: rebased.dismissed, declined: rebased.declined, pending: step.pending.filter(p => !rebased.suppressed.includes(p.key)) };
    });
    Object.assign(memory, { items, suppressed: merged.suppressed, dismissed: merged.dismissed, declined: merged.declined } satisfies Partial<StyleMemory>);
    // A staged change whose habit is gone, or already there, has nothing left to decide. Nor has one staged before a reset.
    memory.pending = reset ? [] : memory.pending.filter(p => !merged.suppressed.includes(p.key) && (p.kind !== "add" || !items.some(item => item.key === p.key)));
    await files.writeLedger(workspaceId, reset ? merged.ledger : mergeLedger(await files.ledgerLines(workspaceId), merged.ledger));
    await files.commit(workspaceId, memory, entries);
    if (merged.note !== local.note) await files.writeNote(workspaceId, merged.note);
  }

  /**
   * Caller holds the style lock. A switch the account has off goes off here. One it has on is not turned on:
   * that is its user's to do on this device. Returns the switches held off that way.
   */
  private async switches(workspaceId: string | null, local: Settings, merged: Settings): Promise<NonNullable<ScopeState["held"]>> {
    const next = { enabled: local.enabled && merged.enabled, aiSummary: local.aiSummary && merged.aiSummary };
    if (JSON.stringify(next) !== JSON.stringify(local)) await this.host.memory.writeSettings(workspaceId, next);
    return { enabled: merged.enabled && !local.enabled, aiSummary: merged.aiSummary && !local.aiSummary };
  }

  private async snapshotGlobal(state: SyncState): Promise<GlobalBundle> {
    return { version: 1, kind: "global", note: (await this.host.memory.readNote(null)).content, settings: await this.host.memory.settingsOf(null),
      provider: await this.host.provider(), updatedAt: this.host.now().toISOString(), device: state.device };
  }

  /** One key: read the server's copy, merge it into this device under the lock, send the result, remember what was agreed. */
  private async scope(key: string, workspaceId: string | null, run: Run): Promise<void> {
    const client = this.account!.client;
    for (let attempt = 0; attempt < 3; attempt++) {
      this.alive(run);
      const remote = await client.read(run.userId, key, run.signal);
      const kind = workspaceId === null ? "global" : "workspace";
      const theirs = remote.revision === null ? null : kind === "global" ? parseBundle(remote.content, "global") : parseBundle(remote.content, "workspace");
      // A copy this version cannot read was written by a newer one. Leave it alone.
      if (remote.revision !== null && !theirs) return;
      const merged = await this.host.exclusive(async () => {
        const state = await this.current(run);
        const known = state.scopes[key];
        if (remote.revision === null && known?.revision) {
          // The account's copy was deleted from another device. Do not put it back: stop syncing here too.
          this.cancel();
          await this.write({ ...state, enabled: false, scopes: {}, resets: {}, problem: null });
          throw new Cancelled();
        }
        // Until the first merge with the account's copy is agreed there is no shared history to merge against.
        const base = known?.base?.kind === kind ? known.base : null;
        const linking = !base || Boolean(known?.linking);
        const held = (local: Settings): Settings => ({ enabled: local.enabled || Boolean(known?.held?.enabled), aiSummary: local.aiSummary || Boolean(known?.held?.aiSummary) });
        // What was merged in is on record before anything else can fail: a retry then tells what came from
        // the server from what was added here, and does not send back something another device has deleted since.
        const journal = async (heldNow: ScopeState["held"], generation?: number) => {
          const latest = await this.state();
          await this.write({ ...latest, generations: generation === undefined ? latest.generations : { ...latest.generations, [workspaceId!]: generation },
            scopes: { ...latest.scopes, [key]: { revision: remote.revision, base: theirs, syncedAt: known?.syncedAt ?? null, held: heldNow, ...(linking ? { linking } : {}) } } });
        };
        if (workspaceId === null) {
          const mine = await this.snapshotGlobal(state);
          const local = { ...mine, settings: held(mine.settings) };
          const result = mergeGlobal(base as GlobalBundle | null, local, theirs as GlobalBundle | null);
          if (result.note.length > AUTHORING_STYLE_NOTE_LIMIT || Buffer.byteLength(JSON.stringify(result)) > MAX_BUNDLE_BYTES) throw new SyncProblem("limit");
          if (result.note !== local.note) await this.host.memory.writeNote(null, result.note);
          const heldNow = await this.switches(null, mine.settings, result.settings);
          if (result.provider && result.provider !== local.provider) await this.host.setProvider(result.provider);
          await journal(heldNow);
          return { result, held: heldNow, empty: !result.note && result.settings.enabled && result.settings.aiSummary && !result.provider };
        }
        const mine = await this.snapshot(workspaceId, state, key);
        const local = { ...mine, settings: held(mine.settings) };
        const mode: MergeMode = !linking ? "merge" : state.resets[workspaceId] ? "reset" : "link";
        const result = mergeWorkspace(base as WorkspaceBundle | null, local, theirs as WorkspaceBundle | null, mode);
        // The ledger is a tail: when the copy would be too large, its oldest lines go first.
        while (result.ledger.length && Buffer.byteLength(JSON.stringify(result)) > MAX_BUNDLE_BYTES) result.ledger = result.ledger.slice(Math.ceil(result.ledger.length / 4));
        // Everything is checked before anything on this device changes: a merge that does not fit changes nothing.
        if (result.items.length > MAX_SYNCED_ITEMS || result.suppressed.length > MAX_SUPPRESSED || Buffer.byteLength(JSON.stringify(result)) > MAX_BUNDLE_BYTES) throw new SyncProblem("limit");
        // Reset on another device: what this device collected before the reset goes as well.
        const reset = mode === "merge" && result.generation > local.generation;
        if (comparable(result) !== comparable(local)) {
          const plan = await this.plan(workspaceId, result, state.device);
          if (reset) await this.host.forget(workspaceId);
          await this.adopt(workspaceId, local, result, state.device, reset, plan);
        }
        const heldNow = await this.switches(workspaceId, mine.settings, result.settings);
        await journal(heldNow, result.generation);
        return { result, held: heldNow, empty: !result.items.length && !result.opaque.length && !result.note && !result.ledger.length && !result.suppressed.length
          && result.settings.enabled && result.settings.aiSummary };
      });
      let revision = remote.revision;
      const changed = theirs ? comparable(merged.result) !== comparable(theirs) : !merged.empty;
      if (changed) {
        if (Buffer.byteLength(JSON.stringify(merged.result)) > MAX_BUNDLE_BYTES) throw new SyncProblem("limit");
        this.alive(run);
        const written = await client.write(run.userId, key, merged.result, remote.revision, run.signal);
        // Another device wrote in between: read its copy and merge again.
        if (written === "conflict") continue;
        revision = written.revision;
      }
      await this.host.exclusive(async () => {
        const state = await this.current(run);
        const resets = Object.fromEntries(Object.entries(state.resets).filter(([id]) => id !== workspaceId));
        await this.write({ ...state, resets, scopes: { ...state.scopes, [key]: { revision, base: revision === null ? null : merged.result, syncedAt: this.host.now().toISOString(), held: merged.held } } });
      });
      return;
    }
    throw new Error("Style sync kept conflicting");
  }
}
