import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OpenAiMark, renderModelMark } from "./provider-logos";

describe("provider logos", () => {
  it("keeps the OpenAI Blossom monochrome instead of applying the retired green tint", () => {
    const html = renderToStaticMarkup(<OpenAiMark />);

    expect(html).toContain('fill="currentColor"');
    expect(html).not.toContain("#10A37F");
  });

  it("uses the model company's mark for mixed Antigravity catalogs", () => {
    const gemini = renderToStaticMarkup(renderModelMark("Gemini 3.5 Flash (High)", "antigravity"));
    const claude = renderToStaticMarkup(renderModelMark("Claude Sonnet 4.6 (Thinking)", "antigravity"));
    const openAi = renderToStaticMarkup(renderModelMark("GPT-OSS 120B (Medium)", "antigravity"));

    expect(gemini).toContain("sigma-gemini-mark-gradient");
    expect(claude).toContain("#D97757");
    expect(openAi).toContain('fill="currentColor"');
  });
});
