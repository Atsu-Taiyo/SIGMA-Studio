import { describe, expect, it } from "vitest";

import { stripWrappingMarkdownCodeFence } from "./code-fence";

describe("stripWrappingMarkdownCodeFence", () => {
  it("leaves ordinary JavaScript code unchanged", () => {
    const code = "const a = 1;\nconsole.log(a);";
    expect(stripWrappingMarkdownCodeFence(code)).toBe(code);
    expect(stripWrappingMarkdownCodeFence(code).startsWith("```")).toBe(false);
  });

  it("drops only an outer markdown fence and keeps the inner body", () => {
    expect(stripWrappingMarkdownCodeFence("```js\nconst a = 1;\n```")).toBe("const a = 1;");
    expect(stripWrappingMarkdownCodeFence("~~~\nhello\n~~~")).toBe("hello");
  });

  it("keeps a fence that appears inside the body", () => {
    const code = "const fence = \"```\";\nreturn fence;";
    expect(stripWrappingMarkdownCodeFence(code)).toBe(code);

    expect(stripWrappingMarkdownCodeFence("```\nconst fence = \"```\";\n```")).toBe("const fence = \"```\";");
  });

  it("does not strip a one-line backtick run that is not a wrapping fence", () => {
    expect(stripWrappingMarkdownCodeFence("```code```")).toBe("```code```");
  });

  it("drops a leading opening fence even when there is no closing fence", () => {
    expect(stripWrappingMarkdownCodeFence("```asdasda\nasdasdasdsaadasdasdas")).toBe(
      "asdasda\nasdasdasdsaadasdasdas",
    );
    expect(stripWrappingMarkdownCodeFence("```\nasdasda")).toBe("asdasda");
    expect(stripWrappingMarkdownCodeFence("```asdasda")).toBe("```asdasda");
  });
});
