import { describe, expect, it } from "vitest";

import { resolveAiConnectionState, resolveClaudeConnectionState, resolveGeminiConnectionState } from "@/lib/ai/ai-connection";
import type { DesktopClaudeStatus, DesktopCodexStatus, DesktopGeminiStatus } from "@/types/desktop";

function status(overrides: Partial<DesktopCodexStatus>): DesktopCodexStatus {
  return {
    available: true,
    running: false,
    loggedIn: false,
    codexHome: "",
    codexBin: "codex",
    configuredCodexBin: null,
    account: null,
    error: null,
    ...overrides,
  };
}

describe("resolveAiConnectionState", () => {
  it("reports checking when no status has loaded yet", () => {
    const state = resolveAiConnectionState(null);
    expect(state.kind).toBe("checking");
    expect(state.tone).toBe("muted");
    expect(state.accountLabel).toBeNull();
  });

  it("reports unavailable when the runtime is not available", () => {
    const state = resolveAiConnectionState(status({ available: false }));
    expect(state.kind).toBe("unavailable");
    expect(state.tone).toBe("error");
  });

  it("reports loggedOut when available but not signed in", () => {
    const state = resolveAiConnectionState(status({ available: true, loggedIn: false }));
    expect(state.kind).toBe("loggedOut");
    expect(state.accountLabel).toBeNull();
  });

  it("surfaces the account email when signed in", () => {
    const state = resolveAiConnectionState(
      status({ loggedIn: true, account: { type: "chatgpt", email: "teacher@example.com" } }),
    );
    expect(state.kind).toBe("loggedIn");
    expect(state.tone).toBe("connected");
    expect(state.accountLabel).toBe("teacher@example.com");
  });

  it("falls back to a generic account label when email is missing", () => {
    const state = resolveAiConnectionState(status({ loggedIn: true, account: { type: "chatgpt" } }));
    expect(state.accountLabel).toBe("chatgpt");
  });
});

function claudeStatus(overrides: Partial<DesktopClaudeStatus>): DesktopClaudeStatus {
  return {
    available: true,
    running: false,
    loggedIn: false,
    claudeBin: "claude",
    configuredClaudeBin: null,
    account: null,
    error: null,
    ...overrides,
  };
}

describe("resolveClaudeConnectionState", () => {
  it("reports checking when no status has loaded yet", () => {
    expect(resolveClaudeConnectionState(null).kind).toBe("checking");
  });

  it("reports unavailable when claude is not installed", () => {
    const state = resolveClaudeConnectionState(claudeStatus({ available: false }));
    expect(state.kind).toBe("unavailable");
    expect(state.tone).toBe("error");
  });

  it("reports loggedOut when available but not authenticated", () => {
    const state = resolveClaudeConnectionState(claudeStatus({ available: true, loggedIn: false }));
    expect(state.kind).toBe("loggedOut");
  });

  it("reports loggedIn (subscription) when authenticated", () => {
    const state = resolveClaudeConnectionState(claudeStatus({ loggedIn: true, account: { apiKeySource: "none" } }));
    expect(state.kind).toBe("loggedIn");
    expect(state.tone).toBe("connected");
    expect(state.accountLabel).toBe("Claudeアカウント");
  });
});

function geminiStatus(overrides: Partial<DesktopGeminiStatus>): DesktopGeminiStatus {
  return {
    available: true,
    loggedIn: false,
    geminiBin: "agy",
    configuredGeminiBin: null,
    account: null,
    error: null,
    ...overrides,
  };
}

describe("resolveGeminiConnectionState", () => {
  it("reports checking when no status has loaded yet", () => {
    const state = resolveGeminiConnectionState(null);
    expect(state.kind).toBe("checking");
    expect(state.tone).toBe("muted");
    expect(state.label).toBe("接続を確認中…");
  });

  it("reports unavailable when Antigravity CLI is not installed", () => {
    const state = resolveGeminiConnectionState(geminiStatus({ available: false }));
    expect(state.kind).toBe("unavailable");
    expect(state.tone).toBe("error");
    expect(state.label).toBe("Antigravityを利用できません");
  });

  it("reports loggedOut when available but not authenticated", () => {
    const state = resolveGeminiConnectionState(geminiStatus({ available: true, loggedIn: false }));
    expect(state.kind).toBe("loggedOut");
    expect(state.tone).toBe("muted");
    expect(state.label).toBe("未ログイン");
  });

  it("reports loggedIn when authenticated", () => {
    const state = resolveGeminiConnectionState(geminiStatus({ loggedIn: true }));
    expect(state.kind).toBe("loggedIn");
    expect(state.tone).toBe("connected");
    expect(state.label).toBe("接続済み");
    expect(state.accountLabel).toBe("Antigravityアカウント");
  });
});
