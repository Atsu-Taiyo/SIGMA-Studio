import { describe, expect, it } from "vitest";

import { createTranslator } from "@/lib/i18n";
import { parseTexPreamble } from "@/lib/tex-preamble";

describe("parseTexPreamble", () => {
  it("parses multiline file-scoped macro declarations", () => {
    const result = parseTexPreamble(String.raw`
      % 解答欄
      \newcommand{\answerbox}[1]{
        \doubleboxed{\mathstrut\quad\raisebox{-0.04em}{\text{#1}}\quad}
      }
      \providecommand{\vect}[1]{\boldsymbol{#1}}
    `);

    expect(result.issues).toEqual([]);
    expect(result.macros.answerbox).toEqual({
      args: 1,
      def: String.raw`
        \doubleboxed{\mathstrut\quad\raisebox{-0.04em}{\text{#1}}\quad}
      `,
    });
    expect(result.macros.vect).toEqual({ args: 1, def: String.raw`\boldsymbol{#1}` });
  });

  it("reports unsupported preamble commands with their line", () => {
    const result = parseTexPreamble("% first\n\\usepackage{amsmath}");
    expect(result.issues).toEqual([{
      line: 2,
      message: "パッケージamsmathにはまだ対応していません。\\usepackage[d]{esvect}だけを読み込めます。",
    }]);
  });

  it("loads esvect option d (the default) and reports other packages and options", () => {
    expect(parseTexPreamble(String.raw`\usepackage[d]{esvect}`).issues).toEqual([]);
    expect(parseTexPreamble("\\usepackage{esvect}\n\\newcommand{\\AB}{\\vv{AB}}")).toEqual({
      issues: [],
      macros: { AB: { args: 0, def: String.raw`\vv{AB}` } },
    });
    expect(parseTexPreamble(String.raw`\usepackage[a]{esvect}`).issues).toEqual([{
      line: 1,
      message: "esvectのオプションaの矢印にはまだ対応していません。標準の矢印で表示します。",
    }]);
    expect(parseTexPreamble(String.raw`\usepackage[d]{esvect,physics}`).issues.map((issue) => issue.message))
      .toEqual(["パッケージphysicsにはまだ対応していません。\\usepackage[d]{esvect}だけを読み込めます。"]);
    expect(parseTexPreamble(String.raw`\usepackage[d]`).issues[0]?.message).toBe("この行はTeXコマンドの定義として読み取れません。");
  });

  it("requires renewcommand to follow an existing file definition", () => {
    const result = parseTexPreamble(String.raw`\renewcommand{\answerbox}[1]{#1}`);
    expect(result.issues[0]?.message).toContain("まだ定義されていません");
  });

  it("reports user-facing validation errors in English when requested", () => {
    const result = parseTexPreamble(
      "% first\n\\usepackage{amsmath}",
      createTranslator("en", "tex"),
    );
    expect(result.issues).toEqual([{
      line: 2,
      message: "The amsmath package isn't supported yet. Only \\usepackage[d]{esvect} can be loaded.",
    }]);
  });
});
