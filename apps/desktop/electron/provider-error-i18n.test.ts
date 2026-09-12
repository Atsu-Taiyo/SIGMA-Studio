import { afterEach, describe, expect, it } from "vitest";

import { setAppLocale } from "@/lib/i18n";
import { buildCancelledMcpEditRunResult } from "./ai-edit-shared";
import { assertUsableCliBinPath } from "./cli-spawn";
import { GeminiResumeUnavailableError } from "./gemini-headless-client";

describe("provider error i18n", () => {
  afterEach(() => {
    setAppLocale("ja");
  });

  it("resolves provider and CLI errors in the locale active at operation time", () => {
    setAppLocale("en");
    expect(new GeminiResumeUnavailableError().message).toBe("Could not resume the Gemini session.");
    expect(assertUsableCliBinPath("agy", "darwin")).toEqual({
      ok: false,
      reason: "Specify an absolute CLI path.",
    });

    setAppLocale("ja");
    expect(new GeminiResumeUnavailableError().message).toBe("Geminiセッションを再開できませんでした。");
  });

  it("localizes the app-generated cancellation state", () => {
    setAppLocale("en");
    const result = buildCancelledMcpEditRunResult({
      nextDocument: { docId: "doc_1" } as never,
      agentThreadId: undefined,
      runtime: "codex-mcp",
    });
    expect(result.draft.summary).toBe("Cancelled by the user.");
  });
});
