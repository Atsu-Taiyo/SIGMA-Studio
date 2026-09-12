import { describe, expect, it } from "vitest";

import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { importTexDocument, isTexFilename } from "@/lib/tex-import";
import type { BoxBlockChildBlock, CodeBlockNode, SigmaBlock, InlineNode, LayoutSectionChildBlock, ProblemAreaBlock, RichBlock } from "@/types/sigma-doc";

describe("isTexFilename", () => {
  it("accepts TeX-like filenames", () => {
    expect(isTexFilename("lesson.tex")).toBe(true);
    expect(isTexFilename("lesson.LaTeX")).toBe(true);
    expect(isTexFilename("lesson.json")).toBe(false);
  });
});

describe("importTexDocument", () => {
  it("converts a TeX document into validated SigmaDoc blocks", () => {
    const document = importTexDocument(String.raw`
\documentclass{jsarticle}
\usepackage{amsmath}
\title{二次関数 $y=x^2$}
\begin{document}
\maketitle
\section{導入}
関数 $y=x^2$ を考える。成功率は100\%。

\subsection{手順}
\begin{enumerate}
\item $x=1$ を代入する。
\item \textbf{値}を求める。
\end{enumerate}

\begin{problem}[例題1]
次を解け。
\[
x^2=4
\]
\answer{$x=\pm 2$}
\begin{solution}
両辺の平方根をとる。
\end{solution}
\end{problem}
\end{document}
`, "quadratic.tex");

    const parsed = parseSigmaDocument(document);
    const problem = parsed.content.find((block) => block.type === "problem");

    expect(parsed.docId).toBe(document.docId);
    expect(parsed.metadata.title).toBe("二次関数 y=x^2");
    expect(parsed.content[0]).toMatchObject({ type: "section", title: "導入" });
    expect(parsed.content.some((block) => block.type === "heading" && block.level === 2)).toBe(true);
    expect(documentText(parsed.content)).toContain("関数 y=x^2 を考える。成功率は100%。");
    expect(parsed.content.find((block) => block.type === "list")).toMatchObject({
      type: "list",
      listType: "ordered",
      items: [
        { type: "listItem", children: [{ type: "mathInline", tex: "x=1" }, { type: "text", text: " を代入する。" }] },
        { type: "listItem", children: [{ type: "text", text: "値", marks: ["bold"] }, { type: "text", text: "を求める。" }] },
      ],
    });
    expect(problem?.type).toBe("problem");
    expect(problem?.lead[0] ? problemAreaBlockText(problem.lead[0]) : "").toBe("例題1");
    expect(problem?.answer).toEqual({ type: "math", expected: "x=\\pm 2" });
    expect(problem?.solution.map(problemAreaBlockText).join("\n")).toContain("両辺の平方根をとる。");
    expect(collectMathTex(parsed.content)).toEqual(expect.arrayContaining(["y=x^2", "x=1", "x^2=4"]));
  });

  it("strips comments while preserving escaped percent signs and display math environments", () => {
    const document = importTexDocument(String.raw`
\begin{document}
本文は残る。% このコメントは取り込まない
割合は50\%。

\begin{align}
a&=b\\
c&=d
\end{align}
\end{document}
`, "comments.tex");

    expect(documentText(document.content)).toContain("本文は残る。 割合は50%。");
    expect(documentText(document.content)).not.toContain("このコメント");
    expect(collectMathTex(document.content)).toContain(String.raw`\begin{aligned}a&=b\\ c&=d\end{aligned}`);
  });

  it("imports rulecenter-style Japanese past exam TeX with custom commands", () => {
    const document = importTexDocument(String.raw`
\documentclass{jsarticle}
\newcommand{\anaume}[1]{\framebox[40pt][c]{#1}}
\newcommand{\maru}[1]{\textcircled{\scriptsize#1}}
\begin{document}
\large
\section{垣内教授}
\noindent\rulecenter{問題3}

\noindent がん遺伝子は \anaume{ア} や \anaume{イ} の機能を担う。
\begin{itembox}[l]{キーワード}
   分裂サイクル/DNA修復/TP53
\end{itembox}
\begin{description}
  \item[\maru1]機能を述べよ。
  \item[\maru2]変異を述べよ。
\end{description}
\begin{center}
  \includegraphics[width=100mm]{528.png}
\end{center}

\\\phantom{a}\\
\noindent\ovalbox{解答}\\
\begin{description}
  \item[\anaume{ア}] \textbf{増殖シグナル伝達}
  \item[\anaume{イ}] \textbf{細胞分化}
\end{description}
\end{document}
`, "past-exam.tex");

    const problem = document.content.find((block) => block.type === "problem");
    const text = documentText(document.content);

    expect(problem?.type).toBe("problem");
    expect(problem?.lead.map(problemAreaBlockText).join("\n")).toBe("問題3");
    expect(problem?.prompt.map(problemAreaBlockText).join("\n")).toContain("がん遺伝子は ア や イ の機能を担う。");
    expect(problem?.prompt.map(problemAreaBlockText).join("\n")).toContain("【キーワード】 分裂サイクル/DNA修復/TP53");
    expect(problem?.prompt.map(problemAreaBlockText).join("\n")).toContain("① 機能を述べよ。");
    expect(problem?.prompt.map(problemAreaBlockText).join("\n")).toContain("［画像: 528.png］");
    expect(problem?.solution.map(problemAreaBlockText).join("\n")).toContain("ア 増殖シグナル伝達");
    expect(text).not.toContain("\\rulecenter");
    expect(text).not.toContain("\\ovalbox");
    expect(text).not.toContain("\\anaume");
  });

  it("expands simple user-defined macro wrappers before importing", () => {
    const document = importTexDocument(String.raw`
\documentclass{jsarticle}
\newcommand{\mondai}[1]{\rulecenter{問題#1}}
\newcommand{\blank}[1]{\anaume{#1}}
\newcommand{\strongterm}[1]{\textbf{#1}}
\newcommand{\pair}[2]{#1 と #2}
\newcommand{\course}{病理学}
\begin{document}
\mondai{24}
\noindent \strongterm{\course}では \blank{ア} と \pair{壊死}{アポトーシス} を比較する。

\ovalbox{解答}
\strongterm{細胞死}
\end{document}
`, "macro-wrapper.tex");

    const problem = document.content.find((block) => block.type === "problem");
    const promptText = problem?.type === "problem" ? problem.prompt.map(problemAreaBlockText).join("\n") : "";
    const solutionText = problem?.type === "problem" ? problem.solution.map(problemAreaBlockText).join("\n") : "";
    const text = documentText(document.content);

    expect(problem?.type).toBe("problem");
    expect(problem?.lead.map(problemAreaBlockText).join("\n")).toBe("問題24");
    expect(promptText).toContain("病理学では ア と 壊死 と アポトーシス を比較する。");
    expect(solutionText).toContain("細胞死");
    expect(text).not.toContain("\\mondai");
    expect(text).not.toContain("\\blank");
    expect(text).not.toContain("\\strongterm");
  });
});

function documentText(blocks: SigmaBlock[]): string {
  return blocks.map(blockText).join("\n");
}

function blockText(block: SigmaBlock): string {
  if (block.type === "problem") {
    return [
      ...block.lead.map(problemAreaBlockText),
      ...block.prompt.map(problemAreaBlockText),
      ...block.solution.map(problemAreaBlockText),
      ...block.hints.map(problemAreaBlockText),
    ].join("\n");
  }
  if (block.type === "section") {
    return block.title;
  }
  if (block.type === "list") {
    return richBlockText(block);
  }
  if (block.type === "layoutSection") {
    return block.children.map(layoutSectionChildText).join("\n");
  }
  if (block.type === "boxBlock") {
    return [inlineText(block.title ?? []), ...block.blocks.map(boxBlockChildText)].join("\n");
  }
  if (block.type === "divider") {
    return "";
  }
  if (block.type === "quote") {
    return block.blocks.map(layoutSectionChildText).join("\n");
  }
  return inlineText(block.children);
}

function boxBlockChildText(block: BoxBlockChildBlock): string {
  if (block.type === "problem") return [...block.lead, ...block.prompt, ...block.hints, ...block.solution].map(boxBlockChildText).join("\n");
  if (block.type === "section") {
    return block.title;
  }
  if (block.type === "layoutSection") {
    return block.children.map(layoutSectionChildText).join("\n");
  }
  if (block.type === "boxBlock") {
    return [inlineText(block.title ?? []), ...block.blocks.map(boxBlockChildText)].join("\n");
  }
  if (block.type === "divider") {
    return "";
  }
  if (block.type === "codeBlock") {
    return inlineText(block.children);
  }
  if (block.type === "quote") {
    return block.blocks.map(layoutSectionChildText).join("\n");
  }
  return richBlockText(block);
}

function layoutSectionChildText(block: LayoutSectionChildBlock): string {
  if (block.type === "section") {
    return block.title;
  }
  if (block.type === "boxBlock") {
    return [inlineText(block.title ?? []), ...block.blocks.map(boxBlockChildText)].join("\n");
  }
  if (block.type === "divider") {
    return "";
  }
  if (block.type === "codeBlock") {
    return inlineText(block.children);
  }
  if (block.type === "quote") {
    return block.blocks.map(layoutSectionChildText).join("\n");
  }
  return richBlockText(block);
}

function problemAreaBlockText(block: ProblemAreaBlock): string {
  if (block.type === "layoutSection") {
    return block.children.map(layoutSectionChildText).join("\n");
  }
  if (block.type === "boxBlock") {
    return [inlineText(block.title ?? []), ...block.blocks.map(boxBlockChildText)].join("\n");
  }
  if (block.type === "divider") {
    return "";
  }
  if (block.type === "codeBlock") {
    return inlineText(block.children);
  }
  if (block.type === "quote") {
    return block.blocks.map(layoutSectionChildText).join("\n");
  }
  return richBlockText(block);
}

function richBlockText(block: RichBlock | CodeBlockNode): string {
  if (block.type === "list") {
    return block.items.map((item) => [
      inlineText(item.children),
      ...(item.nested ?? []).map(richBlockText),
    ].filter(Boolean).join("\n")).join("\n");
  }

  return inlineText(block.children);
}

function inlineText(children: InlineNode[]): string {
  return children.map((child) => child.type === "text" ? child.text : child.tex).join("");
}

function collectMathTex(blocks: SigmaBlock[]): string[] {
  const values: string[] = [];
  const visitRichBlock = (block: RichBlock | CodeBlockNode) => {
    richBlockInlineNodes(block).forEach((child) => {
      if (child.type === "mathInline") {
        values.push(child.tex);
      }
    });
  };
  const visitBoxBlockChild = (block: BoxBlockChildBlock) => {
    if (block.type === "problem") {
      [...block.lead, ...block.prompt, ...block.hints, ...block.solution].forEach(visitBoxBlockChild);
      return;
    }
    if (block.type === "layoutSection") {
      block.children.forEach(visitLayoutSectionChild);
    } else if (block.type === "boxBlock") {
      block.title?.forEach((child) => {
        if (child.type === "mathInline") {
          values.push(child.tex);
        }
      });
      block.blocks.forEach(visitBoxBlockChild);
    } else if (block.type === "quote") {
      block.blocks.forEach(visitLayoutSectionChild);
    } else if (block.type !== "section" && block.type !== "divider") {
      visitRichBlock(block);
    }
  };
  const visitLayoutSectionChild = (block: LayoutSectionChildBlock) => {
    if (block.type === "boxBlock") {
      block.title?.forEach((child) => {
        if (child.type === "mathInline") {
          values.push(child.tex);
        }
      });
      block.blocks.forEach(visitBoxBlockChild);
    } else if (block.type === "quote") {
      block.blocks.forEach(visitLayoutSectionChild);
    } else if (block.type !== "section" && block.type !== "divider") {
      visitRichBlock(block);
    }
  };
  const visitProblemAreaBlock = (block: ProblemAreaBlock) => {
    if (block.type === "layoutSection") {
      block.children.forEach(visitLayoutSectionChild);
      return;
    }
    if (block.type === "boxBlock") {
      block.title?.forEach((child) => {
        if (child.type === "mathInline") {
          values.push(child.tex);
        }
      });
      block.blocks.forEach(visitBoxBlockChild);
      return;
    }
    if (block.type === "divider") {
      return;
    }
    if (block.type === "quote") {
      block.blocks.forEach(visitLayoutSectionChild);
      return;
    }
    visitRichBlock(block);
  };

  blocks.forEach((block) => {
    if (block.type === "problem") {
      [...block.lead, ...block.prompt, ...block.hints, ...block.solution].forEach(visitProblemAreaBlock);
      return;
    }
    if (block.type === "layoutSection") {
      block.children.forEach(visitLayoutSectionChild);
      return;
    }
    if (block.type === "boxBlock") {
      block.blocks.forEach(visitBoxBlockChild);
      return;
    }
    if (block.type === "quote") {
      block.blocks.forEach(visitLayoutSectionChild);
    } else if (block.type !== "section" && block.type !== "divider") {
      visitRichBlock(block);
    }
  });

  return values;
}

function richBlockInlineNodes(block: RichBlock | CodeBlockNode): InlineNode[] {
  if (block.type === "list") {
    return block.items.flatMap((item) => [
      ...item.children,
      ...(item.nested ?? []).flatMap(richBlockInlineNodes),
    ]);
  }

  return block.children;
}
