import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const APPLICATION_FONT_MAX_BYTES = 24 * 1024 * 1024;
export const isApplicationFontId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

function fontType(bytes: Uint8Array): string | null {
  if (bytes.length < 13) return null;
  const signature = Buffer.from(bytes.buffer, bytes.byteOffset, 4);
  if (signature.equals(Buffer.from([0, 1, 0, 0]))) return "font/ttf";
  return ({ OTTO: "font/otf", wOFF: "font/woff", wOF2: "font/woff2" } as Record<string, string>)[signature.toString("ascii")] ?? null;
}

/** Content-addressed resources shared by documents, outside SigmaDoc JSON. */
export class ApplicationFontStore {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly directory: string) {}

  async read(resourceId: string): Promise<Buffer | null> {
    if (!isApplicationFontId(resourceId)) return null;
    try {
      const filename = path.join(this.directory, `${resourceId}.font`);
      const stat = await fs.stat(filename);
      if (stat.size > APPLICATION_FONT_MAX_BYTES) return null;
      const bytes = await fs.readFile(filename);
      return fontType(bytes) && createHash("sha256").update(bytes).digest("hex") === resourceId ? bytes : null;
    } catch { return null; }
  }

  async ensure(resourceId: string, download: () => Promise<Uint8Array>): Promise<void> {
    if (!isApplicationFontId(resourceId)) throw new Error("INVALID_FONT_ID");
    const existing = this.pending.get(resourceId);
    if (existing) return existing;
    const work = (async () => {
      if (await this.read(resourceId)) return;
      const bytes = await download();
      if (bytes.byteLength > APPLICATION_FONT_MAX_BYTES || !fontType(bytes)
        || createHash("sha256").update(bytes).digest("hex") !== resourceId) throw new Error("INVALID_FONT_RESOURCE");
      await fs.mkdir(this.directory, { recursive: true });
      const target = path.join(this.directory, `${resourceId}.font`), temporary = `${target}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, bytes, { flag: "wx" }); await fs.rename(temporary, target); }
      finally { await fs.rm(temporary, { force: true }); }
    })();
    this.pending.set(resourceId, work);
    try { await work; } finally { this.pending.delete(resourceId); }
  }

  async resolve(resourceIds: unknown): Promise<{ resources: Record<string, string>; missing: string[] }> {
    if (!Array.isArray(resourceIds) || resourceIds.length > 32 || !resourceIds.every(isApplicationFontId)) throw new Error("INVALID_FONT_IDS");
    const resources: Record<string, string> = {}, missing: string[] = [];
    for (const id of new Set<string>(resourceIds)) {
      if (await this.read(id)) resources[id] = `sigma-app-font://${id}/`;
      else missing.push(id);
    }
    return { resources, missing };
  }

  async response(rawUrl: string): Promise<Response> {
    const url = new URL(rawUrl);
    if (url.protocol !== "sigma-app-font:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password
      || !isApplicationFontId(url.hostname)) return new Response(null, { status: 404 });
    const bytes = await this.read(url.hostname);
    return bytes ? new Response(new Uint8Array(bytes), { headers: {
      "Content-Type": fontType(bytes)!, "Access-Control-Allow-Origin": "*", "Cache-Control": "private, max-age=31536000, immutable",
    } }) : new Response(null, { status: 404 });
  }
}
