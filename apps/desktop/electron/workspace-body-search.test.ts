import { build } from "esbuild";
import { appendFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { SigmaDocument } from "@/features/document";
import type { WorkspaceFileSummary } from "@/lib/runtime/types";
import type { WorkspaceBodySearchUpdate } from "@/lib/workspace-body-search-contract";
import type { BodyTextStore, StoredBodyText } from "@/lib/workspace-body-search";

import { BodyTextWorkerPool, createBodyTextDiskStore, createWorkspaceBodySearchService } from "./workspace-body-search";

let directory: string;
let workerPath: string;

beforeAll(async () => {
  const root = path.resolve(process.cwd(), "../../tmp");
  await mkdir(root, { recursive: true });
  directory = await mkdtemp(path.join(root, "body-search-test-"));
  workerPath = path.join(directory, "worker.cjs");
  await build({
    entryPoints: [path.resolve("electron/workspace-body-search-worker.ts")],
    outfile: workerPath,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "cjs",
    alias: { "@": path.resolve("src") },
    logLevel: "silent",
  });
});

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("body text disk store", () => {
  it("keeps the latest text per file, survives a half-written line and compacts dead lines", async () => {
    const userData = await mkdtemp(path.join(directory, "store-"));
    const store = createBodyTextDiskStore(userData);
    expect(await scanAll(store)).toEqual([]);
    await store.save({ fileId: "file_a", stamp: "1:x", text: "三角関数" });
    await store.save({ fileId: "file_b", stamp: "2:y", text: "微分" });
    await store.save({ fileId: "file_a", stamp: "3:z", text: "書き換え" });
    expect(await scanAll(store)).toEqual([
      { fileId: "file_a", stamp: "3:z", text: "書き換え" },
      { fileId: "file_b", stamp: "2:y", text: "微分" },
    ]);

    // 書き込みの途中で止まった行は捨て、次に足した行とはつながらない。
    const shards = (await readdir(path.join(userData, "workspace-search-index"))).filter((name) => name.endsWith(".tsv"));
    await appendFile(path.join(userData, "workspace-search-index", shards[0]), "\nfile_c\t1:w\t10\t途中で");
    await store.save({ fileId: "file_d", stamp: "1:v", text: "最後の行" });
    expect((await scanAll(store)).map((record) => record.fileId)).toEqual(["file_a", "file_b", "file_d"]);

    // 削除された教材の行と古い行がたまったら、その束を書き直して片付ける。
    for (let n = 0; n < 200; n += 1) await store.save({ fileId: "file_a", stamp: `${n}:z`, text: "何度も保存" });
    const before = await shardSizes(userData);
    const kept: string[] = [];
    await store.scan((record) => kept.push(record.fileId), { keep: new Set(["file_a", "file_d"]) });
    expect(kept.sort()).toEqual(["file_a", "file_d"]);
    await vi.waitFor(async () => expect(await shardSizes(userData)).toBeLessThan(before / 10));
    // 一覧に無い教材の行は、片付けを待たずに検索から外れる (片付くのはその束に古い行がたまったとき)。
    const latest: StoredBodyText[] = [];
    await store.scan((record) => latest.push(record), { keep: new Set(["file_a", "file_d"]) });
    expect(latest.sort((a, b) => a.fileId.localeCompare(b.fileId))).toEqual([
      { fileId: "file_a", stamp: "199:z", text: "何度も保存" },
      { fileId: "file_d", stamp: "1:v", text: "最後の行" },
    ]);
  });

  it("stops between shards when asked", async () => {
    const userData = await mkdtemp(path.join(directory, "stop-"));
    const store = createBodyTextDiskStore(userData);
    for (let n = 0; n < 40; n += 1) await store.save({ fileId: `file_${n}`, stamp: "1", text: "本文" });
    let visited = 0;
    expect(await store.scan(() => { visited += 1; }, { shouldStop: () => visited > 0 })).toBe(false);
    expect(visited).toBeGreaterThan(0);
    expect(visited).toBeLessThan(40);
  });
});

describe("BodyTextWorkerPool", () => {
  it("parses documents off the main thread and survives unreadable files", async () => {
    const pool = new BodyTextWorkerPool({ workerPath, size: 2, idleMs: 20 });
    try {
      const good = await writeDocument("good.json", "ワーカーで読んだ本文");
      const broken = path.join(directory, "broken.json");
      await writeFile(broken, "{ not json");
      const results = await Promise.all([pool.extract(good), pool.extract(broken), pool.extract(path.join(directory, "missing.json")), pool.extract(good)]);
      expect(results).toEqual(["ワーカーで読んだ本文", null, null, "ワーカーで読んだ本文"]);
      // 使っていない間に終わったスレッドの代わりを、次の依頼で起こし直す。
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(await pool.extract(good)).toBe("ワーカーで読んだ本文");
    } finally {
      pool.close();
    }
  });
});

describe("workspace body search service", () => {
  it("searches local bodies through the worker and shared bodies through the catalog, persisting only local text", async () => {
    const userData = await mkdtemp(path.join(directory, "service-"));
    const localPath = await writeDocument("local.json", "ローカルの三角関数");
    const files: WorkspaceFileSummary[] = [
      summary("file_local", "ローカル教材"),
      { ...summary("catalog_shared", "共有教材"), sharing: { source: "shared" } as unknown as WorkspaceFileSummary["sharing"] },
      summary("file_title", "三角関数の題名"),
    ];
    const loadSharedDocument = vi.fn(async () => document("共有の三角関数"));
    const service = createWorkspaceBodySearchService({
      userDataPath: userData,
      workerPath,
      searchOverview: async () => ({ activeWorkspaceId: "w", workspaces: [], folders: [], files }),
      documentBodyPath: (file) => (file.fileId === "file_local" ? localPath : path.join(directory, "none.json")),
      loadSharedDocument,
      sharedScope: () => "user",
    });
    try {
      const updates: WorkspaceBodySearchUpdate[] = [];
      const session = service.open((update) => updates.push(update));
      await session.setQuery(1, "三角");
      await vi.waitFor(() => expect(updates.at(-1)?.pending).toBe(0));
      const hits = new Map(updates.flatMap((update) => update.hits).map((hit) => [hit.fileId, hit.excerpt]));
      expect([...hits.keys()].sort()).toEqual(["catalog_shared", "file_local"]);
      expect(hits.get("file_local")).toEqual({ before: "ローカルの", match: "三角", after: "関数" });
      expect(loadSharedDocument).toHaveBeenCalledWith("catalog_shared");
      expect(await scanAll(createBodyTextDiskStore(userData))).toEqual([{ fileId: "file_local", stamp: "1:2026-01-01T00:00:00.000Z", text: "ローカルの三角関数" }]);
      service.release(session);
    } finally {
      service.close();
    }
  });
});

function summary(fileId: string, title: string): WorkspaceFileSummary {
  return { fileId, title, workspaceId: "w", folderId: null, docId: fileId, revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

function document(text: string): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc",
    metadata: { title: "題名" },
    content: [{ type: "paragraph", id: "p", children: [{ type: "text", text }] }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
}

async function writeDocument(name: string, text: string): Promise<string> {
  const target = path.join(directory, name);
  await writeFile(target, JSON.stringify(document(text)));
  return target;
}

async function scanAll(store: BodyTextStore): Promise<StoredBodyText[]> {
  const records: StoredBodyText[] = [];
  await store.scan((record) => records.push(record));
  return records.sort((a, b) => a.fileId.localeCompare(b.fileId));
}

async function shardSizes(userData: string): Promise<number> {
  const folder = path.join(userData, "workspace-search-index");
  const names = (await readdir(folder)).filter((name) => name.endsWith(".tsv"));
  const sizes = await Promise.all(names.map(async (name) => (await stat(path.join(folder, name))).size));
  return sizes.reduce((sum, size) => sum + size, 0);
}
