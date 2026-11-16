import { describe, expect, it } from "vitest";
import { summarizeAuthoringStyle } from "./authoring-style-summary";
import type { StyleExample } from "./authoring-style-store";

const math = (tex: string, display = false, outside = "") => [{ type: "mathInline", tex, display: display ? "display" : "inline" }, { type: "text", text: outside }];
function example(before: unknown[], after: unknown[], blockId = "a"): StyleExample {
  const fragment = (runs: unknown[]) => ({ area: "body", text: "", format: JSON.stringify({ runs }), context: "" });
  return { workspaceId: "ws", fileId: "f", blockId, title: "", revision: 2, before: fragment(before), after: fragment(after) };
}
function repeated(before: unknown[], after: unknown[]) {
  return [example(before, after), example(before, after, "b")];
}
const texSection = (examples: StyleExample[], locale: "ja" | "en" = "ja") => summarizeAuthoringStyle(examples, locale).split(locale === "ja" ? "## TeX数式の書き方" : "## TeX math notation")[1];

describe("TeX notation evidence", () => {
  it.each([
    ["fraction", math(String.raw`\frac{1}{x}`), math(String.raw`\dfrac{1}{x}`), String.raw`\dfrac`],
    ["text fraction", math(String.raw`\dfrac{1}{x}`), math(String.raw`\tfrac{1}{x}`), String.raw`\tfrac`],
    ["display flag", math("x+1"), math("x+1", true), "ディスプレイ数式"],
    ["inline flag", math("x+1", true), math("x+1"), "インライン数式"],
    ["scalable brackets", math("(x+1)"), math(String.raw`\left(x+1\right)`), "伸縮括弧"],
    ["fixed brackets", math(String.raw`\left(x+1\right)`), math("(x+1)"), "固定サイズ"],
    ["multiply", math(String.raw`a\times b`), math(String.raw`a\cdot b`), String.raw`\cdot`],
    ["unicode multiply", math(String.raw`a\cdot b`), math("a×b"), "×"],
    ["spacing", math("x+y"), math(String.raw`x\, +y`), String.raw`\,`],
    ["no spacing", math(String.raw`x\quad+y`), math("x+y"), "明示コマンドなし"],
    ["aligned", math("x=1"), math(String.raw`\begin{aligned}x&=1\end{aligned}`), "aligned"],
    ["align star", math(String.raw`\begin{aligned}x&=1\end{aligned}`), math(String.raw`\begin{align*}x&=1\end{align*}`), "align*"],
    ["vector", math(String.raw`\vec{a}`), math(String.raw`\overrightarrow{a}`), String.raw`\overrightarrow`],
    ["bold vector", math(String.raw`\mathbf{a}`), math(String.raw`\bm{a}`), String.raw`\bm`],
    ["boldsymbol", math(String.raw`\bm{a}`), math(String.raw`\boldsymbol{a}`), String.raw`\boldsymbol`],
    ["differential", math(String.raw`\int f(x) dx`), math(String.raw`\int f(x) \,\mathrm{d}x`), String.raw`\mathrm{d}`],
    ["italic differential", math(String.raw`\int f(x) \mathrm{d}x`), math(String.raw`\int f(x) dx`), "微分記号は`d`"],
    ["units", math("5kg"), math(String.raw`5\,\mathrm{kg}`), "直立体"],
    ["plain units", math(String.raw`5\mathrm{cm}`), math("5cm"), "通常の文字"],
    ["punctuation inside", math("x=1", false, "。"), math("x=1。"), "数式の中"],
    ["punctuation outside", math("x=1,"), math("x=1", false, ","), "数式の外"],
    ["display delimiters", [{ type: "text", text: "$x+1$" }], [{ type: "text", text: String.raw`\[x+1\]` }], "ディスプレイ数式"],
    ["double dollars", [{ type: "text", text: "$x+1$" }], [{ type: "text", text: "$$x+1$$" }], "ディスプレイ数式"],
    ["equation", math("x=1"), [{ type: "text", text: String.raw`\begin{equation}x=1\end{equation}` }], "ディスプレイ数式"],
  ])("requires independent notation-only edits for %s", (_name, before, after, expected) => {
    expect(texSection(repeated(before, after))).toContain(expected);
    expect(texSection([example(before, after)])).not.toContain("- ");
    expect(texSection(repeated(after, after))).not.toContain("- ");
    expect(texSection([example(before, after), example(before, after)])).not.toContain("- ");
  });

  it.each([String.raw`x=2`, String.raw`\dfrac{2}{x}`, String.raw`\frac{2}{x}`, String.raw`\partial x`])("does not turn mathematical corrections into preferences: %s", corrected => {
    expect(texSection(repeated(math(String.raw`\frac{1}{x}`), math(corrected)))).not.toContain("- ");
  });

  it("ignores additions, removals, malformed/oversized projections and unchanged AI formulas", () => {
    const unchanged = math(String.raw`\dfrac{1}{x}`);
    for (const e of [
      example([], unchanged), example(unchanged, []),
      example([...unchanged, { type: "text", text: "old" }], [...unchanged, { type: "text", text: "new" }]),
      { ...example([], unchanged), before: null },
      { ...example([], unchanged), before: { area: "body", text: "$x$", format: "{", context: "" } },
      example(math("x"), math("x".repeat(1801))),
    ]) expect(texSection([e, { ...e, blockId: "b" }])).not.toContain("- ");
  });

  it("matches formulas after reordering without learning an inserted formula", () => {
    const examples = repeated([...math("y=2"), ...math(String.raw`\frac{1}{x}`)], [...math(String.raw`\dfrac{1}{x}`), ...math("z=3", true), ...math("y=2")]);
    expect(texSection(examples)).toContain(String.raw`\dfrac`);
    expect(texSection(examples)).not.toContain("ディスプレイ数式");
  });

  it("keeps partial derivatives distinct and ambiguous repeated formulas unlearned", () => {
    expect(texSection(repeated(math(String.raw`\frac{d f}{d x}`), math(String.raw`\frac{\partial f}{\partial x}`)))).not.toContain("- ");
    expect(texSection(repeated([...math("x"), ...math("x")], [...math("x", true), ...math("x")]))).not.toContain("- ");
  });

  it("bounds a dense set of observations without cutting a Markdown line", () => {
    const examples: StyleExample[] = [];
    const commands = ["\\,", "\\:", "\\;", "\\quad ", "\\qquad ", "\\!"];
    for (let bits = 1; bits <= 63; bits++) {
      const space = commands.filter((_, i) => bits & (1 << i)).join("");
      for (let location = 0; location < 2; location++) examples.push(example(math("x+1"), math("x" + space + "+1"), bits + ":" + location));
    }
    const summary = summarizeAuthoringStyle(examples);
    expect(summary.length).toBeLessThanOrEqual(3000);
    expect(summary).toContain("## TeX数式の書き方\n- 空き");
    expect(summary).toMatch(/箇所）\n$/u);
  });

  it("renders an English section and respects the note size limit", () => {
    const summary = summarizeAuthoringStyle(repeated(math(String.raw`\frac{1}{x}`), math(String.raw`\dfrac{1}{x}`)), "en");
    expect(summary).toContain("## TeX math notation\n- Fractions: repeated edits favor `\\dfrac`.");
    expect(summary).toContain("2 independent edits");
    expect(summary.length).toBeLessThanOrEqual(3000);
    expect(summary).not.toContain("{1}{x}");
  });
});
