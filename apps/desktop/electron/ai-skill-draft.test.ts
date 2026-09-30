import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildProblemFrameDrawingPrompt,
  buildSkillDraftPrompt,
  cancelAiSkillDraftCodexRun,
  extractProblemFrameReplyMessage,
  generateAiSkillDraft,
  parseCodexExecJsonLine,
  sanitizeProblemFrameDrawing,
  sanitizeSkillDraftText,
  type AiSkillDraftDeps,
} from "./ai-skill-draft";
import type { CodexAppServerClient } from "./codex-app-server-client";

describe("sanitizeSkillDraftText", () => {
  it("passes plain Markdown through unchanged (aside from trimming)", () => {
    const raw = "\n# 手順\n\n1. 最初にやること\n2. 次にやること\n";
    expect(sanitizeSkillDraftText(raw)).toBe("# 手順\n\n1. 最初にやること\n2. 次にやること");
  });

  it("strips a code fence wrapping the entire response", () => {
    const raw = "```markdown\n# 手順\n\n本文です。\n```";
    expect(sanitizeSkillDraftText(raw)).toBe("# 手順\n\n本文です。");
  });

  it("strips a code fence with no language tag", () => {
    const raw = "```\n本文だけ\n```";
    expect(sanitizeSkillDraftText(raw)).toBe("本文だけ");
  });

  it("strips a leading YAML frontmatter block the model added despite instructions", () => {
    const raw = ["---", 'name: "my-skill"', 'description: "説明"', "---", "", "# 手順", "", "本文。"].join("\n");
    expect(sanitizeSkillDraftText(raw)).toBe("# 手順\n\n本文。");
  });

  it("strips frontmatter even when it is also wrapped in a code fence", () => {
    const raw = ["```", "---", "name: x", "---", "", "本文。", "```"].join("\n");
    expect(sanitizeSkillDraftText(raw)).toBe("本文。");
  });

  it("does not touch a body that merely contains '---' as a horizontal rule mid-document", () => {
    const raw = "前半\n\n---\n\n後半";
    expect(sanitizeSkillDraftText(raw)).toBe(raw);
  });

  it("truncates to the max length", () => {
    const raw = "あ".repeat(50);
    expect(sanitizeSkillDraftText(raw, 10)).toBe("あ".repeat(10));
  });

  it("normalizes CRLF line endings", () => {
    const raw = "行1\r\n行2\r\n";
    expect(sanitizeSkillDraftText(raw)).toBe("行1\n行2");
  });
});

describe("buildSkillDraftPrompt", () => {
  it("includes the user request, title, and description", () => {
    const prompt = buildSkillDraftPrompt("二次関数の演習プリントの構成ルールを作って", {
      title: "二次関数プリント",
      description: "演習プリント作成時のルール",
      currentContent: "",
    });
    expect(prompt).toContain("二次関数の演習プリントの構成ルールを作って");
    expect(prompt).toContain("二次関数プリント");
    expect(prompt).toContain("演習プリント作成時のルール");
    expect(prompt).not.toContain("現在のスキルの内容");
  });

  it("includes and asks to revise the existing content when non-empty", () => {
    const prompt = buildSkillDraftPrompt("配色ルールも追加して", {
      title: "図の作図ルール",
      description: "",
      currentContent: "# 既存の内容\n\n図形は黒線のみ。",
    });
    expect(prompt).toContain("現在のスキルの内容");
    expect(prompt).toContain("# 既存の内容\n\n図形は黒線のみ。");
    expect(prompt).toContain("配色ルールも追加して");
  });

  it("instructs the model not to use tools, avoid frontmatter, and avoid wrapping fences", () => {
    const prompt = buildSkillDraftPrompt("何か作って", { title: "", description: "", currentContent: "" });
    expect(prompt).toMatch(/ツールは一切使用しないでください/);
    expect(prompt).toMatch(/frontmatter/);
    expect(prompt).toMatch(/コードフェンス/);
  });
});

describe("parseCodexExecJsonLine (reasoning)", () => {
  it("hands out a completed reasoning summary, and nothing for an empty one", () => {
    const line = JSON.stringify({ type: "item.completed", item: { id: "i", type: "reasoning", text: "**考え**" } });
    expect(parseCodexExecJsonLine(line)).toEqual({ agentMessageText: null, failureMessage: null, reasoningText: "**考え**" });
    const empty = JSON.stringify({ type: "item.completed", item: { id: "i", type: "reasoning", text: "  " } });
    expect(parseCodexExecJsonLine(empty)).toEqual({ agentMessageText: null, failureMessage: null });
  });
});

describe("parseCodexExecJsonLine", () => {
  it("returns null for blank lines and non-JSON garbage", () => {
    expect(parseCodexExecJsonLine("")).toEqual({ agentMessageText: null, failureMessage: null });
    expect(parseCodexExecJsonLine("   ")).toEqual({ agentMessageText: null, failureMessage: null });
    expect(parseCodexExecJsonLine("not json")).toEqual({ agentMessageText: null, failureMessage: null });
  });

  it("ignores thread.started/turn.started/turn.completed lines", () => {
    expect(parseCodexExecJsonLine(JSON.stringify({ type: "thread.started", thread_id: "t1" })))
      .toEqual({ agentMessageText: null, failureMessage: null });
    expect(parseCodexExecJsonLine(JSON.stringify({ type: "turn.started" })))
      .toEqual({ agentMessageText: null, failureMessage: null });
    expect(parseCodexExecJsonLine(JSON.stringify({ type: "turn.completed", usage: { output_tokens: 7 } })))
      .toEqual({ agentMessageText: null, failureMessage: null });
  });

  it("extracts the agent_message text from an item.completed line", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "agent_message", text: "面積は長方形なら縦×横です。" },
    });
    expect(parseCodexExecJsonLine(line)).toEqual({ agentMessageText: "面積は長方形なら縦×横です。", failureMessage: null });
  });

  it("extracts an error message from an item.completed error item", () => {
    const line = JSON.stringify({
      type: "item.completed",
      item: { id: "item_0", type: "error", message: "モデルのメタデータが見つかりません。" },
    });
    expect(parseCodexExecJsonLine(line)).toEqual({ agentMessageText: null, failureMessage: "モデルのメタデータが見つかりません。" });
  });

  it("unwraps the inner message of a top-level error line's JSON-encoded payload", () => {
    const inner = { type: "error", status: 400, error: { type: "invalid_request_error", message: "指定されたモデルは使用できません。" } };
    const line = JSON.stringify({ type: "error", message: JSON.stringify(inner) });
    expect(parseCodexExecJsonLine(line)).toEqual({ agentMessageText: null, failureMessage: "指定されたモデルは使用できません。" });
  });

  it("unwraps the inner message of a turn.failed line's JSON-encoded payload", () => {
    const inner = { type: "error", status: 400, error: { type: "invalid_request_error", message: "指定されたモデルは使用できません。" } };
    const line = JSON.stringify({ type: "turn.failed", error: { message: JSON.stringify(inner) } });
    expect(parseCodexExecJsonLine(line)).toEqual({ agentMessageText: null, failureMessage: "指定されたモデルは使用できません。" });
  });

  it("falls back to the raw string when a top-level error message is not JSON-encoded", () => {
    const line = JSON.stringify({ type: "error", message: "plain text failure" });
    expect(parseCodexExecJsonLine(line)).toEqual({ agentMessageText: null, failureMessage: "plain text failure" });
  });
});

describe("generateAiSkillDraft (codex provider, via a fake `codex exec --json` binary)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createFakeCodexDeps(binSource: string): { deps: AiSkillDraftDeps; codexHome: string } {
    const dir = mktempDirForTest();
    const fakeCodexBin = path.join(dir, "codex");
    const codexHome = path.join(dir, "codex-home");
    writeFileSync(fakeCodexBin, binSource, "utf8");
    chmodSync(fakeCodexBin, 0o755);
    const codex = {
      resolveCodexBinForSpawn: async () => fakeCodexBin,
      getCodexHome: () => codexHome,
    } as unknown as CodexAppServerClient;
    return {
      deps: {
        // "chatgpt" provider only touches deps.codex; these two are never called.
        claude: {} as AiSkillDraftDeps["claude"],
        geminiSkillDraft: {} as AiSkillDraftDeps["geminiSkillDraft"],
        codex,
      },
      codexHome,
    };
  }

  function mktempDirForTest(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-codex-skill-draft-"));
    tempDirs.push(dir);
    return dir;
  }

  it("streams the completed agent_message as a delta and returns it as the final text", async () => {
    const { deps } = createFakeCodexDeps(FAKE_CODEX_EXEC_BIN_SUCCESS);
    const onDelta = vi.fn();
    const result = await generateAiSkillDraft(
      { provider: "chatgpt", prompt: "面積の求め方を説明して", context: { title: "", description: "", currentContent: "" } },
      deps,
      "test-run-success",
      onDelta,
    );
    expect(onDelta).toHaveBeenCalledWith("スキル本文の下書きです。");
    expect(result).toEqual({ ok: true, text: "スキル本文の下書きです。" });
  });

  it("surfaces the unwrapped turn.failed message on failure", async () => {
    const { deps } = createFakeCodexDeps(FAKE_CODEX_EXEC_BIN_FAILURE);
    const result = await generateAiSkillDraft(
      { provider: "chatgpt", prompt: "何か作って", context: { title: "", description: "", currentContent: "" } },
      deps,
      "test-run-failure",
    );
    expect(result).toEqual({ ok: false, error: "指定されたモデルは使用できません。" });
  });

  it("streams the reasoning summary and passes the chosen effort to codex exec", async () => {
    const { deps, codexHome } = createFakeCodexDeps(FAKE_CODEX_EXEC_BIN_REASONING);
    const onReasoning = vi.fn();
    const onDelta = vi.fn();
    const result = await generateAiSkillDraft(
      {
        provider: "chatgpt",
        purpose: "problemFrame",
        prompt: "枠",
        model: "gpt-x",
        reasoningEffort: "high",
        context: { title: "", description: "", currentContent: "" },
      },
      deps,
      "test-run-reasoning",
      onDelta,
      onReasoning,
    );
    expect(result).toMatchObject({ ok: true, message: "四隅に花びらです。" });
    expect(result.ok && result.text.startsWith("<svg")).toBe(true);
    expect(onReasoning).toHaveBeenCalledWith("**四隅を考える**");
    const argv = JSON.parse(readFileSync(path.join(path.dirname(codexHome), "argv.json"), "utf8")) as string[];
    expect(argv).toEqual(expect.arrayContaining(["--model", "gpt-x", 'model_reasoning_effort="high"', 'model_reasoning_summary="auto"']));

    // Without a listener for thinking, no summary is asked for.
    await generateAiSkillDraft(
      { provider: "chatgpt", purpose: "problemFrame", prompt: "枠", context: { title: "", description: "", currentContent: "" } },
      deps,
      "test-run-no-reasoning",
    );
    const plain = JSON.parse(readFileSync(path.join(path.dirname(codexHome), "argv.json"), "utf8")) as string[];
    expect(plain.join(" ")).not.toContain("model_reasoning_summary");
  });

  it("cancelAiSkillDraftCodexRun kills the in-flight process and resolves as a user cancellation, not a generic failure", async () => {
    const { deps } = createFakeCodexDeps(FAKE_CODEX_EXEC_BIN_HANGING);
    const runId = "test-run-cancel";
    const pending = generateAiSkillDraft(
      { provider: "chatgpt", prompt: "何か作って", context: { title: "", description: "", currentContent: "" } },
      deps,
      runId,
    );
    // Give the fake process a moment to spawn and emit its opening lines before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const cancelled = cancelAiSkillDraftCodexRun(runId);
    expect(cancelled).toBe(true);
    const result = await pending;
    expect(result).toEqual({ ok: false, error: "生成を中止しました。" });
  });

  it("cancelAiSkillDraftCodexRun returns false for an unknown runId", () => {
    expect(cancelAiSkillDraftCodexRun("no-such-run")).toBe(false);
  });
});

const FAKE_CODEX_EXEC_BIN_SUCCESS = `#!/usr/bin/env node
const fs = require("node:fs");
process.stdin.resume();
const argv = process.argv;
const outIdx = argv.indexOf("--output-last-message");
const outputFile = outIdx >= 0 ? argv[outIdx + 1] : null;
const text = "スキル本文の下書きです。";
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "t1" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: {} }) + "\\n");
if (outputFile) {
  fs.writeFileSync(outputFile, text);
}
process.exit(0);
`;

const FAKE_CODEX_EXEC_BIN_REASONING = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
process.stdin.resume();
fs.writeFileSync(path.join(process.cwd(), "..", "argv.json"), JSON.stringify(process.argv.slice(2)));
const text = "四隅に花びらです。\\n<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 160 100\\"><rect x=\\"2\\" y=\\"2\\" width=\\"156\\" height=\\"96\\" fill=\\"none\\" stroke=\\"#c0a\\"/></svg>";
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "t1" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "**四隅を考える**" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.completed", usage: {} }) + "\\n");
process.exit(0);
`;

const FAKE_CODEX_EXEC_BIN_FAILURE = `#!/usr/bin/env node
process.stdin.resume();
const inner = JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "指定されたモデルは使用できません。" } });
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "t1" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "error", message: inner }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: inner } }) + "\\n");
process.exit(1);
`;

const FAKE_CODEX_EXEC_BIN_HANGING = `#!/usr/bin/env node
process.stdin.resume();
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "t1" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "turn.started" }) + "\\n");
// Hang until killed, simulating a long-running turn so the test can exercise cancellation.
setInterval(() => {}, 1000);
`;

describe("problem frame drawing (purpose: problemFrame)", () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100"><rect x="2" y="2" width="156" height="96" fill="none" stroke="#0a0"/></svg>';

  it("tells the model the canvas, where the corners end, and that edges stretch", () => {
    const prompt = buildProblemFrameDrawingPrompt("四隅に桜の花びらがある枠", "");
    expect(prompt).toContain('viewBox="0 0 160 100"');
    expect(prompt).toContain("24×24");
    expect(prompt).toContain("引き伸ばして");
    expect(prompt).toContain("四隅に桜の花びらがある枠");
    expect(prompt).not.toContain("現在の枠線");
    expect(prompt).toContain("ツールは一切使用しないでください");
  });

  it("asks to revise the current drawing when there is one", () => {
    const prompt = buildProblemFrameDrawingPrompt("もっと太く", SVG);
    expect(prompt).toContain("現在の枠線");
    expect(prompt).toContain(SVG);
    expect(prompt).toContain("もっと太く");
  });

  it("carries the earlier requests of the conversation, oldest first, when there are any", () => {
    const prompt = buildProblemFrameDrawingPrompt("もっと淡く", SVG, ["桜の枠", "角を丸く"]);
    expect(prompt).toContain("これまでのユーザーの要望");
    expect(prompt.indexOf("1. 桜の枠")).toBeLessThan(prompt.indexOf("2. 角を丸く"));
    expect(prompt).toContain("最新のユーザーの要望");
    expect(prompt.indexOf("2. 角を丸く")).toBeLessThan(prompt.indexOf("もっと淡く"));
    expect(buildProblemFrameDrawingPrompt("桜の枠", "")).not.toContain("これまでのユーザーの要望");
  });

  it("asks for a one-line note about the frame before the SVG, so the answer reads as a reply", () => {
    const prompt = buildProblemFrameDrawingPrompt("桜の枠", "");
    expect(prompt).toContain("どんな枠にしたかを日本語で1〜2文");
  });

  it("separates the note the model wrote around the SVG from the drawing itself", () => {
    expect(extractProblemFrameReplyMessage(`桜を四隅に入れました。\n\n\`\`\`svg\n${SVG}\n\`\`\`\nお使いください。`))
      .toBe("桜を四隅に入れました。\n\nお使いください。");
    expect(extractProblemFrameReplyMessage(SVG)).toBe("");
    expect(extractProblemFrameReplyMessage("申し訳ありません、描けません。")).toBe("申し訳ありません、描けません。");
  });

  it("keeps only the SVG the model wrote, in the canonical form", () => {
    const reply = `できました！\n\n\`\`\`svg\n${SVG}\n\`\`\`\nお使いください。`;
    const text = sanitizeProblemFrameDrawing(reply);
    expect(text.startsWith("<svg")).toBe(true);
    expect(text).toContain('width="160" height="100" viewBox="0 0 160 100"');
    expect(text).not.toContain("できました");
  });

  it("drops a reply that contains no usable drawing", () => {
    expect(sanitizeProblemFrameDrawing("申し訳ありません、描けません。")).toBe("");
    expect(sanitizeProblemFrameDrawing("<svg><rect/></svg>")).toBe("");
  });

  it("generates through the tool-less one-shot path and returns the drawing, not skill text", async () => {
    const runTurn = vi.fn<(turn: { instruction: string; mcpConfig: unknown }) => Promise<{ finalText: string; isError: boolean; cancelled: boolean }>>(
      async () => ({ finalText: `以下です\n${SVG}`, isError: false, cancelled: false }),
    );
    const deps = {
      claude: { runTurn, cancelRun: vi.fn() } as unknown as AiSkillDraftDeps["claude"],
      geminiSkillDraft: {} as AiSkillDraftDeps["geminiSkillDraft"],
      codex: {} as AiSkillDraftDeps["codex"],
    };
    const result = await generateAiSkillDraft(
      { provider: "claude", purpose: "problemFrame", prompt: "緑の細い枠", context: { title: "", description: "", currentContent: "" } },
      deps,
      "frame-run",
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.text.startsWith("<svg")).toBe(true);
    const call = runTurn.mock.calls[0][0];
    expect(call.instruction).toContain("枠線の絵をSVGで描く");
    expect(call.mcpConfig).toEqual({ mcpServers: {} });
  });

  it("runs the model the caller chose, and the provider default when none is given", async () => {
    const runTurn = vi.fn<(turn: { model?: string }) => Promise<{ finalText: string; isError: boolean; cancelled: boolean }>>(
      async () => ({ finalText: SVG, isError: false, cancelled: false }),
    );
    const deps = {
      claude: { runTurn, cancelRun: vi.fn() } as unknown as AiSkillDraftDeps["claude"],
      geminiSkillDraft: {} as AiSkillDraftDeps["geminiSkillDraft"],
      codex: {} as AiSkillDraftDeps["codex"],
    };
    const context = { title: "", description: "", currentContent: "" };
    await generateAiSkillDraft({ provider: "claude", purpose: "problemFrame", prompt: "枠", model: " opus ", context }, deps, "m1");
    await generateAiSkillDraft({ provider: "claude", purpose: "problemFrame", prompt: "枠", context }, deps, "m2");
    expect(runTurn.mock.calls[0][0].model).toBe("opus");
    expect("model" in runTurn.mock.calls[1][0]).toBe(false);
  });

  it("returns the note with the drawing, and streams thinking and effort only to a caller that wants thinking", async () => {
    const runTurn = vi.fn(async (turn: { onThinkingDelta?: (delta: string) => void; onDelta?: (delta: string) => void }) => {
      turn.onThinkingDelta?.("角を考えています");
      turn.onDelta?.("桜の枠です。");
      return { finalText: `桜の枠です。\n${SVG}`, isError: false, cancelled: false };
    });
    const deps = {
      claude: { runTurn, cancelRun: vi.fn() } as unknown as AiSkillDraftDeps["claude"],
      geminiSkillDraft: {} as AiSkillDraftDeps["geminiSkillDraft"],
      codex: {} as AiSkillDraftDeps["codex"],
    };
    const request = {
      provider: "claude" as const,
      purpose: "problemFrame" as const,
      prompt: "桜",
      reasoningEffort: " High ",
      context: { title: "", description: "", currentContent: "", history: ["前の要望"] },
    };
    const onDelta = vi.fn();
    const onReasoning = vi.fn();
    const result = await generateAiSkillDraft(request, deps, "think-run", onDelta, onReasoning);

    expect(result).toMatchObject({ ok: true, message: "桜の枠です。" });
    expect(onReasoning).toHaveBeenCalledWith("角を考えています");
    expect(onDelta).toHaveBeenCalledWith("桜の枠です。");
    const call = runTurn.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(call).toMatchObject({ thinkingDisplay: "summarized", reasoningEffort: "high" });
    expect(String(call.instruction)).toContain("1. 前の要望");

    await generateAiSkillDraft(request, deps, "no-think-run", onDelta);
    expect("thinkingDisplay" in (runTurn.mock.calls[1][0] as unknown as Record<string, unknown>)).toBe(false);
  });

  it("does not pass an effort that is not a plain word on to the CLI", async () => {
    const runTurn = vi.fn(async () => ({ finalText: SVG, isError: false, cancelled: false }));
    const deps = {
      claude: { runTurn, cancelRun: vi.fn() } as unknown as AiSkillDraftDeps["claude"],
      geminiSkillDraft: {} as AiSkillDraftDeps["geminiSkillDraft"],
      codex: {} as AiSkillDraftDeps["codex"],
    };
    await generateAiSkillDraft({
      provider: "claude",
      purpose: "problemFrame",
      prompt: "枠",
      reasoningEffort: "high --dangerously-skip-permissions",
      context: { title: "", description: "", currentContent: "" },
    }, deps, "bad-effort");
    expect("reasoningEffort" in (runTurn.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toBe(false);
  });

  it("runs again without thinking when the installed Claude does not know --thinking-display", async () => {
    const runTurn = vi.fn<(turn: Record<string, unknown>) => Promise<{ finalText: string; isError: boolean; cancelled: boolean }>>()
      .mockRejectedValueOnce(new Error("error: unknown option '--thinking-display'"))
      .mockResolvedValueOnce({ finalText: SVG, isError: false, cancelled: false });
    const deps = {
      claude: { runTurn, cancelRun: vi.fn() } as unknown as AiSkillDraftDeps["claude"],
      geminiSkillDraft: {} as AiSkillDraftDeps["geminiSkillDraft"],
      codex: {} as AiSkillDraftDeps["codex"],
    };
    const result = await generateAiSkillDraft(
      { provider: "claude", purpose: "problemFrame", prompt: "枠", context: { title: "", description: "", currentContent: "" } },
      deps,
      "old-cli",
      undefined,
      vi.fn(),
    );
    expect(result.ok).toBe(true);
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(runTurn.mock.calls[0][0].thinkingDisplay).toBe("summarized");
    expect("thinkingDisplay" in runTurn.mock.calls[1][0]).toBe(false);
  });

  it("asks Antigravity to stream, since its print mode shows nothing until the end", async () => {
    const runTurn = vi.fn(async () => ({ finalText: SVG, isError: false, errorMessage: null, blockedToolCount: 0 }));
    const deps = {
      claude: {} as AiSkillDraftDeps["claude"],
      geminiSkillDraft: { runTurn, cancelRun: vi.fn() } as unknown as AiSkillDraftDeps["geminiSkillDraft"],
      codex: {} as AiSkillDraftDeps["codex"],
    };
    await generateAiSkillDraft(
      { provider: "antigravity", purpose: "problemFrame", prompt: "枠", context: { title: "", description: "", currentContent: "" } },
      deps,
      "agy-run",
    );
    expect(runTurn.mock.calls[0]).toEqual([expect.objectContaining({ streamOutput: true })]);
  });

  it("leaves the skill editor's call as it was: no thinking display, no streaming mode", async () => {
    const claudeTurn = vi.fn(async () => ({ finalText: "本文", isError: false, cancelled: false }));
    const geminiTurn = vi.fn(async () => ({ finalText: "本文", isError: false, errorMessage: null, blockedToolCount: 0 }));
    const deps = {
      claude: { runTurn: claudeTurn, cancelRun: vi.fn() } as unknown as AiSkillDraftDeps["claude"],
      geminiSkillDraft: { runTurn: geminiTurn, cancelRun: vi.fn() } as unknown as AiSkillDraftDeps["geminiSkillDraft"],
      codex: {} as AiSkillDraftDeps["codex"],
    };
    const context = { title: "", description: "", currentContent: "" };
    const onReasoning = vi.fn();
    await generateAiSkillDraft({ provider: "claude", prompt: "手順", context }, deps, "skill-claude", undefined, onReasoning);
    await generateAiSkillDraft({ provider: "antigravity", prompt: "手順", context }, deps, "skill-agy", undefined, onReasoning);

    expect("thinkingDisplay" in (claudeTurn.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toBe(false);
    expect("streamOutput" in (geminiTurn.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toBe(false);
    expect(onReasoning).not.toHaveBeenCalled();
  });

  it("keeps the model's words when it answered without a drawing", async () => {
    const deps = {
      claude: {
        runTurn: vi.fn(async () => ({ finalText: "どんな色にしますか？", isError: false, cancelled: false })),
        cancelRun: vi.fn(),
      } as unknown as AiSkillDraftDeps["claude"],
      geminiSkillDraft: {} as AiSkillDraftDeps["geminiSkillDraft"],
      codex: {} as AiSkillDraftDeps["codex"],
    };
    const result = await generateAiSkillDraft(
      { provider: "claude", purpose: "problemFrame", prompt: "枠", context: { title: "", description: "", currentContent: "" } },
      deps,
      "prose-run",
    );
    expect(result).toMatchObject({ ok: false, message: "どんな色にしますか？" });
  });

  it("reports an empty response when the model never produced a drawing", async () => {
    const deps = {
      claude: {
        runTurn: vi.fn(async () => ({ finalText: "枠は描けませんでした", isError: false, cancelled: false })),
        cancelRun: vi.fn(),
      } as unknown as AiSkillDraftDeps["claude"],
      geminiSkillDraft: {} as AiSkillDraftDeps["geminiSkillDraft"],
      codex: {} as AiSkillDraftDeps["codex"],
    };
    const result = await generateAiSkillDraft(
      { provider: "claude", purpose: "problemFrame", prompt: "何か", context: { title: "", description: "", currentContent: "" } },
      deps,
      "frame-run-empty",
    );
    expect(result.ok).toBe(false);
  });
});
