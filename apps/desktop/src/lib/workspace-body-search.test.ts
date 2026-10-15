import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMemoryBodyTextStore,
  matchesSearchTerms,
  searchTerms,
  toIndexedText,
  WorkspaceBodySearchSession,
  WorkspaceBodyTextIndex,
  type BodySearchFile,
  type BodySearchSource,
  type BodyTextStore,
} from "./workspace-body-search";
import type { WorkspaceBodySearchUpdate } from "./workspace-body-search-contract";

afterEach(() => {
  vi.useRealTimers();
});

describe("search terms", () => {
  it("splits on whitespace and folds width and case", () => {
    expect(searchTerms("  ２次関数　ＳＩＮ ")).toEqual(["2次関数", "sin"]);
    expect(matchesSearchTerms("２次関数の最大値", searchTerms("2次 最大"))).toBe(true);
    expect(matchesSearchTerms("２次関数の最大値", searchTerms("2次 最小"))).toBe(false);
    expect(matchesSearchTerms("何でも", [])).toBe(false);
  });
});

describe("WorkspaceBodySearchSession", () => {
  it("answers from stored text at once, then streams what it reads, unread files first and newest first", async () => {
    const store = await storeWith({ cached: { stamp: "1:a", text: "キャッシュ済みの三角関数" } });
    const index = new WorkspaceBodyTextIndex({ store });
    const texts = new Map([["old", "古い三角関数"], ["new", "新しい三角関数"], ["other", "関係ない本文"]]);
    const reads: string[] = [];
    const gates = new Map<string, () => void>();
    const source: BodySearchSource = {
      list: async () => [
        file("cached", "1:a", "2026-01-01T00:00:00Z"),
        file("old", "1:b", "2026-01-02T00:00:00Z"),
        file("new", "1:c", "2026-03-01T00:00:00Z"),
        file("other", "1:d", "2026-02-01T00:00:00Z"),
      ],
      readText: (target) => new Promise((resolve) => {
        reads.push(target.fileId);
        gates.set(target.fileId, () => resolve(texts.get(target.fileId) ?? null));
      }),
    };
    const updates: WorkspaceBodySearchUpdate[] = [];
    const session = new WorkspaceBodySearchSession(index, source, (update) => updates.push(update), { localConcurrency: 1, flushMs: 0 });

    await session.setQuery(1, "三角");
    expect(updates).toEqual([{ queryId: 1, reset: true, hits: [{ fileId: "cached", excerpt: { before: "キャッシュ済みの", match: "三角", after: "関数" } }], removed: [], pending: 3 }]);
    expect(reads).toEqual(["new"]);

    gates.get("new")!();
    await vi.waitFor(() => expect(reads).toEqual(["new", "other"]));
    await vi.waitFor(() => expect(updates.at(-1)).toMatchObject({ reset: false, hits: [{ fileId: "new" }], pending: 2 }));
    gates.get("other")!();
    await vi.waitFor(() => expect(reads).toEqual(["new", "other", "old"]));
    gates.get("old")!();
    await vi.waitFor(() => expect(updates.at(-1)).toMatchObject({ reset: false, hits: [{ fileId: "old" }], pending: 0 }));
    expect(await stored(store)).toEqual(["cached", "new", "other", "old"]);

    // 検索語を変えても読み直さず、置いた本文から全件を答える。
    await session.setQuery(2, "関係");
    expect(updates.at(-1)).toEqual({ queryId: 2, reset: true, hits: [{ fileId: "other", excerpt: { before: "", match: "関係", after: "ない本文" } }], removed: [], pending: 0 });
    expect(reads).toHaveLength(3);
  });

  it("excerpts inside the matching block, keeps the original case and matches terms across the title and the body", async () => {
    const long = `${"あ".repeat(40)}目印${"い".repeat(10)}`;
    const store = await storeWith({
      a: { stamp: "1", text: `前の段落\n本文に Sine Rule と三角関数\n次の段落` },
      b: { stamp: "1", text: long },
      c: { stamp: "1", text: "題名だけ" },
    });
    const updates: WorkspaceBodySearchUpdate[] = [];
    const session = new WorkspaceBodySearchSession(new WorkspaceBodyTextIndex({ store }), {
      list: async () => [file("a", "1", "2026-01-01T00:00:00Z", "演習プリント"), file("b", "1", "2026-01-01T00:00:00Z"), file("c", "1", "2026-01-01T00:00:00Z", "演習")],
      readText: async () => { throw new Error("not read"); },
    }, (update) => updates.push(update), { flushMs: 0 });

    await session.setQuery(1, "sine 三角");
    expect(updates.at(-1)?.hits).toEqual([{ fileId: "a", excerpt: { before: "本文に ", match: "Sine", after: " Rule と三角関数" } }]);
    await session.setQuery(2, "演習 三角");
    expect(updates.at(-1)?.hits.map((hit) => hit.fileId)).toEqual(["a"]);
    await session.setQuery(3, "演習");
    expect(updates.at(-1)?.hits).toEqual([]);
    await session.setQuery(4, "目印");
    expect(updates.at(-1)?.hits).toEqual([{ fileId: "b", excerpt: { before: `…${"あ".repeat(16)}`, match: "目印", after: "い".repeat(10) } }]);
  });

  it("shows stale text at once, re-reads changed files and removes ones that no longer match", async () => {
    const store = await storeWith({ a: { stamp: "1", text: "旧い三角関数" }, b: { stamp: "1", text: "三角形" } });
    const updates: WorkspaceBodySearchUpdate[] = [];
    const session = new WorkspaceBodySearchSession(new WorkspaceBodyTextIndex({ store }), {
      list: async () => [file("a", "2", "2026-01-01T00:00:00Z"), file("b", "1", "2026-01-01T00:00:00Z")],
      readText: async () => "書き換えた本文",
    }, (update) => updates.push(update), { flushMs: 0 });

    await session.setQuery(1, "三角");
    expect(updates[0]).toMatchObject({ reset: true, pending: 1 });
    expect(updates[0].hits.map((hit) => hit.fileId).sort()).toEqual(["a", "b"]);
    await vi.waitFor(() => expect(updates.at(-1)).toEqual({ queryId: 1, reset: false, hits: [], removed: ["a"], pending: 0 }));
  });

  it("keeps the previous text when a body cannot be read, and does not retry it in the same session", async () => {
    const store = await storeWith({ a: { stamp: "1", text: "三角関数" } });
    const readText = vi.fn(async () => { throw new Error("offline"); });
    const updates: WorkspaceBodySearchUpdate[] = [];
    const session = new WorkspaceBodySearchSession(new WorkspaceBodyTextIndex({ store }), { list: async () => [file("a", "2", "2026-01-01T00:00:00Z")], readText }, (update) => updates.push(update), { flushMs: 0 });

    await session.setQuery(1, "三角");
    await vi.waitFor(() => expect(updates.at(-1)?.pending).toBe(0));
    expect(updates.flatMap((update) => update.removed)).toEqual([]);
    await session.setQuery(2, "三角関数");
    expect(updates.at(-1)).toMatchObject({ queryId: 2, hits: [{ fileId: "a" }], pending: 0 });
    expect(readText).toHaveBeenCalledTimes(1);
  });

  it("re-reads shared files after the interval, drops them when the account changes, and never stores them", async () => {
    let now = 0;
    let scope = "user-a";
    const store = createMemoryBodyTextStore();
    const index = new WorkspaceBodyTextIndex({ store, now: () => now, sharedTtlMs: 1000 });
    const readText = vi.fn(async (): Promise<string | null> => "共有の三角関数");
    const source = { list: async () => [file("s", "1", "2026-01-01T00:00:00Z", "共有", true)], readText, sharedScope: () => scope };
    const run = async (query: string) => {
      const updates: WorkspaceBodySearchUpdate[] = [];
      const session = new WorkspaceBodySearchSession(index, source, (update) => updates.push(update), { flushMs: 0, now: () => now });
      await session.setQuery(1, query);
      await vi.waitFor(() => expect(updates.at(-1)?.pending).toBe(0));
      return updates;
    };

    await run("三角");
    expect(readText).toHaveBeenCalledTimes(1);
    expect(await stored(store)).toEqual([]);
    now = 500;
    expect((await run("三角"))[0].hits).toHaveLength(1);
    expect(readText).toHaveBeenCalledTimes(1);
    now = 1500;
    await run("三角");
    expect(readText).toHaveBeenCalledTimes(2);
    scope = "user-b";
    readText.mockResolvedValueOnce(null);
    expect((await run("三角"))[0]).toMatchObject({ hits: [], pending: 1 });
  });

  it("forgets the stored text of files that left the library", async () => {
    const store = await storeWith({ gone: { stamp: "1", text: "消えた教材" }, kept: { stamp: "1", text: "残る教材" } });
    const updates: WorkspaceBodySearchUpdate[] = [];
    const session = new WorkspaceBodySearchSession(new WorkspaceBodyTextIndex({ store }), { list: async () => [file("kept", "1", "2026-01-01T00:00:00Z")], readText: async () => null }, (update) => updates.push(update), { flushMs: 0 });
    await session.setQuery(1, "教材");
    expect(updates[0].hits.map((hit) => hit.fileId)).toEqual(["kept"]);
    expect(await stored(store)).toEqual(["kept"]);
  });

  it("lists the library when the search opens, not on every keystroke, and again only after a change", async () => {
    const list = vi.fn(async () => [file("a", "1", "2026-01-01T00:00:00Z")]);
    const updates: WorkspaceBodySearchUpdate[] = [];
    const session = new WorkspaceBodySearchSession(new WorkspaceBodyTextIndex({ store: await storeWith({ a: { stamp: "1", text: "本文" } }) }), { list, readText: async () => null }, (update) => updates.push(update), { flushMs: 0 });
    await session.setQuery(1, "");
    expect(list).toHaveBeenCalledTimes(1);
    expect(updates).toEqual([{ queryId: 1, reset: true, hits: [], removed: [], pending: 0 }]);
    await session.setQuery(2, "本");
    await session.setQuery(3, "本文");
    expect(list).toHaveBeenCalledTimes(1);
    expect(updates.at(-1)).toMatchObject({ queryId: 3, hits: [{ fileId: "a" }] });
    session.invalidate();
    await session.setQuery(4, "本");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("searches the current terms again by itself after the library changes", async () => {
    let stamp = "1";
    const store = await storeWith({ a: { stamp: "1", text: "三角関数" } });
    const updates: WorkspaceBodySearchUpdate[] = [];
    const session = new WorkspaceBodySearchSession(new WorkspaceBodyTextIndex({ store }), {
      list: async () => [file("a", stamp, "2026-01-01T00:00:00Z")],
      readText: async () => "二次関数",
    }, (update) => updates.push(update), { flushMs: 0 });
    await session.setQuery(7, "三角");
    expect(updates.at(-1)).toMatchObject({ queryId: 7, hits: [{ fileId: "a" }] });
    stamp = "2";
    session.invalidate();
    await vi.waitFor(() => expect(updates.at(-1)).toMatchObject({ queryId: 7, reset: false, removed: ["a"], pending: 0 }));
    expect(updates.filter((update) => update.reset)).toHaveLength(2);
    session.close();
  });

  it("does not read the same body twice when two sessions ask for it together", async () => {
    const index = new WorkspaceBodyTextIndex();
    let resolve!: (text: string) => void;
    const readText = vi.fn(() => new Promise<string | null>((done) => { resolve = done; }));
    const source = { list: async () => [file("a", "1", "2026-01-01T00:00:00Z")], readText };
    const first: WorkspaceBodySearchUpdate[] = [];
    const second: WorkspaceBodySearchUpdate[] = [];
    await new WorkspaceBodySearchSession(index, source, (update) => first.push(update), { flushMs: 0 }).setQuery(1, "本文");
    await new WorkspaceBodySearchSession(index, source, (update) => second.push(update), { flushMs: 0 }).setQuery(1, "本文");
    resolve("本文です");
    await vi.waitFor(() => expect(second.at(-1)).toMatchObject({ hits: [{ fileId: "a" }], pending: 0 }));
    expect(first.at(-1)).toMatchObject({ hits: [{ fileId: "a" }], pending: 0 });
    expect(readText).toHaveBeenCalledTimes(1);
  });

  it("sends the first answer without waiting for a long scan, batches the rest and stops after close", async () => {
    vi.useFakeTimers();
    const slowStore: BodyTextStore = {
      async scan(visit) {
        visit({ fileId: "early", stamp: "1", text: "一致する本文" });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        visit({ fileId: "late", stamp: "1", text: "一致する本文" });
        return true;
      },
      async save() {},
    };
    const updates: WorkspaceBodySearchUpdate[] = [];
    const session = new WorkspaceBodySearchSession(new WorkspaceBodyTextIndex({ store: slowStore }), {
      list: async () => [file("early", "1", "2026-01-01T00:00:00Z"), file("late", "1", "2026-01-01T00:00:00Z")],
      readText: async () => "一致",
    }, (update) => updates.push(update), { flushMs: 100 });
    const query = session.setQuery(1, "一致");
    await vi.advanceTimersByTimeAsync(150);
    expect(updates).toEqual([{ queryId: 1, reset: true, hits: [{ fileId: "early", excerpt: { before: "", match: "一致", after: "する本文" } }], removed: [], pending: 2 }]);
    await vi.advanceTimersByTimeAsync(1000);
    await query;
    expect(updates.at(-1)).toMatchObject({ reset: false, hits: [{ fileId: "late" }], pending: 0 });

    const files = Array.from({ length: 5 }, (_, n) => file(`f${n}`, "1", "2026-01-01T00:00:00Z"));
    const batched: WorkspaceBodySearchUpdate[] = [];
    const many = new WorkspaceBodySearchSession(new WorkspaceBodyTextIndex(), { list: async () => files, readText: async () => "一致する本文" }, (update) => batched.push(update), { localConcurrency: 5, flushMs: 100 });
    await many.setQuery(1, "一致");
    await vi.advanceTimersByTimeAsync(0);
    expect(batched).toHaveLength(2);
    expect(batched[1]).toMatchObject({ reset: false, pending: 0 });
    expect(batched[1].hits).toHaveLength(5);

    const closed: WorkspaceBodySearchUpdate[] = [];
    const slow = new WorkspaceBodySearchSession(new WorkspaceBodyTextIndex(), {
      list: async () => [file("x", "1", "2026-01-01T00:00:00Z")],
      readText: () => new Promise((done) => setTimeout(() => done("一致"), 50)),
    }, (update) => closed.push(update), { flushMs: 10 });
    await slow.setQuery(1, "一致");
    slow.close();
    await vi.advanceTimersByTimeAsync(500);
    expect(closed).toEqual([{ queryId: 1, reset: true, hits: [], removed: [], pending: 1 }]);
  });
});

function file(fileId: string, stamp: string, updatedAt: string, title = "題名", shared = false): BodySearchFile {
  return { fileId, stamp, updatedAt, title, shared };
}

async function storeWith(records: Record<string, { stamp: string; text: string }>): Promise<BodyTextStore> {
  const store = createMemoryBodyTextStore();
  for (const [fileId, record] of Object.entries(records)) await store.save({ fileId, stamp: record.stamp, text: toIndexedText(record.text) });
  return store;
}

async function stored(store: BodyTextStore): Promise<string[]> {
  const ids: string[] = [];
  await store.scan((record) => ids.push(record.fileId));
  return ids;
}
