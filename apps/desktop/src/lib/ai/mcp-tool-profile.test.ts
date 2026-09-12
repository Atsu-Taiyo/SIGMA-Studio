import { describe, expect, it } from "vitest";
import { createTranslator } from "@/lib/i18n";
import { buildMcpEditInvariantGuidance, buildMcpEditPrompt, buildMcpEditTurnPrompt } from "./mcp-edit-prompt";
import { APP_BODY_TOOL_ROUTES, appMcpToolNames } from "./mcp-tool-profile";
import { buildSigmaStudioMcpEnv } from "../../../electron/sigma-studio-mcp-launch";

describe("app MCP prompts and launch contract", () => {
  it.each(["chatgpt", "claude", "antigravity"] as const)("launches %s with the app tool profile", (provider) => {
    const env = buildSigmaStudioMcpEnv({
      provider, uiLocale: "en", execPath: "/electron", scriptPath: "/server.cjs",
      userDataDir: "/data", runContextFile: `/data/${provider}.run-context.json`, renderBridgeFile: "/data/render.json",
    });
    expect(env.SIGMA_STUDIO_MCP_TOOL_PROFILE).toBe("app");
    expect(env.SIGMA_STUDIO_MCP_PROVIDER).toBe(provider);
    expect(env.SIGMA_STUDIO_RUN_CONTEXT_FILE).toBe(`/data/${provider}.run-context.json`);
  });

  it.each(["ja", "en"] as const)("uses current tool names and schemas in first and resumed %s prompts", (locale) => {
    const t = createTranslator(locale, "prompt");
    for (const provider of ["codex", "claude", "antigravity"] as const) {
      for (const isResumedTurn of [false, true]) {
        const prompt = buildMcpEditPrompt({
          provider, locale, isResumedTurn, toolProfile: "app", fileId: "file_1", runId: "run_1", instruction: "Fix the paragraph.",
        });
        for (const name of appMcpToolNames(Object.keys(APP_BODY_TOOL_ROUTES))) expect(prompt).toContain(name);
        for (const name of Object.keys(APP_BODY_TOOL_ROUTES)) expect(prompt).not.toContain(name);
        expect(prompt).toContain("edit:{action,...}");
        expect(prompt).toContain(t("documentLanguagePolicy"));
        if (!isResumedTurn) {
          expect(prompt).toContain(t("mcp.appContentToolGuide"));
          expect(prompt).toContain(t("mcp.appMarkdownBoundary"));
          expect(prompt).toContain("replace_structure");
        }
      }
    }
    const invariants = buildMcpEditInvariantGuidance(t, "app");
    expect(invariants).toContain("source");
    expect(invariants).toContain("verification");
    expect(invariants).toContain("expectedRevision");
    for (const name of Object.keys(APP_BODY_TOOL_ROUTES)) expect(invariants).not.toContain(name);
    // Existing external callers retain their original guidance and vocabulary.
    expect(buildMcpEditInvariantGuidance(t)).toContain("insert_body_content");
  });

  it("preserves literal tool names inside user instructions and selected text", () => {
    const instruction = "Explain the literal string apply_edits and do not replace it.";
    const referenceText = "insert_body_content / update_rich_content";
    const prompt = buildMcpEditTurnPrompt("codex", { toolProfile: "app", fileId: "file_1", instruction, referenceText });
    expect(prompt).toContain(instruction);
    expect(prompt).toContain(referenceText);
  });

  it("does not rewrite identifiers that happen to match legacy tool names", () => {
    const t = createTranslator("ja", "prompt");
    const prompt = buildMcpEditTurnPrompt("codex", {
      toolProfile: "app", fileId: "insert_body_content", runId: "apply_edits", instruction: "Fix the paragraph.",
    });
    expect(prompt).toContain(t("turn.appRunId", { replace: { runId: "apply_edits" } }));
    expect(prompt).toContain(t("turn.fileId", { replace: { fileId: "insert_body_content" } }));
  });
});
