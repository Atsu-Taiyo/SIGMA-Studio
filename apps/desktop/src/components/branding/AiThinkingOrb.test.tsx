import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AiThinkingOrb, resolveAiThinkingOrbState } from "@/components/branding/AiThinkingOrb";

describe("AiThinkingOrb", () => {
  it("maps agent activity to a meaningful orb state", () => {
    expect(resolveAiThinkingOrbState([{ kind: "phase", phase: "reading" }])).toBe("searching");
    expect(resolveAiThinkingOrbState([{ kind: "activity", phase: "streaming", itemType: "webSearch" }])).toBe("searching");
    expect(resolveAiThinkingOrbState([{ kind: "phase", phase: "validating" }])).toBe("solving");
    expect(resolveAiThinkingOrbState([])).toBe("working");
  });

  it("renders the compact accessible canvas and supports decorative use", () => {
    const informative = renderToStaticMarkup(<AiThinkingOrb state="composing" label="編集案を作成中" />);
    const decorative = renderToStaticMarkup(<AiThinkingOrb state="working" decorative />);

    expect(informative).toContain("ai-thinking-orb");
    expect(informative).toContain('aria-label="編集案を作成中"');
    expect(informative).toContain("width:20px");
    expect(decorative).toContain('aria-hidden="true"');
  });
});
