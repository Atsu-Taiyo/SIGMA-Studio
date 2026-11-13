import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { SharedBackup, SharedVersion } from "@/features/collaboration/model/bridge";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { durableWrite } from "./journal";

const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BODIES = 20;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/i.test(value);
export function validBackup(value: unknown): value is SharedBackup {
  if (!value || typeof value !== "object") return false;
  const v = value as SharedBackup;
  return validId(v.id) && Number.isSafeInteger(v.epoch) && v.epoch >= 1 && typeof v.created_at === "string"
    && Number.isFinite(Date.parse(v.created_at)) && (v.kind === undefined || ["auto", "manual", "restore"].includes(v.kind));
}

interface Cache { checkedAt: number; versions: SharedBackup[]; bodies: SharedVersion[] }
/** Read-only copies, separate from the editable journal. Bounded and scoped to actor, server and document. */
export class SharedVersionCache {
  private tail: Promise<void> = Promise.resolve();
  readonly filename: string;
  constructor(directory: string, identity: string, private readonly now = Date.now) {
    this.filename = path.join(directory, "version-cache", `${createHash("sha256").update(identity).digest("hex")}.json`);
  }
  private async read(): Promise<Cache | null> {
    try {
      if ((await fs.stat(this.filename)).size > MAX_CACHE_BYTES) return null;
      const value = JSON.parse(await fs.readFile(this.filename, "utf8")) as Cache;
      const age = this.now() - value.checkedAt;
      if (!Number.isFinite(age) || age < 0 || age >= GRACE_MS || !Array.isArray(value.versions)
        || value.versions.length > 1000 || !value.versions.every(validBackup) || !Array.isArray(value.bodies)
        || value.bodies.length > MAX_BODIES || !value.bodies.every(validBackup)) return null;
      return value;
    } catch { return null; }
  }
  async list(): Promise<SharedBackup[] | null> {
    const cache = await this.read();
    return cache?.versions.map(version => ({ ...version, offline: true })) ?? null;
  }
  async get(id: string): Promise<SharedVersion | null> {
    const value = (await this.read())?.bodies.find(body => body.id === id);
    if (!value) return null;
    try { return { ...value, document: parseSigmaDocument(value.document), offline: true }; }
    catch { return null; }
  }
  private update(change: (previous: Cache | null) => Cache | null): Promise<void> {
    const next = this.tail.then(async () => {
      const value = change(await this.read());
      if (!value) return;
      let serialized = JSON.stringify(value);
      while (Buffer.byteLength(serialized) > MAX_CACHE_BYTES && value.bodies.length) {
        value.bodies.shift(); serialized = JSON.stringify(value);
      }
      await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
      await durableWrite(this.filename, serialized);
    });
    this.tail = next.catch(() => {});
    return next;
  }
  async saveList(versions: SharedBackup[]): Promise<void> {
    if (versions.length > 1000 || !versions.every(validBackup)) throw new Error("INVALID_VERSION_LIST");
    await this.update(previous => ({ checkedAt: this.now(), versions: versions.map(({ id, epoch, created_at, kind }) => ({ id, epoch, created_at, kind })),
      bodies: previous?.bodies.filter(body => versions.some(v => v.id === body.id)) ?? [] }));
  }
  async saveBody(version: SharedVersion): Promise<void> {
    if (!validBackup(version)) throw new Error("INVALID_VERSION_RESPONSE");
    const body = { ...version, document: parseSigmaDocument(version.document) };
    await this.update(previous => previous ? { ...previous,
      bodies: [...previous.bodies.filter(v => v.id !== version.id), body].slice(-MAX_BODIES) } : null);
  }
  async clear(): Promise<void> {
    const next = this.tail.then(() => fs.rm(this.filename, { force: true }));
    this.tail = next.catch(() => {}); await next;
  }
}
