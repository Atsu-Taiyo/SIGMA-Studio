import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { AUTHORING_STYLE_LEARNED_LIMIT, AUTHORING_STYLE_NOTE_LIMIT, type AuthoringStyleSection, type AuthoringStyleSyncView } from "@/lib/ai/authoring-style";
import type { AppLocale } from "@/lib/i18n";
import { itemText, SECTION_ORDER, sectionOf } from "./authoring-style-items";
import { isSuspicious } from "./authoring-style-scan";
import { MAX_DISMISSED, atomicStyleWrite, renderMemo, type AuthoringStyleMemory, type LedgerDraft, type StyleItem, type StyleMemory, type StyleTrust } from "./authoring-style-memory";

/**
 * Keeps the author's own note, the learning settings and (through `SyncedPart`) other
 * personal settings the same on every device of one Pro account, and the writing style
 * of a shared workspace the same for all of its members: that one is the workspace's,
 * not any member's own. A workspace that is not shared stays on its device.
 * The files on this device stay the source of truth: sync merges a copy held by
 * the collaboration server into them and sends the result back. Document text,
 * correction examples and the record of AI-written blocks never leave the device.
 */

/**
 * The server's store, reached with the signed-in account's token. A key made by `workspaceKey` names the one
 * copy a shared workspace's members have in common; every other key is the account's own.
 */
export interface PersonalDataPort {
  /** Every call names the account it is meant for and fails when another one is signed in by then. */
  read(userId: string, key: string, signal?: AbortSignal): Promise<{ revision: string | null; content: unknown }>;
  /** Writes only when the stored revision is still `expectedRevision` (null: nothing stored yet). */
  write(userId: string, key: string, content: unknown, expectedRevision: string | null, signal?: AbortSignal): Promise<{ revision: string } | "conflict">;
  /** Removes what is the account's own. A shared workspace's copy belongs to the workspace and stays. */
  removeAll(userId: string): Promise<void>;
}

export const MAX_SYNCED_ITEMS = 400;
export const MAX_SYNCED_LEDGER_LINES = 200;
export const MAX_BUNDLE_BYTES = 256 * 1024;
const MAX_LEDGER_LINE = 2000;
const MAX_LEDGER_BYTES = 96 * 1024;
const MAX_OPAQUE_ITEMS = 100;
const MAX_SUPPRESSED = 100;
const MAX_USER_LINE = 500;
const MAX_VOUCHES = 2000;
const MAX_FOREIGN = 3000;
const ACCOUNT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MARK = /^[0-9a-f]{20}$/;
/** A ledger line recording that a change arrived by sync. It stays on the device it arrived on: the change itself is on record where it was made. */
const ARRIVED = '"actor":"sync"';
/** A ledger line about this member's own approval of what another wrote. It stays on its device too. */
const APPROVED = '"actor":"approval"';
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
  /**
   * Names this copy from the moment it was first written. Another name under the same key is another copy
   * (written after this one was lost), with no history in common: it is met as for the first time.
   */
  copy: string;
  /**
   * Per account, the marks of the habits and note lines that member stands behind: wrote, learned on a device
   * of their own, or approved. A member's AI is given what is in their own list (and what their device finds
   * itself); the rest waits for their approval. The server lets nobody add to another member's list.
   */
  vouchers: Record<string, string[]>;
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
  // What kind of habit an item is must be told one way only: a line someone wrote has no key and no basis, a
  // sentence the AI suggested has both the key and the basis of one. Anything else is not read (and so not used).
  const told = (item: Record<string, unknown>) => item.origin === "user" ? item.key === null && (item.basis === null || item.basis === undefined)
    : item.origin === "auto" && text(item.key, 200) && item.key.startsWith("summary.") === (item.basis === "summary");
  const known = (item: unknown): item is SyncedItem => isRecord(item) && text(item.id, 200) && (item.key === null || text(item.key, 200))
    && text(item.value, 200) && text(item.text, AUTHORING_STYLE_NOTE_LIMIT) && told(item)
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
  const vouchers = Object.fromEntries(Object.entries(isRecord(value.vouchers) ? value.vouchers : {}).filter(([account]) => ACCOUNT.test(account)).slice(0, 500)
    .map(([account, list]) => [account, Array.isArray(list) ? list.filter((mark): mark is string => typeof mark === "string" && MARK.test(mark)).slice(0, MAX_VOUCHES) : []] as const));
  return { ...common, kind, vouchers, copy: text(value.copy, 64) ? value.copy : "", locale: value.locale === "en" ? "en" : "ja", generation: count(value.generation), items,
    suppressed: strings(value.suppressed, MAX_SUPPRESSED, 200), dismissed: strings(value.dismissed, MAX_DISMISSED, 500), declined: strings(value.declined, 30, 200),
    ledger: strings(value.ledger, MAX_SYNCED_LEDGER_LINES, MAX_LEDGER_LINE), opaque };
}

/** One habit per key; a line the user wrote is the line itself. */
const identity = (item: Pick<SyncedItem, "origin" | "key" | "section" | "text">) =>
  item.origin === "auto" && item.key ? `auto:${item.key}` : `user:${item.section}:${item.text}`;
/** What a habit says, apart from how well it is supported. Automatic sentences are compared by value: their text depends on the language. */
const statement = (item: Pick<SyncedItem, "origin" | "key" | "value" | "section" | "text">) =>
  item.origin === "auto" && item.key ? `${item.key}\n${item.value}` : `${item.section}\n${item.text}`;

const mark = (kind: "item" | "note" | "sentence", content: string) => hash(`${kind}\n${content}`).slice(0, 20);
/**
 * What a member vouches for when they vouch for a habit: what it says, not how well it is supported.
 * A sentence the AI suggested is vouched for as that sentence, wherever it stands: once removed it is kept as
 * one not to suggest again, and is then still the same member's sentence, approved or not.
 */
export const itemMark = (item: Pick<SyncedItem, "origin" | "key" | "value" | "section" | "text">) =>
  // By the value, as every automatic habit: that is what the sentence shown and handed on is made from. The text
  // that came along with it is not used, so it must not be what the approval is tied to either.
  item.origin === "auto" && item.key?.startsWith("summary.") ? mark("sentence", item.value) : mark("item", statement(item));
/** A note is vouched for line by line. Null for an empty line: there is nothing to vouch for. */
export const noteLineMark = (line: string) => line.trim() ? mark("note", line.trim()) : null;
/** A sentence the AI suggested and someone turned down. It is named to the AI again (so as not to be suggested twice), so it has a mark too. */
export const declinedMark = (sentence: string) => mark("sentence", sentence);
/** Every mark a workspace's style holds. */
function marksOf(items: readonly Pick<SyncedItem, "origin" | "key" | "value" | "section" | "text">[], note: string, declined: readonly string[]): Set<string> {
  return new Set([...items.map(itemMark), ...note.split("\n").flatMap(line => noteLineMark(line) ?? []), ...declined.map(declinedMark)]);
}

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

/** What the members decided about automatic habits, which a merge of two reviews' work has to respect. */
export interface MergeRules {
  /** Taken out on purpose (deleted, or its adding undone or declined). It does not come back. */
  unwanted?: (item: SyncedItem) => boolean;
  /** What a habit was automatically rewritten to, and somebody put back. The other wording stands. */
  refused?: (item: SyncedItem) => boolean;
  /** Automatically removed, and somebody put it back (or declined the removal). It stays. */
  restored?: (item: SyncedItem) => boolean;
}

/**
 * A removal of an automatic habit that nobody made on purpose is a review finding it no longer confirmed, and
 * yields to a device whose review confirmed it since.
 */
export function mergeItems(base: readonly SyncedItem[] | undefined, local: readonly SyncedItem[], remote: readonly SyncedItem[], rules: MergeRules = {}): SyncedItem[] {
  const index = (list: readonly SyncedItem[]) => new Map(list.map(item => [identity(item), item]));
  const unwanted = (item: SyncedItem) => rules.unwanted?.(item) ?? false;
  const stays = (item: SyncedItem, was: SyncedItem) => item.origin === "auto" && !unwanted(item) && (item.lastConfirmedAt > was.lastConfirmedAt || (rules.restored?.(item) ?? false));
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
      // Removed on another device, unless it was changed here since, or confirmed here since by a review.
      if (!was || statement(was) !== statement(mine) || stays(mine, was)) result.push(mine);
      continue;
    }
    const chosen = statement(mine) === statement(other) || (was && statement(was) === statement(other)) ? mine : other;
    const loser = chosen === mine ? other : mine;
    // A wording somebody put back from does not win over the one they put back to, whichever device's review made it.
    const winner = statement(mine) !== statement(other) && rules.refused?.(chosen) && !rules.refused(loser) ? loser : chosen;
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
    // Removed here, unless another device changed it since, or its review confirmed it since.
    if (!was || statement(was) !== statement(other) || stays(other, was)) result.push(other);
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
 * The newest lines that fit. Decided by the lines alone, so every device cuts the same merged ledger at the
 * same place whatever else its copy holds.
 */
export function ledgerTail(lines: readonly string[]): string[] {
  const tail = lines.slice(-MAX_SYNCED_LEDGER_LINES);
  let bytes = tail.reduce((sum, line) => sum + Buffer.byteLength(line), 0);
  while (tail.length && bytes > MAX_LEDGER_BYTES) bytes -= Buffer.byteLength(tail.shift()!);
  return tail;
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
  // The account was reset while a first merge was waiting to be sent: as for any later reset, its copy replaces this one.
  const resetMeanwhile = mode === "link" && Boolean(base) && remote.generation > base!.generation;
  if (resetMeanwhile || (mode === "merge" && local.generation !== remote.generation)) {
    const { generation, items, suppressed, dismissed, declined, opaque } = !resetMeanwhile && local.generation > remote.generation ? local : remote;
    return { generation, items, suppressed, dismissed, declined, opaque };
  }
  // While linking, the base is the account's copy as it was first merged in: what the account dropped since is dropped here too.
  const was = base && (mode === "link" || base.generation === local.generation) ? base : undefined;
  // Not cut short here: dropping a record of a removal would let the habit come back. An overlong list stops the sync instead.
  const suppressed = mergeList(was?.suppressed, local.suppressed, remote.suppressed);
  const declined = mergeList(was?.declined, local.declined, remote.declined, 30);
  const dismissed = mergeList(was?.dismissed, local.dismissed, remote.dismissed, MAX_DISMISSED);
  /** Taken out on purpose on some device: deleted, its adding undone or declined, or (a sentence of the AI's) turned down. */
  const unwanted = (item: SyncedItem) => Boolean(item.key) && (suppressed.includes(item.key!) || dismissed.includes(`add:${item.key}:${item.value}`)
    || (item.basis === "summary" && declined.includes(item.text)));
  const rules: MergeRules = { unwanted, refused: item => dismissed.includes(`rewrite:${item.key}:${item.value}`), restored: item => dismissed.includes(`remove:${item.key}:${item.value}`) };
  return {
    generation: remote.generation, suppressed, declined, dismissed,
    // A removal its author made always wins: no device learns again, or keeps, what was taken out on purpose.
    // With or without a history in common: what one side holds and the other took out on purpose does not stay.
    // Nor does a wording somebody put a habit back from, where no other wording of that habit is left to prefer.
    items: mergeItems(was?.items, local.items, remote.items, rules).filter(item => item.origin !== "auto" || (!unwanted(item) && !rules.refused!(item))),
    // With no history in common (a copy that replaced a lost one), what this device carried for others is kept next to theirs.
    opaque: was ? remote.opaque : [...new Map([...remote.opaque, ...local.opaque].map(entry => [JSON.stringify(entry), entry])).values()].slice(0, MAX_OPAQUE_ITEMS),
  };
}

export function mergeWorkspace(base: WorkspaceBundle | null, local: WorkspaceBundle, remote: WorkspaceBundle | null, mode: MergeMode = base ? "merge" : "link"): WorkspaceBundle {
  if (!remote) return local;
  const was = base ?? undefined;
  const resetMeanwhile = mode === "link" && Boolean(base) && remote.generation > base!.generation;
  const replaced = resetMeanwhile || (mode === "merge" && local.generation !== remote.generation);
  return {
    ...local, copy: remote.copy, ...mergeLearned(was, local, remote, mode),
    note: mergeNote(was?.note, local.note, remote.note),
    settings: mergeSettings(was?.settings, local.settings, remote.settings),
    // A reset empties the ledger too.
    ledger: ledgerTail(mode === "reset" ? local.ledger : replaced ? (!resetMeanwhile && local.generation > remote.generation ? local : remote).ledger
      : mergeLedger(local.ledger, remote.ledger)),
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
function comparable(bundle: WorkspaceBundle | GlobalBundle, withVouchers = false): string {
  // Spelled out field by field: the order in which an object happened to be built is not content either.
  const switches = [bundle.settings.enabled, bundle.settings.aiSummary];
  if (bundle.kind === "global") return JSON.stringify([bundle.kind, bundle.note, switches, bundle.provider]);
  // Neither the order of a list nor the language an automatic sentence is shown in is content.
  const items = bundle.items.map(item => [identity(item), statement(item), item.basis, item.support, item.documents, item.firstSeenAt, item.lastConfirmedAt, item.devices.join(",")].join("\n")).sort();
  const sorted = (list: readonly string[]) => [...list].sort();
  return JSON.stringify([bundle.kind, bundle.generation, bundle.note, switches, items, sorted(bundle.suppressed), sorted(bundle.dismissed),
    sorted(bundle.declined), sorted(bundle.ledger), bundle.opaque.map(entry => JSON.stringify(entry)).sort(),
    // Who vouches for what is not part of the style itself: it changes nothing on a device that only compares styles.
    ...(withVouchers ? [Object.keys(bundle.vouchers).sort().map(account => [account, sorted(bundle.vouchers[account])])] : [])]);
}

/**
 * Something else of the account's that is synced under the same switch, account and plan: the app's own settings.
 * `update` runs under the style lock.
 */
export interface SyncedPart<T = unknown> {
  key: string;
  /** Null for a copy this version cannot read. Such a copy is neither merged nor overwritten. */
  parse(value: unknown): T | null;
  merge(base: T | null, local: T, remote: T): T;
  /**
   * Read what this device has, hand it to `merge`, store what comes back and return it, as one step that nothing
   * else writing the same settings can get in between. When `merge` throws, nothing is changed.
   */
  update(merge: (local: T) => T): Promise<T>;
  /** Equal as far as other devices are concerned. */
  comparable(value: T): string;
  /** Nothing worth storing while the account holds no copy yet. */
  empty(value: T): boolean;
}

interface ScopeState {
  revision: string | null; base: unknown; syncedAt: string | null;
  /** Switches the account has on and this device keeps off until its user turns them on here. */
  held?: { enabled?: boolean; aiSummary?: boolean };
  /** The first merge with the account's copy has begun and is not yet agreed. */
  linking?: boolean;
  /**
   * What was last agreed, kept while the server holds no copy. It is not something to merge against (whoever
   * writes the next copy shares no history with it), only where the entries come from that this device carries
   * along for others without being able to read them.
   */
  carry?: unknown;
}
interface SyncState {
  version: 1;
  enabled: boolean;
  /** A random name for this installation. It says nothing about the machine or its user. */
  device: string;
  /** Hash of the account these files were last merged with. */
  account: string | null;
  /** The server key each shared workspace on this device syncs under: the id the server knows it by. */
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
  /**
   * Shared workspaces on this device, each with the key its members keep it under. One that is not shared is
   * never synced. `readOnly`: this member may read the workspace's style but not change it for everyone.
   * `manager`: this member (an owner or admin) may reset it for everyone and set the switches that hold for everyone.
   */
  workspaces(): Promise<{ id: string; key: string; readOnly?: boolean; manager?: boolean }[]>;
  parts?: readonly SyncedPart[];
  provider(): Promise<string | null>;
  setProvider(provider: string): Promise<void>;
  /** Caller holds the lock. Drop this device's evidence for a workspace that was reset on another device. */
  forget(workspaceId: string): Promise<void>;
  log(error: unknown): void;
}

export interface SyncAccount {
  client: PersonalDataPort; userId(): string | null;
  /** False when the app was built without a server. */
  available?(): boolean;
  /** Whether the signed-in account's plan includes sync. Asked of the server, which refuses the others anyway. */
  entitled?(): Promise<boolean>;
}

class SyncProblem extends Error { constructor(readonly state: NonNullable<SyncState["problem"]>) { super(state); } }
const WORKSPACE_KEY = /^style-ws-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** The key of a shared workspace's copy, from the id the server knows the workspace by. */
export const workspaceKey = (catalogNodeId: string) => `style-ws-${catalogNodeId.toLowerCase()}`;
/** The server's id of the workspace a key stands for, or null for a key of the account's own. */
export const workspaceOfKey = (key: string) => WORKSPACE_KEY.exec(key)?.[1] ?? null;
/** The server's word for a refusal, as the transport reports it. */
const refusal = (error: unknown) => (error as { status?: number })?.status === 403 ? String((error as Error).message) : null;
const ENTITLEMENT_WAIT_MS = 1500;
const PLAN_FRESH_MS = 5 * 60_000;
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
  /** What the server last said about the signed-in account's plan. Unknown until asked. */
  private known: { userId: string; entitled: boolean; at: number } | null = null;

  private entitled(userId: string | null): boolean | null {
    return userId && this.known?.userId === userId ? this.known.entitled : null;
  }

  private async askPlan(userId: string): Promise<boolean> {
    const entitled = await this.account?.entitled?.() ?? true;
    if (this.account?.userId() === userId) this.known = { userId, entitled, at: Date.now() };
    return entitled;
  }

  /**
   * Learn the account's plan before the pane is shown, without making it wait for a slow network. A plan that did
   * not include sync is asked about again each time: the account may have been upgraded since, and with sync
   * turned off no run would find that out.
   */
  async knowPlan(): Promise<void> {
    const userId = this.account?.userId() ?? null;
    if (!userId || (this.entitled(userId) === true && Date.now() - this.known!.at < PLAN_FRESH_MS)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.askPlan(userId).catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, ENTITLEMENT_WAIT_MS); })]);
    clearTimeout(timer);
  }

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
      // On unless turned off: a Pro account's devices agree without being set up one by one.
      version: 1, enabled: value.enabled !== false, device: text(value.device, 64) && value.device ? value.device : randomUUID(),
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
  async view(workspaceId: string | null = null): Promise<AuthoringStyleSyncView> {
    const state = await this.state();
    const shared = workspaceId === null ? undefined : (await this.host.workspaces()).find(w => w.id === workspaceId && WORKSPACE_KEY.test(w.key));
    const scope = workspaceId === null ? "account" : !shared ? "device" : shared.readOnly ? "shared-view" : "shared";
    const userId = this.account?.userId() ?? null;
    const available = Boolean(this.account) && this.account!.available?.() !== false;
    const pro = this.entitled(userId);
    const status: AuthoringStyleSyncView["state"] = !available ? "unavailable" : !userId ? (state.enabled ? "signed-out" : "off")
      : pro === false || (pro === null && state.problem === "pro-required") ? "pro-required" : !state.enabled ? "off"
      : state.account && state.account !== hash(userId) ? "other-account" : state.problem === "pro-required" ? "ok" : state.problem ?? "ok";
    const standing = shared ? this.standing(shared, state) : null;
    return { available, signedIn: Boolean(userId), pro, scope, enabled: state.enabled, state: status, lastSyncedAt: state.lastSyncedAt,
      manage: standing?.manage ?? true, wide: standing?.wide ?? null };
  }

  /**
   * What this member may do to a shared workspace's style on this device. Once these files hold the copy all
   * members share, resetting it and the switches that hold for everyone are for an owner or admin; `wide` is how
   * those switches stand for everyone. Before that the files are this device's alone.
   */
  private standing(workspace: { key: string; manager?: boolean }, state: SyncState): { manage: boolean; wide: Settings | null } {
    const scope = state.scopes[workspace.key];
    const agreed = scope?.base as WorkspaceBundle | null | undefined;
    const linked = Boolean(scope?.revision) && agreed?.kind === "workspace";
    return { manage: Boolean(workspace.manager) || !linked, wide: linked ? settings(agreed!.settings) : null };
  }

  /**
   * Caller holds the style lock. The marks of everything in the members' copy these files last agreed on, or
   * null when they hold no such copy. For files without a record of what waits for approval, all of it waits.
   */
  async agreedMarks(workspaceId: string): Promise<Set<string> | null> {
    const state = await this.state();
    const agreed = state.scopes[state.keys[workspaceId] ?? ""]?.base as WorkspaceBundle | null | undefined;
    return agreed?.kind === "workspace" ? marksOf(agreed.items, agreed.note, agreed.declined) : null;
  }

  /** Hash of the signed-in account, as the record of what an account stands behind names it. */
  accountHash(): string | null {
    const userId = this.account?.userId() ?? null;
    return userId ? hash(userId) : null;
  }

  /** Caller holds the style lock. Shared workspaces whose style this member may not reset: it is all members'. */
  async unmanaged(): Promise<string[]> {
    const state = await this.state();
    return (await this.host.workspaces()).filter(w => WORKSPACE_KEY.test(w.key) && !this.standing(w, state).manage).map(w => w.id);
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
    // What the previous account stood behind in a shared workspace is not this account's word: everything of the
    // members' copy these files agreed on waits for this account's own approval (what this device finds in the
    // documents itself still needs none). What was only ever on this device stays its own.
    for (const [workspaceId, key] of Object.entries(state.keys)) {
      const agreed = state.scopes[key]?.base as WorkspaceBundle | null | undefined;
      const trust = await this.host.memory.readTrust(workspaceId);
      if ((trust.known && trust.account === hash(userId)) || (!trust.known && agreed?.kind !== "workspace")) continue;
      // Whatever the previous account stood behind waits too, whether or not these files still hold the copy it was agreed in.
      const foreign = [...new Set([...trust.foreign, ...trust.vouched, ...(agreed?.kind === "workspace" ? marksOf(agreed.items, agreed.note, agreed.declined) : [])])];
      await this.host.memory.writeTrust(workspaceId, { known: true, account: hash(userId), vouched: [], foreign, declined: trust.declined.filter(m => foreign.includes(m)) });
    }
    // What was agreed with the previous account, and how often it was reset, says nothing about this one.
    await this.write({ ...state, account: hash(userId), scopes: {}, resets: {}, problem: null });
  }

  /** Caller holds the style lock. A reset must not be undone by another device's older copy. */
  async noteReset(workspaceId: string | null): Promise<void> {
    const state = await this.state();
    // A workspace that is not shared has nothing on the account to reset.
    const workspaces = await this.host.workspaces();
    // Resetting everything leaves alone what is not this member's to reset.
    const spared = new Set(workspaces.filter(w => WORKSPACE_KEY.test(w.key) && !this.standing(w, state).manage).map(w => w.id));
    if (workspaceId !== null && spared.has(workspaceId)) throw new Error("Only an owner or admin can reset a shared workspace's style");
    const synced = new Set([...Object.keys(state.keys), ...workspaces.map(w => w.id)]);
    const ids = workspaceId === null ? [...synced].filter(id => !spared.has(id)) : synced.has(workspaceId) ? [workspaceId] : [];
    for (const id of ids) {
      state.generations[id] = (state.generations[id] ?? 0) + 1;
      // With nothing agreed yet there is no history to compare: remember that the reset is to stand.
      const scope = state.scopes[state.keys[id] ?? ""];
      if (state.enabled && (!scope?.base || scope.linking)) state.resets[id] = true;
    }
    await this.write(state);
  }

  /** Caller holds the style lock. The user set this switch here, so nothing holds it off for the account any more. */
  async noteSwitch(workspaceId: string | null, name: "enabled" | "aiSummary", value: boolean): Promise<void> {
    const state = await this.state();
    const shared = workspaceId === null ? undefined : (await this.host.workspaces()).find(w => w.id === workspaceId && WORKSPACE_KEY.test(w.key));
    const standing = shared ? this.standing(shared, state) : null;
    // Off for everyone is an owner's or admin's decision, and so is turning it back on. Any member may keep it
    // off on their own device: that changes nothing for the others and is never sent.
    if (standing && !standing.manage && value && standing.wide && !standing.wide[name]) throw new Error("Only an owner or admin can turn this on for the workspace");
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
      const status = (error as { status?: number })?.status;
      // The server is the judge of the plan: a refusal there stands whatever was known here.
      const userId = this.account?.userId() ?? null;
      if (status === 403 && userId) this.known = { userId, entitled: false, at: Date.now() };
      const problem = error instanceof SyncProblem ? error.state : status === 403 ? "pro-required" : status === 404 ? "unavailable" : "error";
      if (!(error instanceof SyncProblem) && status !== 403) this.host.log(error);
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
    // Nothing is sent, or asked for, on an account whose plan does not include sync.
    if (!await this.askPlan(userId)) throw new SyncProblem("pro-required");
    // These files are this account's from here on, before anything is merged: should the run stop halfway,
    // another account signing in later is asked first instead of being merged with what this one left behind.
    await this.host.exclusive(async () => {
      const state = await this.current(run);
      if (!state.account) await this.write({ ...state, account: hash(userId) });
    });
    await this.scope(GLOBAL_KEY, null, run);
    for (const part of this.host.parts ?? []) await this.part(part, run);
    // A shared workspace is the same one for every member, on every device: the server's id for it is the key.
    const seen = new Set<string>();
    const workspaces = (await this.host.workspaces()).filter(w => WORKSPACE_KEY.test(w.key) && !seen.has(w.key) && Boolean(seen.add(w.key)));
    const keys = await this.host.exclusive(async () => {
      const state = await this.current(run);
      const keys = { ...state.keys, ...Object.fromEntries(workspaces.map(w => [w.id, w.key])) };
      await this.write({ ...state, keys, account: state.account ?? hash(userId) });
      return keys;
    });
    let limited = false;
    for (const workspace of workspaces) {
      try { await this.scope(keys[workspace.id], workspace.id, run, Boolean(workspace.readOnly), Boolean(workspace.manager) && !workspace.readOnly); }
      catch (error) {
        if (error instanceof SyncProblem && error.state === "limit") limited = true;
        // No longer a member, or the workspace is gone: nothing of it is read or sent. The others go on.
        else if (refusal(error) === null || refusal(error) === "PRO_REQUIRED") throw error;
      }
    }
    await this.host.exclusive(async () => this.write({ ...await this.current(run), problem: limited ? "limit" : null, lastSyncedAt: this.host.now().toISOString() }));
  }

  /**
   * Whether a habit from the server may be used on this device. Its sentence is not taken on trust: an
   * automatic one must be a sentence this version makes itself, a hand-written one a plain single line.
   */
  private usable(item: SyncedItem, locale: AppLocale): boolean {
    if (item.origin === "auto") return Boolean(item.key) && itemText(item.key!, item.value, locale) !== null;
    // As it would be read back from the memo: a line that reads differently there would come back as a new line of this member's own.
    return item.text.length <= MAX_USER_LINE && !LINE_BREAK.test(item.text) && !isSuspicious(item.text) && Boolean(item.text.trim()) && item.text === item.text.trimEnd();
  }

  private async snapshot(workspaceId: string, state: SyncState, key: string): Promise<WorkspaceBundle & { own: Set<string>; derived: Set<string>; undoable: Set<string> }> {
    const memory = await this.host.memory.load(workspaceId, this.host.locale(), this.host.now());
    // Sending only part of a memo would read, on the other side, as the rest having been deleted.
    if (memory.items.length > MAX_SYNCED_ITEMS) throw new SyncProblem("limit");
    const generation = state.generations[workspaceId] ?? 0;
    const known = (state.scopes[key]?.base ?? state.scopes[key]?.carry) as WorkspaceBundle | GlobalBundle | null | undefined;
    // What this device could not use came from another one. It is carried along untouched, unless a reset erased it.
    const base = known?.kind === "workspace" && known.generation === generation ? known : null;
    const mine = new Set(memory.items.map(identity));
    const carried = (base?.items ?? []).filter(item => !mine.has(identity(item)) && !this.usable(item, memory.locale) && !memory.suppressed.includes(item.key ?? ""));
    const note = (await this.host.memory.readNote(workspaceId)).content;
    const bundle: WorkspaceBundle = {
      version: 1, kind: "workspace", copy: base?.copy ?? "", locale: memory.locale, generation,
      items: [...memory.items.map(item => this.synced(item, state.device)), ...carried], opaque: base?.opaque ?? [],
      suppressed: memory.suppressed, dismissed: memory.dismissed, declined: memory.declined,
      note, settings: await this.host.memory.settingsOf(workspaceId),
      ledger: ledgerTail((await this.host.memory.ledgerLines(workspaceId)).filter(line => line.length <= MAX_LEDGER_LINE && !line.includes(ARRIVED) && !line.includes(APPROVED))),
      updatedAt: this.host.now().toISOString(), device: state.device, vouchers: {},
    };
    // What these files hold themselves (not what is only carried along for others), and what this device found in the documents itself.
    return Object.assign(bundle, { own: marksOf(memory.items, note, memory.declined), derived: new Set(memory.items.filter(item => item.origin === "auto" && item.sources.length).map(itemMark)),
      // What stepping back can bring back into these files.
      undoable: new Set(memory.undo.flatMap(step => [...marksOf(step.items, "", step.declined ?? [])])) });
  }

  private synced(item: StyleItem, device: string): SyncedItem {
    const { id, key, value, section, text: sentence, origin, basis, support, documents, firstSeenAt, lastConfirmedAt } = item;
    return { id, key, value, section, text: sentence, origin, basis, support, documents, firstSeenAt, lastConfirmedAt,
      devices: [...new Set([...(item.devices ?? []).filter(d => d !== device), ...(item.sources.length ? [device] : [])])].sort() };
  }

  /**
   * A list of marks kept within bounds. Only marks of what is gone for good make room, the oldest first: one
   * that is still there, or that stepping back can bring back, is never dropped, since without its mark it
   * would count as this member's own. (What is needed is bounded by how much a workspace and its undo history hold.)
   */
  private bounded(marks: readonly string[], needed: (mark: string) => boolean): string[] {
    if (marks.length <= MAX_FOREIGN) return [...marks];
    const room = Math.max(0, MAX_FOREIGN - marks.filter(needed).length);
    const spare = marks.filter(mark => !needed(mark));
    const dropped = new Set(spare.slice(0, spare.length - room));
    return marks.filter(mark => !dropped.has(mark));
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
        // The evidence this device holds is for what its own item says. It says nothing for a habit another member changed.
        support: item.support, documents: item.documents, sources: mine && statement(mine) === statement(item) ? mine.sources : [], firstSeenAt: item.firstSeenAt, lastConfirmedAt: item.lastConfirmedAt,
        devices: item.devices.filter(d => d !== device) }];
    });
  }

  /** Caller holds the style lock. Check that the merged result fits before anything on this device is changed. */
  private async plan(workspaceId: string, merged: WorkspaceBundle, device: string): Promise<{ memory: StyleMemory; items: StyleItem[] }> {
    const memory = await this.host.memory.load(workspaceId, this.host.locale(), this.host.now());
    const items = this.restore(merged.items, [memory.items], memory.locale, device);
    if (renderMemo({ items }, memory.locale).length > AUTHORING_STYLE_LEARNED_LIMIT || merged.note.length > AUTHORING_STYLE_NOTE_LIMIT) throw new SyncProblem("limit");
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
    // Nor can a change the review made before a reset be put back after it.
    if (reset) memory.applied = [];
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

  /** As `scope`, for a part that brings its own reading, merging and applying. */
  private async part(part: SyncedPart, run: Run): Promise<void> {
    const client = this.account!.client;
    for (let attempt = 0; attempt < 3; attempt++) {
      this.alive(run);
      const remote = await client.read(run.userId, part.key, run.signal);
      const theirs = remote.revision === null ? null : part.parse(remote.content);
      if (remote.revision !== null && theirs === null) return;
      const merged = await this.host.exclusive(async () => {
        const state = await this.current(run);
        const known = state.scopes[part.key];
        if (remote.revision === null && known?.revision) {
          this.cancel();
          await this.write({ ...state, enabled: false, scopes: {}, resets: {}, problem: null });
          throw new Cancelled();
        }
        const base = known?.base === undefined || known.base === null ? null : part.parse(known.base);
        const result = await part.update(local => {
          const next = theirs === null ? local : part.merge(base, local, theirs);
          if (Buffer.byteLength(JSON.stringify(next)) > MAX_BUNDLE_BYTES) throw new SyncProblem("limit");
          return next;
        });
        // As in `scope`: what came from the server is on record before the upload can fail.
        const latest = await this.state();
        await this.write({ ...latest, scopes: { ...latest.scopes, [part.key]: { revision: remote.revision, base: theirs, syncedAt: known?.syncedAt ?? null } } });
        return result;
      });
      let revision = remote.revision;
      if (theirs === null ? !part.empty(merged) : part.comparable(merged) !== part.comparable(theirs)) {
        this.alive(run);
        const written = await client.write(run.userId, part.key, merged, remote.revision, run.signal);
        if (written === "conflict") continue;
        revision = written.revision;
      }
      await this.host.exclusive(async () => {
        const state = await this.current(run);
        await this.write({ ...state, scopes: { ...state.scopes, [part.key]: { revision, base: revision === null ? null : merged, syncedAt: this.host.now().toISOString() } } });
      });
      return;
    }
    throw new Error("Settings sync kept conflicting");
  }

  /** One key: read the server's copy, merge it into this device under the lock, send the result, remember what was agreed. */
  private async scope(key: string, workspaceId: string | null, run: Run, readOnly = false, manager = false): Promise<void> {
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
        // A workspace's copy is not this account's to delete. Should it be gone all the same, these files meet
        // whatever comes next as for the first time. What was agreed before is set aside (`carry`) until a copy
        // is back on the server.
        const before = known?.base as WorkspaceBundle | null | undefined;
        // Another copy under the same key: the one agreed on before was lost and written anew by someone without its history.
        const replaced = workspaceId !== null && Boolean(theirs && before?.kind === "workspace" && before.copy && (theirs as WorkspaceBundle).copy && before.copy !== (theirs as WorkspaceBundle).copy);
        const lost = workspaceId !== null && ((remote.revision === null && Boolean(known?.revision)) || replaced);
        if (remote.revision === null && known?.revision && !lost) {
          // The account's copy was deleted from another device. Do not put it back: stop syncing here too.
          this.cancel();
          await this.write({ ...state, enabled: false, scopes: {}, resets: {}, problem: null });
          throw new Cancelled();
        }
        // Until the first merge with the account's copy is agreed there is no shared history to merge against.
        const agreed = known?.base as WorkspaceBundle | GlobalBundle | null | undefined;
        const base = agreed?.kind === kind && !lost ? agreed : null;
        const linking = !base || Boolean(known?.linking);
        const held = (local: Settings): Settings => ({ enabled: local.enabled || Boolean(known?.held?.enabled), aiSummary: local.aiSummary || Boolean(known?.held?.aiSummary) });
        // What was merged in is on record before anything else can fail: a retry then tells what came from
        // the server from what was added here, and does not send back something another device has deleted since.
        // A reset made before these files met the copy is spent on this first meeting: should the upload meet a
        // conflict, the retry must not take it for a reset of what the members share.
        const carried = remote.revision === null ? known?.base ?? known?.carry ?? null : null;
        const spent = workspaceId !== null && !base && Boolean(state.resets[workspaceId]);
        const journal = async (heldNow: ScopeState["held"], generation?: number) => {
          const latest = await this.state();
          if (spent) latest.resets = Object.fromEntries(Object.entries(latest.resets).filter(([id]) => id !== workspaceId));
          await this.write({ ...latest, generations: generation === undefined ? latest.generations : { ...latest.generations, [workspaceId!]: generation },
            scopes: { ...latest.scopes, [key]: { revision: remote.revision, base: theirs, syncedAt: known?.syncedAt ?? null, held: heldNow, ...(linking ? { linking } : {}), ...(carried ? { carry: carried } : {}) } } });
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
        const { own, derived, undoable, ...mine } = await this.snapshot(workspaceId, state, key);
        const remoteCopy = theirs as WorkspaceBundle | null;
        // Resetting the style for everyone is an owner's or admin's to do (the server refuses it from anyone else):
        // from another member such a reset stays a change to this device's copy, and what the others do keeps arriving.
        // A reset that was not this member's to make (made while the device still took them for an admin, and
        // refused by the server) emptied these files only. It is not a deletion of everything either: these files
        // take the members' copy back as if they met it for the first time.
        const overruled = !manager && Boolean(remoteCopy) && mine.generation > remoteCopy!.generation;
        if (!manager) mine.generation = remoteCopy ? Math.min(mine.generation, remoteCopy.generation) : 0;
        // So are the switches that hold for everyone. Another member's own switch says what this device does, not what is sent.
        const local = { ...mine, settings: manager ? held(mine.settings) : remoteCopy ? remoteCopy.settings : { enabled: true, aiSummary: true } };
        // The copy belongs to all members. A reset stands against it only on a device that has seen it: one made
        // before these files ever met the workspace's copy erased what was here, not what the others share.
        const mode: MergeMode = overruled ? "link" : !linking ? "merge" : state.resets[workspaceId] && base && manager ? "reset" : "link";
        const result = mergeWorkspace(overruled ? null : base as WorkspaceBundle | null, local, theirs as WorkspaceBundle | null, mode);
        // The first to write a copy names it.
        if (!theirs) result.copy = randomUUID();
        // Whose word each habit and note line has. This member's: what these files held themselves and was not
        // waiting for approval, what this device found in the documents itself, what was approved here or on
        // another device of the same account. The rest is other members' and waits.
        const me = run.userId.toLowerCase();
        const trust = await this.host.memory.readTrust(workspaceId);
        const present = marksOf(result.items, result.note, result.declined);
        // A record kept for another account says what that account stood behind, not this one.
        const theirRecord = trust.known && trust.account !== null && trust.account !== hash(run.userId);
        const approved = new Set([...(theirRecord ? [] : trust.vouched), ...(remoteCopy?.vouchers[me] ?? [])]);
        // Files that held the members' copy before any such record was kept (or kept it for another account): whose
        // word each part of it has is not known, so all of it waits, except what the account vouched for or this device finds itself.
        const waiting = new Set([...(trust.known ? trust.foreign : []), ...(theirRecord ? trust.vouched : []),
          ...(!trust.known || theirRecord ? (before?.kind === "workspace" ? marksOf(before.items, before.note, before.declined) : []) : [])]);
        const vouched = [...present].filter(m => approved.has(m) || derived.has(m) || (own.has(m) && !waiting.has(m))).sort();
        const mineNow = new Set(vouched);
        // What waits keeps waiting when it is gone: stepping back to before it was deleted brings it back as
        // somebody else's, not as this member's. Only when the list is full does what is gone make room.
        const kept = [...new Set([...waiting, ...[...present].filter(m => !mineNow.has(m))])].filter(m => !mineNow.has(m));
        const foreign = this.bounded(kept, m => present.has(m) || undoable.has(m));
        // What this account stood behind stays on record when it is gone, as what waits does: brought back by
        // stepping back, it is this account's still, and another account's to approve should one sign in here.
        const gone = theirRecord ? [] : this.bounded(trust.vouched.filter(m => !present.has(m) && !foreign.includes(m)), m => undoable.has(m));
        const nextTrust: StyleTrust = { known: true, account: hash(run.userId), vouched: [...gone, ...vouched], foreign, declined: trust.declined.filter(m => foreign.includes(m)) };
        result.vouchers = Object.fromEntries([
          // The others' lists as they stand, less what is gone. Nothing is ever added to them here.
          ...Object.entries(remoteCopy?.vouchers ?? {}).filter(([account]) => account !== me).map(([account, list]) => [account, list.filter(m => present.has(m))] as const).filter(([, list]) => list.length),
          ...(vouched.length ? [[me, vouched] as const] : []),
        ]);
        // Everything is checked before anything on this device changes: a merge that does not fit changes nothing.
        if (result.items.length > MAX_SYNCED_ITEMS || result.suppressed.length > MAX_SUPPRESSED || Buffer.byteLength(JSON.stringify(result)) > MAX_BUNDLE_BYTES) throw new SyncProblem("limit");
        // Reset on another device: what this device collected before the reset goes as well.
        const reset = (mode === "merge" && result.generation > local.generation)
          || (mode === "link" && Boolean(base && theirs) && (theirs as WorkspaceBundle).generation > (base as WorkspaceBundle).generation);
        // What waits for approval is on record before what it is about is in these files: should the run stop in
        // between, nothing another member wrote is there without its mark.
        const sameTrust = trust.known && JSON.stringify([nextTrust.account, nextTrust.vouched, nextTrust.foreign, nextTrust.declined]) === JSON.stringify([trust.account, trust.vouched, trust.foreign, trust.declined]);
        if (comparable(result) !== comparable(local)) {
          const plan = await this.plan(workspaceId, result, state.device);
          // First with nothing dropped from it: until these files are changed they still hold what they held, and
          // should changing them fail, every line of it that waited must still be marked. Made to fit only afterwards.
          const whole = { ...nextTrust, foreign: kept, declined: trust.declined.filter(m => kept.includes(m)) };
          if (!sameTrust || kept.length !== foreign.length) await this.host.memory.writeTrust(workspaceId, whole);
          if (reset) await this.host.forget(workspaceId);
          await this.adopt(workspaceId, local, result, state.device, reset, plan);
          if (kept.length !== foreign.length) await this.host.memory.writeTrust(workspaceId, nextTrust);
        } else if (!sameTrust) await this.host.memory.writeTrust(workspaceId, nextTrust);
        const heldNow = await this.switches(workspaceId, mine.settings, result.settings);
        await journal(heldNow, result.generation);
        return { result, held: heldNow, carried, empty: !result.items.length && !result.opaque.length && !result.note && !result.ledger.length && !result.suppressed.length
          && result.settings.enabled && result.settings.aiSummary };
      });
      let revision = remote.revision;
      const changed = theirs ? comparable(merged.result, true) !== comparable(theirs, true) : !merged.empty;
      // What the others have agreed on. For a member who can only read, that is the server's copy, not the merge with their own.
      let agreed: unknown = merged.result;
      if (changed && readOnly) agreed = theirs;
      else if (changed) {
        if (Buffer.byteLength(JSON.stringify(merged.result)) > MAX_BUNDLE_BYTES) throw new SyncProblem("limit");
        this.alive(run);
        let written: { revision: string } | "conflict" | null;
        try { written = await client.write(run.userId, key, merged.result, remote.revision, run.signal); }
        catch (error) {
          // The role changed since the list of workspaces was read: what was sent is no longer this member's to change.
          if (workspaceId === null || !["READ_ONLY", "ADMIN_REQUIRED", "VOUCHER_MISMATCH"].includes(refusal(error) ?? "")) throw error;
          written = null;
        }
        // Another device, or another member, wrote in between: read that copy and merge again.
        if (written === "conflict") continue;
        if (written) revision = written.revision; else agreed = theirs;
      }
      await this.host.exclusive(async () => {
        const state = await this.current(run);
        const resets = Object.fromEntries(Object.entries(state.resets).filter(([id]) => id !== workspaceId));
        await this.write({ ...state, resets, scopes: { ...state.scopes, [key]: { revision, syncedAt: this.host.now().toISOString(), held: merged.held,
          base: revision === null ? null : agreed, ...(revision === null && "carried" in merged && merged.carried ? { carry: merged.carried } : {}) } } });
      });
      return;
    }
    throw new Error("Style sync kept conflicting");
  }
}
