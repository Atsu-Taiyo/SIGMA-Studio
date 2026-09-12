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
      message: "\\usepackageにはまだ対応していません。\\newcommand、\\renewcommand、\\providecommandを使用してください。",
    }]);
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
      message: "\\usepackage isn't supported yet. Use \\newcommand, \\renewcommand, or \\providecommand.",
    }]);
  });
});
