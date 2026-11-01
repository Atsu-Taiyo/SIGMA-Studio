import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { importTexProblem } from "@/lib/tex-import";
import { ApplicationFontStore } from "./application-font-store";
import { fetchLibraryAccess, fetchLibraryFacets, fetchLibraryProblem, fetchLibrarySearch, type ProblemLibraryFontStore } from "./problem-library-client";

const TOKEN = "synthetic-user-token-0123456789";
const connection = { config: { authUrl: "https://project.example" }, authorization: async () => `Bearer ${TOKEN}` };
const BASE = "https://project.example/functions/v1/problem-library/";
const ID = "lib_0123456789abcdef01234567";

const problem = (id = ID) => ({
  id, title: "微分の問題", source_label: "2019年 大学", exam_year: 2019, has_solution: true, tags: ["微分法"],
  preview: [{ type: "paragraph", id: "p1", children: [{ type: "text", text: "次の関数を微分せよ。" }] }],
});
const searchBody = { total: 1, results: [problem()], facetCounts: { "db|単元|数学Ⅱ": 1 } };

// A font is only stored when its bytes really hash to the resource id; a TrueType header keeps it a font.
const FONT = Uint8Array.from([0, 1, 0, 0, ...Array.from({ length: 60 }, (_, index) => index)]);
const FONT_ID = createHash("sha256").update(FONT).digest("hex");
function documentWithFonts(references: unknown = [{ family: "LibraryFace", resourceId: FONT_ID }]) {
  const document = importTexProblem({ title: "微分の問題", prompt: "$f(x)=x^2$を微分せよ。", solution: "$f'(x)=2x$" });
  return { ...document, pageLayout: { overlay: { overlaySnapshot: { version: 1, shapes: [], assets: {}, extensions: { "sigma.font-references": references } } } } };
}
function memoryFontStore(existing: string[] = []) {
  const stored = new Map<string, Uint8Array>();
  const store: ProblemLibraryFontStore = {
    ensure: vi.fn(async (resourceId: string, download: () => Promise<Uint8Array>) => {
      if (existing.includes(resourceId) || stored.has(resourceId)) return;
      stored.set(resourceId, await download());
    }),
  };
  return { store, stored };
}
const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);

describe("decoded library response credentials", () => {
  const encoded = (body: unknown) => new Response(
    JSON.stringify(body).replaceAll(TOKEN, Array.from(TOKEN, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")),
    { headers: { "content-type": "application/json" } },
  );
  const unsafe = { ok: false, error: "問題ライブラリの応答を安全に処理できませんでした。" };

  it("keeps an encoded credential out of the access label", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(encoded({ available: true, label: TOKEN }));
    expect(await fetchLibraryAccess(connection, fetcher)).toEqual({ available: false });
  });
  it.each([
    { ...searchBody, results: [{ ...problem(), title: TOKEN }] },
    { ...searchBody, results: [{ ...problem(), preview: [{ type: "paragraph", id: "p1", children: [{ type: "text", text: TOKEN }] }] }] },
    { ...searchBody, facetCounts: { [`db|単元|${TOKEN}`]: 1 } },
  ])("rejects an encoded credential in a search value or dictionary key", async body => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(encoded(body));
    expect(await fetchLibrarySearch({}, connection, fetcher)).toEqual(unsafe);
  });
  it("rejects an encoded credential in facets", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(encoded({ facets: [{
      key: "db|単元|微分", group: "db", type: "単元", label: TOKEN, count: 1, hasChildren: false,
    }] }));
    expect(await fetchLibraryFacets({ parent: null }, connection, fetcher)).toEqual(unsafe);
  });
  it("rejects an encoded credential in a document before touching fonts", async () => {
    const document = documentWithFonts();
    document.metadata.title = TOKEN;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(encoded(document));
    const { store } = memoryFontStore();
    expect(await fetchLibraryProblem({ id: ID }, connection, store, fetcher)).toEqual(unsafe);
    expect(store.ensure).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe("library access", () => {
  it("asks the fixed route with the user's bearer token and returns the server's label", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ available: true, label: "Partner Library" }));
    expect(await fetchLibraryAccess(connection, fetcher)).toEqual({ available: true, label: "Partner Library" });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`${BASE}access`);
    expect(init).toMatchObject({ method: "GET", headers: { Authorization: `Bearer ${TOKEN}` }, redirect: "error", cache: "no-store" });
  });
  it.each([
    ["a non-member", json({ available: false })],
    ["a signed-out user", new Response("unauthorized", { status: 401 })],
    ["a forbidden user", new Response("forbidden", { status: 403 })],
    ["a library without a name", json({ available: true })],
    ["a malformed answer", json({ available: "yes" })],
    ["a non-JSON answer", new Response("<html>", { headers: { "content-type": "text/html" } })],
  ])("treats %s as unavailable and drops any label", async (_name, response) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    expect(await fetchLibraryAccess(connection, fetcher)).toEqual({ available: false });
  });
  it("does not call the network without a session or with an unsafe project URL", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await fetchLibraryAccess({ ...connection, authorization: async () => { throw new Error("AUTH_REQUIRED"); } }, fetcher)).toEqual({ available: false });
    expect(await fetchLibraryAccess(null, fetcher)).toEqual({ available: false });
    for (const authUrl of ["http://project.example", "https://user:pw@project.example", "https://project.example/rest", "https://project.example/?a=1"]) {
      expect(await fetchLibraryAccess({ ...connection, config: { authUrl } }, fetcher)).toEqual({ available: false });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("library search", () => {
  it("posts validated JSON without a query string and returns the parsed page", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(searchBody));
    const result = await fetchLibrarySearch({ q: "微分", facets: ["db|単元|数学Ⅱ>微分法"], limit: 24, offset: 24 }, connection, fetcher);
    expect(result).toEqual({ ok: true, search: { ...searchBody, results: [{ ...problem() }] } });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`${BASE}search`);
    expect(new URL(String(url)).search).toBe("");
    expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` } });
    expect(JSON.parse(String(init?.body))).toEqual({ q: "微分", facets: ["db|単元|数学Ⅱ>微分法"], limit: 24, offset: 24 });
  });
  it.each([
    { q: "x".repeat(201) }, { q: "a\nb" }, { facets: Array.from({ length: 21 }, (_, index) => `g|t|${index}`) }, { facets: ["no-pipes"] },
    { facets: [""] }, { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { offset: -1 }, { offset: 10_001 }, { url: "https://evil.example" }, "q",
  ])("rejects %j before the network", async (input) => {
    const fetcher = vi.fn<typeof fetch>();
    const result = await fetchLibrarySearch(input, connection, fetcher);
    expect(result).toEqual({ ok: false, error: "検索条件が不正です。" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    [400, "検索条件が不正です。"], [401, "問題ライブラリを使うにはSigma Studioにログインしてください。"], [403, "この問題ライブラリを利用する権限がありません。"],
    [404, "問題が見つかりません。"], [429, "利用が集中しています。時間を置いて再試行してください。"], [500, "問題ライブラリでエラーが発生しました。時間を置いて再試行してください。"],
  ])("turns status %s into a fixed message without the body", async (status, message) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(`private detail ${TOKEN}`, { status }));
    const result = await fetchLibrarySearch({}, connection, fetcher);
    expect(result).toEqual({ ok: false, error: message });
    expect(JSON.stringify(result)).not.toMatch(/private detail|synthetic-user-token/);
  });
  it("refuses a response that echoes the token, malformed rows, and network errors", async () => {
    const echo = vi.fn<typeof fetch>().mockResolvedValue(json({ ...searchBody, results: [{ ...problem(), title: TOKEN }] }));
    expect(await fetchLibrarySearch({}, connection, echo)).toEqual({ ok: false, error: "問題ライブラリの応答を安全に処理できませんでした。" });
    for (const body of [{ total: 1 }, { ...searchBody, results: [{ ...problem("../../x") }] }, { ...searchBody, results: [{ ...problem(), preview: [{ type: "script" }] }] }, { ...searchBody, total: -1 }]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(body));
      expect(await fetchLibrarySearch({}, connection, fetcher)).toEqual({ ok: false, error: "問題ライブラリの応答を読み取れませんでした。" });
    }
    const offline = vi.fn<typeof fetch>().mockRejectedValue(new Error(`socket closed ${TOKEN}`));
    const result = await fetchLibrarySearch({}, connection, offline);
    expect(result).toEqual({ ok: false, error: "問題ライブラリに接続できませんでした。接続を確認してください。" });
  });
  it("keeps the first of duplicated ids and defaults missing tags and counts", async () => {
    const untagged: Partial<ReturnType<typeof problem>> = problem();
    delete untagged.tags;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ total: 2, results: [untagged, { ...problem(), title: "重複" }] }));
    const result = await fetchLibrarySearch({}, connection, fetcher);
    expect(result.ok && result.search).toMatchObject({ total: 2, facetCounts: {}, results: [{ id: ID, title: "微分の問題", tags: [] }] });
    expect(result.ok && result.search.results).toHaveLength(1);
  });
});

describe("library facets", () => {
  it("requests one level of the tree", async () => {
    const facet = { key: "db|単元|数学Ⅱ", group: "db", type: "単元", label: "数学Ⅱ", count: 3, hasChildren: true };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ facets: [facet] }));
    expect(await fetchLibraryFacets({ parent: null }, connection, fetcher)).toEqual({ ok: true, facets: [facet] });
    expect(fetcher.mock.calls[0][0]).toBe(`${BASE}facets`);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ parent: null });
  });
  it("rejects a parent that is not a facet key before the network", async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const input of [{}, { parent: 3 }, { parent: "plain" }, { parent: "a|b|c", extra: 1 }]) {
      expect((await fetchLibraryFacets(input, connection, fetcher)).ok).toBe(false);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("library problem", () => {
  it("fetches the document, stores a missing font after checking its hash, and returns validated SigmaDoc", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => String(url).endsWith(`fonts/${FONT_ID}`)
      ? new Response(FONT, { headers: { "content-type": "font/ttf" } })
      : json(documentWithFonts()));
    const { store, stored } = memoryFontStore();
    const result = await fetchLibraryProblem({ id: ID }, connection, store, fetcher);
    expect(result.ok).toBe(true);
    expect(result.ok && result.document.content[0]).toMatchObject({ type: "problem" });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([`${BASE}problems/${ID}`, `${BASE}fonts/${FONT_ID}`]);
    expect(store.ensure).toHaveBeenCalledWith(FONT_ID, expect.any(Function));
    expect(Uint8Array.from(stored.get(FONT_ID)!)).toEqual(FONT);
  });
  it("writes the verified font into the application font store the documents read from", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "library-fonts-"));
    try {
      const store = new ApplicationFontStore(directory);
      const fetcher = vi.fn<typeof fetch>(async (url) => String(url).includes("/fonts/") ? new Response(FONT) : json(documentWithFonts()));
      expect((await fetchLibraryProblem({ id: ID }, connection, store, fetcher)).ok).toBe(true);
      expect(Uint8Array.from((await store.read(FONT_ID))!)).toEqual(FONT);
      // A second import finds it there and downloads nothing.
      expect((await fetchLibraryProblem({ id: ID }, connection, store, fetcher)).ok).toBe(true);
      expect(fetcher.mock.calls.filter(([url]) => String(url).includes("/fonts/"))).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("does not download a font the store already has", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(documentWithFonts()));
    const { store } = memoryFontStore([FONT_ID]);
    expect((await fetchLibraryProblem({ id: ID }, connection, store, fetcher)).ok).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("fails the import when a font's bytes do not match its id or cannot be downloaded", async () => {
    for (const fontResponse of [new Response(Uint8Array.from([0, 1, 0, 0, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9])), new Response("gone", { status: 404 })]) {
      const fetcher = vi.fn<typeof fetch>(async (url) => String(url).includes("/fonts/") ? fontResponse : json(documentWithFonts()));
      const { store, stored } = memoryFontStore();
      expect(await fetchLibraryProblem({ id: ID }, connection, store, fetcher)).toEqual({ ok: false, error: "教材で使うフォントを取得できませんでした。もう一度お試しください。" });
      expect(stored.size).toBe(0);
    }
  });
  it("rejects documents that are not SigmaDoc or that hide font references the reader would drop", async () => {
    for (const body of [{ content: "nope" }, documentWithFonts([{ family: "x", resourceId: "../font" }])]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(body));
      expect(await fetchLibraryProblem({ id: ID }, connection, memoryFontStore().store, fetcher)).toEqual({ ok: false, error: "問題ライブラリの応答を読み取れませんでした。" });
    }
  });
  it("rejects ids that could leave the fixed route before the network", async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const id of ["../access", "ABC", "a/b", "", "x".repeat(65), 12]) {
      expect((await fetchLibraryProblem({ id }, connection, memoryFontStore().store, fetcher)).ok).toBe(false);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
