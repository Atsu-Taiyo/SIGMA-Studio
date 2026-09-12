import { createHash } from "node:crypto";

export interface LocalStoreWriteIdentityPorts {
  readFile(filePath: string): Promise<string>;
  stat(filePath: string): Promise<{ size: number; mtimeMs: number; ino: number }>;
}

/**
 * Identifies this store instance's writes without owning their persistence.
 * Document writers remember the signature before rename exposes the bytes, then
 * record the durable writer's stat token. Ledger/workspace writers retain their
 * own existing registration point. A stat match is consumed once; byte signatures
 * remain available for duplicate events and volumes with coarse timestamps.
 */
export class LocalStoreWriteIdentity {
  private readonly signatures = new Map<string, string | null>();
  private readonly stats = new Map<string, string>();

  constructor(private readonly ports: LocalStoreWriteIdentityPorts) {}

  rememberSignature(filePath: string, raw: string): void {
    this.signatures.set(filePath, hashRaw(raw));
  }

  recordStat(filePath: string, statToken: string | null): void {
    if (statToken) {
      this.stats.set(filePath, statToken);
    } else {
      this.stats.delete(filePath);
    }
  }

  async matchesStat(filePath: string): Promise<boolean> {
    const expected = this.stats.get(filePath);
    if (!expected) {
      return false;
    }
    try {
      const stat = await this.ports.stat(filePath);
      if (`${stat.size}:${stat.mtimeMs}:${stat.ino}` !== expected) {
        return false;
      }
      this.stats.delete(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async matchesFile(filePath: string): Promise<boolean> {
    try {
      const raw = await this.ports.readFile(filePath);
      return this.matchesSignature(filePath, raw);
    } catch {
      return false;
    }
  }

  matchesSignature(filePath: string, raw?: string): boolean {
    const expected = this.signatures.get(filePath);
    if (!expected) {
      return false;
    }
    if (raw !== undefined) {
      return expected === hashRaw(raw);
    }
    return false;
  }
}

function hashRaw(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
