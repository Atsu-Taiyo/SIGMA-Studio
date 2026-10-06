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
