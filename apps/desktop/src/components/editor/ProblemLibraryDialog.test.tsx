// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProblemLibraryDialog } from "./ProblemLibraryDialog";
import * as desktop from "@/lib/desktop-bridge";
import * as library from "@/lib/problem-library";
import { ProblemLibraryImportError, type ProblemLibrarySearchResult } from "@/lib/problem-library";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { createTranslator } from "@/lib/i18n";
import { importTexProblem } from "@/lib/tex-import";
import type { LibraryFacet, LibraryProblemSummary, MemberLibraryBridge } from "@/lib/problem-library-provider";

let root: Root;
let container: HTMLDivElement;
// `has_solution: false` keeps the default fixture a body-only import, whatever the helper does for unchecked problems.
const response = (title = "確認用の問題", extra: Record<string, unknown> = {}): ProblemLibrarySearchResult => ({ ok: true, search: { ok: true, results: [
  { id: 12, title, category: "整数", problem_tex: "$x^2$を計算せよ。", has_solution: false, ...extra },
] } });

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

function setup(search = vi.fn<(query: unknown) => Promise<ProblemLibrarySearchResult>>().mockResolvedValue(response()), onImport = vi.fn<(file: File) => Promise<boolean>>().mockResolvedValue(true)) {
  const onClose = vi.fn();
  const openExternal = vi.fn();
  const getSolution = vi.fn();
  vi.spyOn(desktop, "getDesktopBridge").mockReturnValue({ problems: { search, getSolution }, shell: { openExternal } } as unknown as ReturnType<typeof desktop.getDesktopBridge>);
  act(() => root.render(<ProblemLibraryDialog onImport={onImport} onClose={onClose} />));
  return { search, onImport, onClose, openExternal, getSolution };
}
function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(button => button.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function settle() { await act(async () => { await Promise.resolve(); }); }

describe("problem library dialog", () => {
  it("loads six recommendations on opening and imports editable SigmaDoc with its original title", async () => {
    const f = setup(); await settle();
    expect(f.search).toHaveBeenCalledWith({ sort: "likes", limit: 6 });
    expect(document.body.textContent).toContain("おすすめの問題");
    expect(document.querySelector("article")?.textContent).toContain("を計算せよ。");
    await act(async () => button("取り込む").click());
    const file = f.onImport.mock.calls[0][0];
    expect(file.name).toBe("確認用の問題.sigma");
    const doc = parseSigmaDocument(JSON.parse(await file.text()));
    expect(doc.content[0]).toMatchObject({ type: "problem", prompt: [{ children: [{ type: "mathInline", tex: "x^2" }, { text: "を計算せよ。" }] }] });
    expect(f.onClose).toHaveBeenCalledOnce();
  });
  it("keeps the dialog open after a cancelled or failed save and prevents duplicate imports", async () => {
    let resolve!: (accepted: boolean) => void;
    const onImport = vi.fn<(file: File) => Promise<boolean>>(() => new Promise<boolean>(done => { resolve = done; }));
    const f = setup(undefined, onImport); await settle();
    act(() => { button("取り込む").click(); });
    expect(button("取り込み中…").disabled).toBe(true);
    act(() => button("取り込み中…").click());
    await settle();
    expect(f.onImport).toHaveBeenCalledOnce();
    await act(async () => resolve(false));
    expect(f.onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("取り込みが完了しませんでした");
    expect(button("取り込む").disabled).toBe(false);
    // The list is still there, so an import failure offers no list reload.
    expect(Array.from(document.querySelectorAll("button")).some(item => item.textContent === "再読み込み")).toBe(false);
  });
  it("shows login/network errors and retries the same request", async () => {
    const search = vi.fn<(query: unknown) => Promise<ProblemLibrarySearchResult>>().mockResolvedValueOnce({ ok: false, error: "ログインしてください" }).mockResolvedValue(response());
    setup(search); await settle();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("ログインしてください");
    await act(async () => button("再読み込み").click());
    expect(search).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("確認用の問題");
  });
  it("does not let a slow initial recommendation overwrite a newer search", async () => {
    let resolve!: (value: ProblemLibrarySearchResult) => void;
    const search = vi.fn<(query: unknown) => Promise<ProblemLibrarySearchResult>>()
      .mockImplementationOnce(() => new Promise(done => { resolve = done; }))
      .mockResolvedValue(response("新しい検索結果"));
    setup(search);
    await act(async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(document.body.textContent).toContain("新しい検索結果");
    await act(async () => resolve(response("古いおすすめ")));
    expect(document.body.textContent).not.toContain("古いおすすめ");
    expect(document.body.textContent).toContain("新しい検索結果");
  });
  it("reports empty and malformed results without inventing example recommendations", async () => {
    const search = vi.fn<(query: unknown) => Promise<ProblemLibrarySearchResult>>()
      .mockResolvedValueOnce({ ok: true, search: { ok: true, results: [] } })
      .mockResolvedValueOnce({ ok: true, search: { ok: true, results: [{ id: 1 }] } });
    setup(search); await settle();
    expect(document.body.textContent).toContain("該当する問題がありません");
    await act(async () => button("おすすめを表示").click());
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(document.querySelector("article")).toBeNull();
  });
  it("is a generic library: the provider is quiet card metadata, apart from the problem's own origin", async () => {
    const search = vi.fn<(query: unknown) => Promise<ProblemLibrarySearchResult>>().mockResolvedValue(response("確認用の問題", { source_name: "2020年 東京大学" }));
    const f = setup(search); await settle();
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("問題ライブラリ");
    expect(document.body.textContent).not.toContain("受験数学研究所の問題");
    const card = document.querySelector("article")!;
    expect(card.textContent).toContain("2020年 東京大学");
    const link = card.querySelector("a")!;
    expect(link.textContent).toBe("受験数学研究所");
    act(() => link.click());
    expect(f.openExternal).toHaveBeenCalledWith("https://jukenmath.net/problems/12");
  });
  it("keeps the card shape with shimmer while loading", async () => {
    let resolve!: (value: ProblemLibrarySearchResult) => void;
    const search = vi.fn<(query: unknown) => Promise<ProblemLibrarySearchResult>>().mockImplementation(() => new Promise(done => { resolve = done; }));
    setup(search);
    expect(document.querySelectorAll(".ui-shimmer-surface").length).toBeGreaterThanOrEqual(6);
    expect(document.querySelector('[role="status"]')?.textContent).toBe("問題を読み込み中…");
    expect(document.querySelector("article")).toBeNull();
    await act(async () => resolve(response()));
    expect(document.querySelector(".ui-shimmer-surface")).toBeNull();
    expect(document.querySelector("article")).not.toBeNull();
  });
  it("searches as soon as a tag is chosen and returns to recommendations from the results", async () => {
    const f = setup(); await settle();
    const trigger = document.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    // The chip keeps the shared Select's name and role; the filter reads as "off" until a tag is chosen.
    expect(trigger.getAttribute("aria-label")).toBe("タグ");
    expect(trigger.parentElement?.hasAttribute("data-active")).toBe(false);
    act(() => trigger.click());
    const option = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(item => item.dataset.value === "整数")!;
    expect(option.textContent).toBe("整数");
    await act(async () => option.click());
    await settle();
    expect(f.search).toHaveBeenLastCalledWith({ category: "整数", sort: "likes", limit: 20 });
    expect(document.body.textContent).toContain("検索結果");
    expect(document.body.textContent).toContain("1件");
    expect(trigger.textContent).toBe("整数");
    expect(trigger.parentElement?.hasAttribute("data-active")).toBe(true);
    await act(async () => button("おすすめを表示").click());
    await settle();
    expect(f.search).toHaveBeenLastCalledWith({ sort: "likes", limit: 6 });
    expect(document.body.textContent).toContain("おすすめの問題");
    expect(trigger.textContent).toBe("すべてのタグ");
    expect(trigger.parentElement?.hasAttribute("data-active")).toBe(false);
  });
  it("states whether each problem has a solution and never guesses", async () => {
    const problem = (id: number, extra: Record<string, unknown>) => ({ id, title: `問題${id}`, category: "整数", problem_tex: "x", ...extra });
    const search = vi.fn<(query: unknown) => Promise<ProblemLibrarySearchResult>>().mockResolvedValue({ ok: true, search: { ok: true, results: [
      problem(1, { has_solution: true }), problem(2, { has_solution: false }), problem(3, { has_solution: null }), problem(4, {}),
    ] } });
    setup(search); await settle();
    const cards = Array.from(document.querySelectorAll("article")).map(article => article.textContent ?? "");
    expect(cards).toHaveLength(4);
    expect(cards[0]).toContain("解答付き");
    expect(cards[1]).toContain("解答なし");
    expect(cards[2]).toContain("解答未確認");
    expect(cards[3]).toContain("解答未確認");
    // Unchecked is never worded as "with" or "none".
    expect(cards[2]).not.toMatch(/解答付き|解答なし/);
    expect(cards[3]).not.toMatch(/解答付き|解答なし/);
  });
  it("waits for the solution before saving and includes it in the imported SigmaDoc", async () => {
    const f = setup(vi.fn<(query: unknown) => Promise<ProblemLibrarySearchResult>>().mockResolvedValue(response("確認用の問題", { has_solution: true })));
    await settle();
    let release!: (value: unknown) => void;
    f.getSolution.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    expect(button("取り込む").title).toContain("解答付き");
    await act(async () => button("取り込む").click());
    expect(f.getSolution).toHaveBeenCalledWith({ problemId: "12" });
    expect(f.onImport).not.toHaveBeenCalled();
    expect(button("取り込み中…").disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>('[role="combobox"]')?.disabled).toBe(true);
    act(() => button("取り込み中…").click());
    expect(f.getSolution).toHaveBeenCalledOnce();
    await act(async () => release({ ok: true, solution: {
      ok: true, problem: { id: 12 }, solutions: { official: null, author: { format: "tex", content: "結果は$x^2=4$である。" }, editorial: null },
    } }));
    expect(f.onImport).toHaveBeenCalledOnce();
    const doc = parseSigmaDocument(JSON.parse(await f.onImport.mock.calls[0][0].text()));
    expect(doc.content[0]).toMatchObject({ type: "problem", solution: expect.arrayContaining([
      expect.objectContaining({ children: expect.arrayContaining([expect.objectContaining({ type: "mathInline", tex: "x^2=4" })]) }),
    ]) });
    expect(f.onClose).toHaveBeenCalledOnce();
  });
  it("shows the helper's own message when the solution fails, keeps the card, and keeps other errors generic", async () => {
    const prepare = vi.spyOn(library, "prepareLibraryProblemImport")
      .mockRejectedValueOnce(new ProblemLibraryImportError("解答を取得できませんでした。接続を確認して、もう一度お試しください。"))
      .mockRejectedValueOnce(new Error("internal detail that must not reach the screen"));
    const f = setup(vi.fn<(query: unknown) => Promise<ProblemLibrarySearchResult>>().mockResolvedValue(response("確認用の問題", { has_solution: true })));
    await settle();
    await act(async () => button("取り込む").click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("解答を取得できませんでした");
    // Nothing is imported from the body alone, and the card stays so the user can try again.
    expect(f.onImport).not.toHaveBeenCalled();
    expect(f.onClose).not.toHaveBeenCalled();
    expect(document.querySelector("article")).not.toBeNull();
    expect(button("取り込む").disabled).toBe(false);
    await act(async () => button("取り込む").click());
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("取り込みが完了しませんでした");
    expect(document.body.textContent).not.toContain("internal detail");
    expect(f.onImport).not.toHaveBeenCalled();
  });
  it("provides English menu and dialog copy", () => {
    const en = createTranslator("en", "editor");
    expect(createTranslator("en", "chrome")("appMenu.problems")).toBe("Problems");
    expect(en("problemLibrary.recommended")).toBe("Recommended problems");
    expect(en("problemLibrary.title")).toBe("Problem library");
    expect(en("problemLibrary.sources.jukenmath")).toBe("Juken Math");
    expect(en("problemLibrary.category")).toBe("Tag");
    expect(en("problemLibrary.solutionState.available")).toBe("With solution");
    expect(en("problemLibrary.solutionState.unknown")).toBe("Solution unchecked");
    expect(en("problemLibrary.solutionLabels.official")).toBe("Official solution");
  });
});

const LABEL = "Partner Library";
const summary = (id: string, extra: Partial<LibraryProblemSummary> = {}): LibraryProblemSummary => ({
  id, title: `ライブラリ問題 ${id}`, source_label: "関西学院大", exam_year: 2019, has_solution: true, tags: ["微分法", "接線", "極値", "最大最小"],
  preview: [{ type: "paragraph", id: `p_${id}`, children: [{ type: "text", text: `ライブラリ本文 ${id}` }] }], ...extra,
});
const facet = (key: string, label: string, extra: Partial<LibraryFacet> = {}): LibraryFacet => {
  const [group, type] = key.split("|");
  return { key, group, type, label, count: 10, hasChildren: false, ...extra };
};
const UNIT = "db|単元|数学Ⅱ";
const UNIT_CHILD = "db|単元|数学Ⅱ>微分法";
const LEVEL = "db|難易度|教科書標準";

function libraryBridge(overrides: Partial<{ [K in keyof MemberLibraryBridge]: ReturnType<typeof vi.fn> }> = {}) {
  const document = parseSigmaDocument(importTexProblem({ title: "ライブラリ問題", prompt: "$f(x)=x^3$を微分せよ。", solution: "$f'(x)=3x^2$" }));
  return {
    access: vi.fn().mockResolvedValue({ available: true, label: LABEL }),
    search: vi.fn().mockResolvedValue({ ok: true, search: { total: 1, results: [summary("lib_a")], facetCounts: { [UNIT]: 1, [LEVEL]: 0 } } }),
    facets: vi.fn(async ({ parent }: { parent: string | null }) => ({ ok: true, facets: parent === null
      ? [facet(UNIT, "数学Ⅱ", { hasChildren: true }), facet(LEVEL, "教科書標準")]
      : [facet(UNIT_CHILD, "微分法")] })),
    get: vi.fn().mockResolvedValue({ ok: true, document }),
    ...overrides,
  };
}
function setupMember(library: ReturnType<typeof libraryBridge>, search = vi.fn<(query: unknown) => Promise<ProblemLibrarySearchResult>>().mockResolvedValue(response())) {
  const onClose = vi.fn();
  const onImport = vi.fn<(file: File) => Promise<boolean>>().mockResolvedValue(true);
  const getSolution = vi.fn();
  vi.spyOn(desktop, "getDesktopBridge").mockReturnValue({ problems: { search, getSolution, library }, shell: { openExternal: vi.fn() } } as unknown as ReturnType<typeof desktop.getDesktopBridge>);
  act(() => root.render(<ProblemLibraryDialog onImport={onImport} onClose={onClose} />));
  return { search, getSolution, onImport, onClose, library };
}
async function flush() {
  for (let index = 0; index < 4; index++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}
const radio = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(item => item.textContent === name)!;
const facetButton = (key: string) => document.querySelector<HTMLButtonElement>(`[data-facet-key="${key}"]`)!;
async function importedDocument(onImport: ReturnType<typeof vi.fn>) {
  return parseSigmaDocument(JSON.parse(await (onImport.mock.calls.at(-1)![0] as File).text()));
}

describe("members-only library", () => {
  it("shows no trace of the library to a non-member", async () => {
    const library = libraryBridge({ access: vi.fn().mockResolvedValue({ available: false }) });
    const f = setupMember(library); await flush();
    expect(library.access).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="radiogroup"]')).toBeNull();
    expect(document.body.textContent).not.toContain(LABEL);
    expect(library.search).not.toHaveBeenCalled();
    expect(library.facets).not.toHaveBeenCalled();
    expect(f.search).toHaveBeenCalledWith({ sort: "likes", limit: 6 });
    expect(document.querySelector('[role="combobox"]')?.getAttribute("aria-label")).toBe("タグ");
    expect(document.querySelector("[data-source]")?.textContent).not.toContain("受験数学研究所問題");
  });
  it("treats a failing access check as no library", async () => {
    const library = libraryBridge({ access: vi.fn().mockRejectedValue(new Error("offline")) });
    setupMember(library); await flush();
    expect(document.querySelector('[role="radiogroup"]')).toBeNull();
    expect(library.search).not.toHaveBeenCalled();
  });
  it("gives a member a source switch and mixes both providers with a badge on every card", async () => {
    const f = setupMember(libraryBridge()); await flush();
    const radios = Array.from(document.querySelectorAll('[role="radio"]')).map(item => item.textContent);
    expect(radios).toEqual(["すべて", "受験数学研究所", LABEL]);
    expect(radio("すべて").getAttribute("aria-checked")).toBe("true");
    expect(f.library.search).toHaveBeenCalledWith({ facets: [], limit: 6, offset: 0 });
    const cards = Array.from(document.querySelectorAll("article"));
    expect(cards.map(card => card.dataset.source)).toEqual(["jukenmath", "library"]);
    expect(cards[0].querySelector('[data-source="jukenmath"]')?.textContent).toBe("受験数学研究所");
    expect(cards[1].querySelector('[data-source="library"]')?.textContent).toBe(LABEL);
    // The library card: its preview, origin, solution state and at most three tags.
    expect(cards[1].textContent).toContain("ライブラリ本文 lib_a");
    expect(cards[1].textContent).toContain("関西学院大 2019年");
    expect(cards[1].textContent).toContain("解答付き");
    expect(cards[1].textContent).toContain("極値");
    expect(cards[1].textContent).not.toContain("最大最小");
    // In すべて the keyword goes to both providers; the tag filter belongs to 受験数学研究所 alone.
    expect(document.querySelector('[role="combobox"]')).toBeNull();
    const input = document.querySelector<HTMLInputElement>('input[type="search"], input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "微分");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await flush();
    expect(f.search).toHaveBeenLastCalledWith({ q: "微分", sort: "likes", limit: 20 });
    expect(f.library.search).toHaveBeenLastCalledWith({ q: "微分", facets: [], limit: 20, offset: 0 });
  });
  it("keeps one provider's results when the other fails, and retries only the failed one", async () => {
    const library = libraryBridge({ search: vi.fn().mockResolvedValueOnce({ ok: false, error: "問題ライブラリに接続できませんでした。" })
      .mockResolvedValue({ ok: true, search: { total: 1, results: [summary("lib_a")], facetCounts: {} } }) });
    const f = setupMember(library); await flush();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(`${LABEL}の問題を取得できませんでした。`);
    expect(Array.from(document.querySelectorAll("article")).map(card => card.dataset.source)).toEqual(["jukenmath"]);
    await act(async () => button("再読み込み").click());
    await flush();
    expect(f.search).toHaveBeenCalledOnce();
    expect(library.search).toHaveBeenCalledTimes(2);
    expect(Array.from(document.querySelectorAll("article")).map(card => card.dataset.source)).toEqual(["jukenmath", "library"]);
  });
  it("filters the library by classification: lazy tree, counts, chips, and AND-ed keys", async () => {
    const f = setupMember(libraryBridge()); await flush();
    await act(async () => radio(LABEL).click());
    await flush();
    expect(f.library.facets).toHaveBeenCalledWith({ parent: null });
    expect(f.library.search).toHaveBeenLastCalledWith({ facets: [], limit: 24, offset: 0 });
    expect(document.querySelector("article")?.dataset.source).toBe("library");
    expect(document.querySelector("h3")?.textContent).toBe(LABEL);
    // Sections follow the server's `type`; counts come from facetCounts.
    const panel = document.querySelector("nav")!;
    expect(Array.from(panel.querySelectorAll("section > button")).map(item => item.textContent)).toEqual(["単元", "難易度"]);
    expect(facetButton(UNIT).textContent).toBe("数学Ⅱ1");
    expect(facetButton(LEVEL).hasAttribute("data-empty")).toBe(true);
    await act(async () => facetButton(UNIT).click());
    await flush();
    expect(f.library.search).toHaveBeenLastCalledWith({ facets: [UNIT], limit: 24, offset: 0 });
    expect(facetButton(UNIT).getAttribute("aria-pressed")).toBe("true");
    // Children load only when opened.
    expect(f.library.facets).toHaveBeenCalledTimes(1);
    await act(async () => panel.querySelector<HTMLButtonElement>('[aria-expanded="false"][aria-label]')!.click());
    await flush();
    expect(f.library.facets).toHaveBeenLastCalledWith({ parent: UNIT });
    await act(async () => facetButton(UNIT_CHILD).click());
    await flush();
    expect(f.library.search).toHaveBeenLastCalledWith({ facets: [UNIT, UNIT_CHILD], limit: 24, offset: 0 });
    const chips = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label$="の絞り込みを外す"]'));
    expect(chips.map(chip => chip.getAttribute("aria-label"))).toEqual(["単元: 数学Ⅱの絞り込みを外す", "単元: 数学Ⅱ › 微分法の絞り込みを外す"]);
    await act(async () => chips[0].click());
    await flush();
    expect(f.library.search).toHaveBeenLastCalledWith({ facets: [UNIT_CHILD], limit: 24, offset: 0 });
    await act(async () => button("絞り込みを解除").click());
    await flush();
    expect(f.library.search).toHaveBeenLastCalledWith({ facets: [], limit: 24, offset: 0 });
    // Back in すべて the classifications are not applied, and the jukenmath tag filter stays hidden.
    await act(async () => radio("すべて").click());
    await flush();
    expect(document.querySelector("nav")).toBeNull();
  });
  it("lays the library alone out in two columns of plain cards with every preview block", async () => {
    const preview = Array.from({ length: 12 }, (_, index) => ({ type: "paragraph" as const, id: `p_${index}`, children: [{ type: "text" as const, text: `段落 ${index}` }] }));
    const library = libraryBridge({ search: vi.fn().mockResolvedValue({ ok: true, search: { total: 1, results: [summary("lib_a", { preview })], facetCounts: {} } }) });
    setupMember(library); await flush();
    expect(document.querySelector("[data-columns]")?.getAttribute("data-columns")).toBe("3");
    await act(async () => radio(LABEL).click());
    await flush();
    expect(document.querySelector("[data-columns]")?.getAttribute("data-columns")).toBe("2");
    const card = document.querySelector("article")!;
    // The heading already names the library, so the card drops its badge.
    expect(card.querySelector('[data-source="library"]')).toBeNull();
    expect(preview.every(block => card.textContent!.includes(block.children[0].text))).toBe(true);
    expect(card.textContent).toContain("ライブラリ問題 lib_a");
    expect(card.textContent).toContain("解答付き");
  });
  it("shows the total and pages the library with もっと見る", async () => {
    const page = (from: number, size: number) => Array.from({ length: size }, (_, index) => summary(`lib_${from + index}`));
    const library = libraryBridge({ search: vi.fn(async (request: { offset: number }) => ({ ok: true, search: {
      total: 30, results: request.offset === 0 ? page(0, 24) : page(24, 6), facetCounts: {},
    } })) });
    setupMember(library); await flush();
    await act(async () => radio(LABEL).click());
    await flush();
    expect(document.body.textContent).toContain("30件中 24件を表示");
    expect(document.querySelectorAll("article")).toHaveLength(24);
    await act(async () => button("もっと見る").click());
    await flush();
    expect(library.search).toHaveBeenLastCalledWith({ facets: [], limit: 24, offset: 24 });
    expect(document.querySelectorAll("article")).toHaveLength(30);
    expect(document.body.textContent).toContain("30件中 30件を表示");
    expect(Array.from(document.querySelectorAll("button")).some(item => item.textContent === "もっと見る")).toBe(false);
  });
  it("imports a library problem as a new document, with its solution by default and without it when switched off", async () => {
    const f = setupMember(libraryBridge()); await flush();
    const importLibrary = () => Array.from(document.querySelectorAll("article")).find(card => card.dataset.source === "library")!.querySelector<HTMLButtonElement>("button")!;
    expect(importLibrary().title).toBe("解答付きで新しい教材として取り込む");
    await act(async () => importLibrary().click());
    expect(f.library.get).toHaveBeenCalledWith({ id: "lib_a" });
    expect((f.onImport.mock.calls[0][0] as File).name).toBe("ライブラリ問題 lib_a.sigma");
    const withSolution = await importedDocument(f.onImport);
    expect(withSolution.content[0]).toMatchObject({ type: "problem", solution: [expect.objectContaining({ type: "paragraph" })] });
    expect(f.onClose).toHaveBeenCalledOnce();

    const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-label")).toBe("解答を含める");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(importLibrary().title).toBe("解答を含めずに新しい教材として取り込む");
    await act(async () => importLibrary().click());
    const withoutSolution = await importedDocument(f.onImport);
    expect(withoutSolution.content[0]).toMatchObject({ type: "problem", solution: [] });
    expect(withoutSolution.content[0]).toMatchObject({ prompt: withSolution.content[0].type === "problem" ? withSolution.content[0].prompt : [] });
  });
  it("leaves out a 受験数学研究所 solution without fetching it when solutions are switched off", async () => {
    const f = setupMember(libraryBridge(), vi.fn<(query: unknown) => Promise<ProblemLibrarySearchResult>>().mockResolvedValue(response("確認用の問題", { has_solution: true })));
    await flush();
    act(() => document.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    await act(async () => Array.from(document.querySelectorAll("article")).find(card => card.dataset.source === "jukenmath")!.querySelector<HTMLButtonElement>("article button")!.click());
    expect(f.getSolution).not.toHaveBeenCalled();
    expect((await importedDocument(f.onImport)).content[0]).toMatchObject({ type: "problem", solution: [] });
  });
  it("shows the main process's message when a library import fails and keeps the dialog open", async () => {
    const f = setupMember(libraryBridge({ get: vi.fn().mockResolvedValue({ ok: false, error: "教材で使うフォントを取得できませんでした。もう一度お試しください。" }) }));
    await flush();
    await act(async () => Array.from(document.querySelectorAll("article")).find(card => card.dataset.source === "library")!.querySelector<HTMLButtonElement>("button")!.click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("フォントを取得できませんでした");
    expect(f.onImport).not.toHaveBeenCalled();
    expect(f.onClose).not.toHaveBeenCalled();
  });
  it("provides English copy for the library controls", () => {
    const en = createTranslator("en", "editor");
    expect(en("problemLibrary.allSources")).toBe("All");
    expect(en("problemLibrary.includeSolution")).toBe("Include solutions");
    expect(en("problemLibrary.showing", { total: 30, shown: 24 })).toBe("Showing 24 of 30");
    expect(en("problemLibrary.libraryErrors.fontFailed")).toBe("Could not load the fonts this material uses. Please try again.");
  });
});
