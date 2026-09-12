import { describe, expect, it } from "vitest";

import { resolveAiEditProvider } from "./ai-edit-provider";

describe("resolveAiEditProvider", () => {
  it("resolves an explicit gemini provider", () => {
    expect(resolveAiEditProvider({ provider: "antigravity" })).toBe("antigravity");
  });

  it("resolves an explicit claude provider", () => {
    expect(resolveAiEditProvider({ provider: "claude" })).toBe("claude");
  });

  it("falls back to chatgpt for an unknown provider", () => {
    expect(resolveAiEditProvider({ provider: "unknown" })).toBe("chatgpt");
  });

  it("falls back to chatgpt when provider is missing", () => {
    expect(resolveAiEditProvider({})).toBe("chatgpt");
  });

  it("falls back to chatgpt for non-object payloads", () => {
    expect(resolveAiEditProvider(null)).toBe("chatgpt");
    expect(resolveAiEditProvider(undefined)).toBe("chatgpt");
    expect(resolveAiEditProvider("antigravity")).toBe("chatgpt");
  });
});
