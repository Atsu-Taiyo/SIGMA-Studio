import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AiConnectionGate, ClaudeConnectionGate, GeminiConnectionGate } from "./AiConnectionGate";
import type { AiConnection, ClaudeConnection, GeminiConnection } from "@/lib/ai/ai-connection";

function geminiConnection(overrides: Partial<GeminiConnection> = {}): GeminiConnection {
  return {
    status: null,
    state: { kind: "checking", tone: "muted", label: "接続を確認中…", accountLabel: null },
    loading: false,
    refresh: () => {},
    ...overrides,
  };
}

function claudeConnection(overrides: Partial<ClaudeConnection> = {}): ClaudeConnection {
  return {
    status: null,
    state: { kind: "checking", tone: "muted", label: "接続を確認中…", accountLabel: null },
    loading: false,
    refresh: () => {},
    ...overrides,
  };
}

function chatgptConnection(overrides: Partial<AiConnection> = {}): AiConnection {
  return {
    status: null,
    state: { kind: "checking", tone: "muted", label: "接続を確認中…", accountLabel: null },
    loading: false,
    busy: false,
    pendingLogin: false,
    error: null,
    login: async () => {},
    logout: async () => {},
    refresh: () => {},
    ...overrides,
  };
}

describe("AiConnectionGate", () => {
  it("explains how to fix a Codex CLI path that is visible only in the terminal", () => {
    const html = renderToStaticMarkup(
      <AiConnectionGate
        connection={chatgptConnection({
          state: { kind: "unavailable", tone: "error", label: "AIを利用できません", accountLabel: null },
        })}
      />,
    );

    expect(html).toContain("Codex CLI が見つかりません");
    expect(html).toContain("which codex");
    expect(html).toContain("Codex CLI");
    expect(html).toContain("再確認");
  });
});

describe("ClaudeConnectionGate", () => {
  it("renders the unavailable state with path setup steps and no API-key mention", () => {
    const html = renderToStaticMarkup(
      <ClaudeConnectionGate
        connection={claudeConnection({
          state: { kind: "unavailable", tone: "error", label: "Claudeを利用できません", accountLabel: null },
        })}
      />,
    );
    expect(html).toContain("Claude Code が見つかりません");
    expect(html).toContain("which claude");
    expect(html).toContain("Claude」タブ");
    expect(html).toContain("Claude Codeを導入");
    expect(html).not.toMatch(/API\s*key|APIキー/i);
  });
});

describe("GeminiConnectionGate", () => {
  it("renders the checking state", () => {
    const html = renderToStaticMarkup(<GeminiConnectionGate connection={geminiConnection({ loading: true })} />);
    expect(html).toContain("接続を確認しています");
  });

  it("renders the unavailable state with an install-page action and no API-key mention", () => {
    const html = renderToStaticMarkup(
      <GeminiConnectionGate
        connection={geminiConnection({
          state: { kind: "unavailable", tone: "error", label: "Antigravityを利用できません", accountLabel: null },
        })}
      />,
    );
    expect(html).toContain("Antigravity CLI が見つかりません");
    expect(html).toContain("which agy");
    expect(html).toContain("Antigravity」タブ");
    expect(html).toContain("Antigravity CLIを導入");
    expect(html).not.toMatch(/API\s*key|APIキー/i);
  });

  it("renders the loggedOut state with terminal login steps mentioning the agy command and no API-key mention", () => {
    const html = renderToStaticMarkup(
      <GeminiConnectionGate
        connection={geminiConnection({
          state: { kind: "loggedOut", tone: "muted", label: "未ログイン", accountLabel: null },
        })}
      />,
    );
    expect(html).toContain("agy");
    expect(html).toContain("Google OAuth");
    expect(html).toContain("再確認");
    expect(html).not.toMatch(/API\s*key|APIキー/i);
  });

  it("renders the loggedIn state", () => {
    const html = renderToStaticMarkup(
      <GeminiConnectionGate
        connection={geminiConnection({
          state: { kind: "loggedIn", tone: "connected", label: "接続済み", accountLabel: "Antigravityアカウント" },
        })}
      />,
    );
    expect(html).not.toContain("接続を確認しています");
    expect(html).not.toContain("見つかりません");
  });
});
