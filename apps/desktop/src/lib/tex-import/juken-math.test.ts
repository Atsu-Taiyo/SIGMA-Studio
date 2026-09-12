import { describe, expect, it } from "vitest";
import { importTexDocument, importTexProblem, texToInlineNodes } from "../tex-import";
import { parseSigmaDocument } from "../sigma-doc-schema";

// Original examples matching https://jukenmath.net/submit, checked 2026-09-10.
describe("entrance-exam TeX import", () => {
  it("shares declared macros across prompt and explanation without mixing problem areas", () => {
    const document = importTexProblem({
      title: "二次関数", tags: ["数と式", "数と式"],
      prompt: String.raw`\providecommand{\sq}[2]{#1^2}
実数$x$に対し
\[f(x)=\sq{x}{unused}+1\]
とおく。
\begin{enumerate}[label=(\arabic*), start=2]
\item $f(1)$を求めよ。
\item 最小値を求めよ。
\end{enumerate}`,
      solution: String.raw`\begin{aligned}f(1)&=2\\f(x)&\geq 1\end{aligned} よって$\sq{0}{unused}+1=1$。`,
      hints: "平方の符号を考える。",
    });
    const restored = parseSigmaDocument(JSON.parse(JSON.stringify(document)));
    expect(restored).toEqual(document);
    expect(restored.content).toMatchObject([{
      type: "problem", tags: ["数と式"],
      prompt: [
        { type: "paragraph", children: [{ text: "実数" }, { tex: "x" }, { text: "に対し" }] },
        { type: "paragraph", align: "center", children: [{ tex: "f(x)=x^2+1" }] },
        { type: "paragraph", children: [{ text: "とおく。" }] },
        { type: "list", markerStyle: "paren", start: 2, items: [{}, {}] },
      ],
      solution: [{ type: "paragraph", children: [{ tex: String.raw`\begin{aligned}f(1)&=2\\f(x)&\geq 1\end{aligned}` }] }, {}],
      hints: [{ children: [{ text: "平方の符号を考える。" }] }],
    }]);
    expect(JSON.stringify(restored.content)).not.toContain("unused");
    expect(JSON.stringify(restored.content)).not.toContain("providecommand");
  });

  it("keeps numeric explicit labels as markers, including gaps and nested lists", () => {
    const document = importTexDocument(String.raw`\begin{enumerate}
\item[(3)] 最初
\begin{enumerate}[label={(\arabic*)}]
\item 内側
\end{enumerate}
\item[(4)] 次
\item[(7)] 飛び番号
\end{enumerate}`);
    expect(document.content).toMatchObject([
      { type: "list", start: 3, markerStyle: "paren", items: [
        { children: [{ text: "最初" }], nested: [{ markerStyle: "paren", items: [{ children: [{ text: "内側" }] }] }] },
        { children: [{ text: "次" }] },
      ] },
      { type: "list", start: 7, markerStyle: "paren", items: [{ children: [{ text: "飛び番号" }] }] },
    ]);
  });

  it("keeps paragraphs and display equations under the same item number", () => {
    const document = importTexDocument(String.raw`\begin{enumerate}[label=(\arabic*)]
\item 計算せよ。
\[x^2+1\]
理由も述べよ。

必要なら図を用いてよい。
\item 次の問い。
\end{enumerate}`);
    expect(document.content).toMatchObject([{ type: "list", items: [
      { children: [{ text: "計算せよ。" }], continuations: [
        { align: "center", children: [{ tex: "x^2+1" }] },
        { children: [{ text: "理由も述べよ。" }] },
        { children: [{ text: "必要なら図を用いてよい。" }] },
      ] },
      { children: [{ text: "次の問い。" }] },
    ] }]);
  });

  it("preserves cases and matrix environments as math", () => {
    const doc = importTexDocument(String.raw`\begin{cases}x&x>0\\-x&x\leq0\end{cases}
\begin{pmatrix}1&2\\3&4\end{pmatrix}`);
    expect(doc.content).toMatchObject([
      { align: "center", children: [{ tex: String.raw`\begin{cases}x&x>0\\-x&x\leq0\end{cases}` }] },
      { align: "center", children: [{ tex: String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}` }] },
    ]);
  });

  it("preserves unsupported diagrams and tables as editable source", () => {
    const tikz = String.raw`\begin{tikzpicture}[scale=2]
\draw (0,0) -- (1,1);
\node at (1,1) {$A$};
\end{tikzpicture}`;
    const table = String.raw`\begin{tabular}{cc}a&b\\c&d\end{tabular}`;
    const doc = importTexProblem({ title: "図形", prompt: `図を考える。\n${tikz}`, solution: table });
    expect(doc.content).toMatchObject([{
      prompt: [{ type: "paragraph" }, { type: "codeBlock", language: "latex", children: [{ type: "text", text: tikz }] }],
      solution: [{ type: "codeBlock", children: [{ text: table }] }],
    }]);
  });

  it("does not read problem markers or item commands inside math as document structure", () => {
    const doc = importTexDocument(String.raw`\begin{problem}
$\text{\solution{文字}}$ を考える。
\begin{enumerate}\item $\text{\item}$ を読む。\end{enumerate}
\answer{$x=1$ または $x=2$}
\end{problem}`);
    expect(doc.content).toMatchObject([{
      prompt: [{ children: [{ tex: String.raw`\text{\solution{文字}}` }, { text: " を考える。" }] },
        { type: "list", items: [{ children: [{ tex: String.raw`\text{\item}` }, { text: " を読む。" }] }] }],
      solution: [], answer: { type: "text", expected: "x=1 または x=2" },
    }]);
  });

  it("preserves explanation order across command and environment forms", () => {
    const doc = importTexDocument(String.raw`\begin{problem}問題。
\solution{まず変形する。}
\begin{solution}次に計算する。\end{solution}
\solution{最後に確認する。}
\end{problem}`);
    expect(doc.content).toMatchObject([{ solution: [
      { children: [{ text: "まず変形する。" }] },
      { children: [{ text: "次に計算する。" }] },
      { children: [{ text: "最後に確認する。" }] },
    ] }]);
  });

  it("preserves boxing around text and inline math", () => {
    let id = 0;
    const nodes = texToInlineNodes(String.raw`\fbox{答え $x+1$}`, () => String(++id));
    expect(nodes).toMatchObject([{ text: "答え ", marks: ["boxed"] }, { tex: "x+1", marks: ["boxed"] }]);
  });

  it("keeps explicit line breaks while folding source newlines", () => {
    const doc = importTexDocument("一行目\\\\二行目\n続き");
    expect(doc.content).toMatchObject([{ children: [{ text: "一行目\n二行目 続き" }] }]);
  });

  it("does not center a paragraph consisting only of inline math", () => {
    expect(importTexDocument("$x$").content[0]).not.toHaveProperty("align", "center");
  });

  it("accepts package declarations in problem fragments and preserves answer-box contents", () => {
    const doc = importTexProblem({ title: "穴埋め", prompt: String.raw`\usepackage{enumitem,setspace}
\setstretch{1.2}
\newcommand{\anbox}[1]{\fbox{\rule{0pt}{0.8em}\rule{1em}{0pt}#1}}
答えは\anbox{ア}である。` });
    expect(doc.content).toMatchObject([{ prompt: [{ children: [
      { text: "答えは" }, { text: "ア", marks: ["boxed"] }, { text: "である。" },
    ] }] }]);
  });

  it("keeps nested lists inside an itembox", () => {
    expect(importTexDocument(String.raw`\begin{itembox}{条件}\begin{enumerate}\item 条件A\end{enumerate}\end{itembox}`).content)
      .toMatchObject([{ children: [{ text: "【条件】" }] }, { type: "list", items: [{ children: [{ text: "条件A" }] }] }]);
  });

  it("does not extract commands inside an unsupported environment into solution areas", () => {
    const source = String.raw`\begin{tikzpicture}\node {\solution{図中の文字}};\end{tikzpicture}`;
    expect(importTexDocument(`\\begin{problem}${source}\\end{problem}`).content)
      .toMatchObject([{ prompt: [{ type: "codeBlock", children: [{ text: source }] }], solution: [] }]);
  });

  it("allocates distinct document identities for separate conversions", () => {
    expect(importTexDocument("本文").docId).not.toBe(importTexDocument("本文").docId);
  });

  it("does not leak macros between imports", () => {
    importTexProblem({ title: "先", prompt: String.raw`\newcommand{\local}{1}$\local$` });
    expect(importTexProblem({ title: "後", prompt: String.raw`$\local$` }).content).toMatchObject([
      { prompt: [{ children: [{ tex: String.raw`\local` }] }] },
    ]);
  });

  it("rejects an empty prompt even when there is an explanation", () => {
    expect(() => importTexProblem({ title: "空", prompt: "% comment", solution: "解答" })).toThrow("本文");
  });
});

describe("macro preprocessing", () => {
  it("removes declarations in body fragments without expanding their definition names", () => {
    const doc = importTexDocument(String.raw`\newcommand{\R}{\mathbb{R}}
\providecommand{\R}{wrong}
\providecommand{\pair}[2]{#2+#1}
$x\in\R$, $\pair{1}{2}$`);
    expect(doc.content).toMatchObject([{ children: [{ tex: String.raw`x\in\mathbb{R}` }, { text: ", " }, { tex: "2+1" }] }]);
  });

  it("preserves TeX control-word boundaries during substitution and expansion", () => {
    const doc = importTexDocument(String.raw`\newcommand{\identity}[1]{#1}
\newcommand{\suffix}[1]{#1x}
$\identity{\alpha}x$, $\suffix{\beta}$`);
    expect(doc.content).toMatchObject([{ children: [{ tex: String.raw`\alpha x` }, {}, { tex: String.raw`\beta x` }] }]);
  });

  it("treats an invocation star as an argument token", () => {
    expect(importTexDocument(String.raw`\newcommand{\identity}[1]{#1}$\identity*$`).content)
      .toMatchObject([{ children: [{ tex: "*" }] }]);
  });

  it("supports defaults, nested arguments, and unused declared arguments", () => {
    const doc = importTexDocument(String.raw`\newcommand{\select}[3][x]{#1+#3}
$\select{unused}{{a+b}}$, $\select[y]{unused}{z}$`);
    expect(doc.content).toMatchObject([{ children: [{ tex: "x+{a+b}" }, {}, { tex: "y+z" }] }]);
  });

  it("ignores escaped command starts", () => {
    const doc = importTexDocument(String.raw`\newcommand{\foo}{replaced}
$\\foo$`);
    expect(doc.content).toMatchObject([{ children: [{ tex: String.raw`\\foo` }] }]);
  });

  it.each([
    String.raw`\newcommand{\loop}{\loop}$\loop$`,
    String.raw`\newcommand{\a}{\b}\newcommand{\b}{\a}$\a$`,
    String.raw`\newcommand{\double}[1]{#1#1}` + "$" + String.raw`\double{`.repeat(23) + "x" + "}".repeat(23) + "$",
  ])("rejects recursive or excessive expansion without returning a partial document", (source) => {
    expect(() => importTexDocument(source)).toThrow("上限");
  });

  it.each([String.raw`\newcommand{\bad}[10]{#1}本文`, String.raw`\newcommand{\bad}[x]{#1}本文`, String.raw`\newcommand{\bad}[1]{#1}本文\bad`])("rejects malformed declarations and missing arguments", (source) => {
    expect(() => importTexDocument(source)).toThrow(/マクロ|引数/);
  });
});
