import { describe, expect, it } from "vitest";
import { importTexDocument, importTexProblem } from "./tex-import";

describe("public TeX conversion", () => {
  it("exposes the canonical full-document converter", () => {
    expect(importTexDocument(String.raw`\title{教材}\begin{document}$x^2$\end{document}`, "exam.tex"))
      .toMatchObject({ metadata: { title: "教材" }, content: [{ children: [{ tex: "x^2" }] }] });
  });

  it("converts separate problem fields with shared macros and validated SigmaDoc", () => {
    expect(importTexProblem({
      title: "計算", preamble: String.raw`\providecommand{\sq}[1]{#1^2}`,
      prompt: String.raw`$\sq{3}$を計算せよ。`, solution: "$9$", hints: "同じ数をかける。", tags: ["数と式"],
    })).toMatchObject({
      version: "2.0", metadata: { title: "計算" }, content: [{
        type: "problem", tags: ["数と式"], prompt: [{ children: [{ tex: "3^2" }, { text: "を計算せよ。" }] }],
        solution: [{ children: [{ tex: "9" }] }], hints: [{ children: [{ text: "同じ数をかける。" }] }],
      }],
    });
  });
});
