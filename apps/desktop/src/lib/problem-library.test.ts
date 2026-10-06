import { describe, expect, it, vi } from "vitest";
import { readLibraryProblems, problemToSigmaDocument, problemSourceUrl, prepareLibraryProblemImport, ProblemLibraryImportError, type ProblemLibraryBridge } from "./problem-library";
import { parseSigmaDocument } from "./sigma-doc-schema";

const problem = { id: 123, title: "二次関数の最小値", category: "数と式", tags: ["最大・最小"], source_name: "出題元の名前", problem_tex: String.raw`実数$x$に対し、\[f(x)=x^2+1\]とする。
\begin{enumerate}\item $f(0)$を求めよ。\item 最小値を求めよ。\end{enumerate}` };

describe("problem library", () => {
  it("validates upstream data, drops unrelated fields and deduplicates ids", () => {
    expect(readLibraryProblems({ ok: true, results: [{ ...problem, private: "discard" }, problem] })).toEqual([{ ...problem, id: "123" }]);
    expect(readLibraryProblems({ ok: true, results: [] })).toEqual([]);
  });
  it.each([
    { ...problem, id: "../admin" }, { ...problem, id: "https://invalid" }, { ...problem, id: -1 },
    { ...problem, problem_tex: "" }, { ...problem, title: null }, { ...problem, problem_tex: 42 },
  ])("rejects malformed problem data before conversion", (invalid) => {
    expect(() => readLibraryProblems({ ok: true, results: [invalid] })).toThrow();
  });
  it("retains math, subquestions, title, category and provenance after SigmaDoc serialization", () => {
    const [source] = readLibraryProblems({ ok: true, results: [problem] });
    const doc = problemToSigmaDocument(source);
    const restored = parseSigmaDocument(JSON.parse(JSON.stringify(doc)));
    expect(restored).toEqual(doc);
    expect(restored.metadata.title).toBe(problem.title);
    expect(JSON.stringify(restored.content)).toContain(problem.source_name);
    expect(restored.content).toMatchObject([{
      type: "problem", tags: ["数と式", "最大・最小"],
      lead: [{ children: [{ text: problem.title }] }, { children: [{ text: expect.stringContaining(problemSourceUrl(source)) }] }],
      prompt: [
        { children: [{ text: "実数" }, { type: "mathInline", tex: "x" }, { text: "に対し、" }] },
        { align: "center", children: [{ tex: "f(x)=x^2+1" }] },
        { children: [{ text: "とする。" }] },
        { type: "list", items: [{ children: [{ tex: "f(0)" }, { text: "を求めよ。" }] }, { children: [{ text: "最小値を求めよ。" }] }] },
      ],
      solution: [], hints: [],
    }]);
    expect(problemToSigmaDocument(source).docId).not.toBe(doc.docId);
  });
  it("keeps missing categories optional and refuses empty TeX bodies", () => {
    const [source] = readLibraryProblems({ ok: true, results: [{ ...problem, category: null }] });
    expect(problemToSigmaDocument(source).content[0]).toMatchObject({ tags: ["最大・最小"] });
    expect(() => problemToSigmaDocument({ ...source, problem_tex: "% only a comment" })).toThrow();
  });

  it("preserves all supplied solution variants as editable math in the saved solution area", async () => {
    const [source] = readLibraryProblems({ ok: true, results: [{ ...problem, has_solution: true }] });
    const getSolution = vi.fn<ProblemLibraryBridge["getSolution"]>().mockResolvedValue({ ok: true, solution: {
      ok: true, problem: { id: 123 }, solutions: {
        official: { format: "tex", content: String.raw`最小値は$x^2+1=1$である。` },
        author: { format: "tex", content: String.raw`別解として$x=0$を代入する。` },
        editorial: null,
      },
    } });
    const doc = await prepareLibraryProblemImport(source, { search: vi.fn(), getSolution });
    expect(getSolution).toHaveBeenCalledWith({ problemId: "123" });
    const restored = parseSigmaDocument(JSON.parse(JSON.stringify(doc)));
    const block = restored.content[0];
    expect(block.type).toBe("problem");
    if (block.type !== "problem") throw new Error("Expected a problem");
    expect(JSON.stringify(block.solution)).toContain('"tex":"x^2+1=1"');
    expect(JSON.stringify(block.solution)).toContain('"tex":"x=0"');
    expect(JSON.stringify(block.solution)).toContain("公式解答");
    expect(JSON.stringify(block.solution)).toContain("投稿者の解答");
    expect(JSON.stringify(block.prompt)).not.toContain("別解として");
    const ids: string[] = [];
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if ("id" in value && typeof value.id === "string") ids.push(value.id);
      Object.values(value).forEach(visit);
    };
    visit(restored.content);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("skips answer retrieval only when the result explicitly has no solution", async () => {
    const [source] = readLibraryProblems({ ok: true, results: [{ ...problem, has_solution: false }] });
    const getSolution = vi.fn<ProblemLibraryBridge["getSolution"]>();
    expect((await prepareLibraryProblemImport(source, { search: vi.fn(), getSolution })).content[0]).toMatchObject({ solution: [] });
    expect(getSolution).not.toHaveBeenCalled();
  });

  it("checks unknown availability and allows a validated response with no solutions", async () => {
    const [source] = readLibraryProblems({ ok: true, results: [problem] });
    const getSolution = vi.fn<ProblemLibraryBridge["getSolution"]>().mockResolvedValue({ ok: true, solution: {
      ok: true, problem: { id: "123" }, solutions: { official: null, author: null, editorial: null },
    } });
    expect((await prepareLibraryProblemImport(source, { search: vi.fn(), getSolution })).content[0]).toMatchObject({ solution: [] });
    expect(getSolution).toHaveBeenCalledOnce();
    getSolution.mockResolvedValue({ ok: true, solution: { ok: true, problem: { id: 123 }, solutions: {} } });
    await expect(prepareLibraryProblemImport(source, { search: vi.fn(), getSolution })).rejects.toBeInstanceOf(ProblemLibraryImportError);
  });

  it.each([
    { ok: true, problem: { id: "other" }, solutions: { official: null, editorial: null, author: { format: "tex", content: "$x=1$" } } },
    { ok: true, problem: { id: 123 }, solutions: { official: null, author: null, editorial: null } },
    { ok: false, problem: { id: 123 }, solutions: {} },
    { ok: true, problem: { id: 123 }, solutions: { official: null, editorial: null, author: { format: "html", content: "<p>not TeX</p>" } } },
    { ok: true, problem: { id: 123 }, solutions: { official: null, editorial: null, author: { format: "tex", content: "% comment only" } } },
    { ok: true, problem: { id: 123 }, solutions: { official: null, editorial: null, author: { format: "tex", content: "" } } },
  ])("refuses incomplete, mismatched or unsupported solutions without a prompt-only fallback", async solution => {
    const [source] = readLibraryProblems({ ok: true, results: [{ ...problem, has_solution: true }] });
    const bridge = { search: vi.fn(), getSolution: vi.fn<ProblemLibraryBridge["getSolution"]>().mockResolvedValue({ ok: true, solution }) };
    await expect(prepareLibraryProblemImport(source, bridge)).rejects.toBeInstanceOf(ProblemLibraryImportError);
  });

  it("identifies an old preload that supports search but cannot retrieve solutions", async () => {
    const [source] = readLibraryProblems({ ok: true, results: [{ ...problem, has_solution: true }] });
    const oldBridge = { search: vi.fn() } as unknown as ProblemLibraryBridge;
    await expect(prepareLibraryProblemImport(source, oldBridge)).rejects.toThrow("アプリの再起動が必要です");
    expect(oldBridge.search).not.toHaveBeenCalled();
  });

  it("keeps missing bridges and failed requests out of the save path and does not expose raw errors", async () => {
    const [source] = readLibraryProblems({ ok: true, results: [{ ...problem, has_solution: true }] });
    const bridge = { search: vi.fn(), getSolution: vi.fn<ProblemLibraryBridge["getSolution"]>() };
    await expect(prepareLibraryProblemImport(source, undefined)).rejects.toBeInstanceOf(ProblemLibraryImportError);
    bridge.getSolution.mockResolvedValue({ ok: false, error: "private transport details" });
    await expect(prepareLibraryProblemImport(source, bridge)).rejects.not.toThrow("private transport details");
    bridge.getSolution.mockRejectedValue(new Error("private transport details"));
    await expect(prepareLibraryProblemImport(source, bridge)).rejects.toBeInstanceOf(ProblemLibraryImportError);
  });
});
