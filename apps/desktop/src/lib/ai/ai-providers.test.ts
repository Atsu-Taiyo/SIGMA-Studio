import { describe, expect, it } from "vitest";

import { aiProviderLabel, toAiResourceProvider } from "./ai-providers";
import { setAppLocale } from "@/lib/i18n";

describe("aiProviderLabel", () => {
  it("maps every supported provider and never falls back to a blank label", () => {
    setAppLocale("ja");
    expect(aiProviderLabel("chatgpt")).toBe("ChatGPT");
    expect(aiProviderLabel("claude")).toBe("Claude");
    expect(aiProviderLabel("antigravity")).toBe("Antigravity");
    expect(aiProviderLabel("future-provider")).toBe("不明なプロバイダ (future-provider)");
    expect(aiProviderLabel(null)).toBe("不明なプロバイダ");
  });

  it("resolves unknown provider labels at operation time", () => {
    setAppLocale("en");
    expect(aiProviderLabel("future-provider")).toBe("Unknown provider (future-provider)");
    expect(aiProviderLabel(null)).toBe("Unknown provider");
    setAppLocale("ja");
  });
});

describe("toAiResourceProvider", () => {
  it("maps claude and gemini straight through", () => {
    expect(toAiResourceProvider("claude")).toBe("claude");
    expect(toAiResourceProvider("antigravity")).toBe("antigravity");
  });

  it("maps chatgpt to the codex resource-store key", () => {
    expect(toAiResourceProvider("chatgpt")).toBe("codex");
  });
});
