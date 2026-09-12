import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSkillDraftPrompt,
  cancelAiSkillDraftCodexRun,
  generateAiSkillDraft,
  parseCodexExecJsonLine,
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
