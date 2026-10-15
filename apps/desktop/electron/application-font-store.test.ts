import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ApplicationFontStore } from "./application-font-store";

it("shares a verified resource, survives reopening, and serves only its content ID", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-font-store-"));
  const bytes = Buffer.alloc(32); bytes[1] = 1;
  const id = createHash("sha256").update(bytes).digest("hex"), download = vi.fn(async () => bytes);
  try {
    const store = new ApplicationFontStore(directory);
    await Promise.all([store.ensure(id, download), store.ensure(id, download)]);
    expect(download).toHaveBeenCalledTimes(1);
    await new ApplicationFontStore(directory).ensure(id, download);
    expect(download).toHaveBeenCalledTimes(1);
    expect(await store.resolve([id])).toEqual({ resources: { [id]: `sigma-app-font://${id}/` }, missing: [] });
    const response = await store.response(`sigma-app-font://${id}/`);
    expect(response.headers.get("content-type")).toBe("font/ttf");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect((await store.response(`sigma-app-font://${id}/other`)).status).toBe(404);
    expect((await store.response(`sigma-app-font://${id}/?path=/etc/passwd`)).status).toBe(404);
    await expect(store.resolve(["../other"])).rejects.toThrow("INVALID_FONT_IDS");
    await fs.writeFile(path.join(directory, `${id}.font`), Buffer.alloc(32));
    expect((await store.response(`sigma-app-font://${id}/`)).status).toBe(404);
    await store.ensure(id, download);
    expect(await store.read(id)).toEqual(bytes);
    expect((await fs.readdir(directory)).filter(name => name.endsWith(".tmp"))).toEqual([]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

it("rejects a mismatched download without persisting it", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-font-mismatch-"));
  try {
    const store = new ApplicationFontStore(directory);
    const bytes = Buffer.alloc(32); bytes[1] = 1;
    await expect(store.ensure("a".repeat(64), async () => bytes)).rejects.toThrow("INVALID_FONT_RESOURCE");
    expect(await fs.readdir(directory)).toEqual([]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
