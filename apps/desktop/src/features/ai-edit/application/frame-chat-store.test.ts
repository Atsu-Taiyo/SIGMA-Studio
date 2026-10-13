// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DesktopAiSkillDraftEvent, DesktopAiSkillDraftRequest, DesktopAiSkillDraftResult } from "@/types/desktop";

import { frameChatStore, type FrameChatSendRequest } from "./frame-chat-store";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100"><rect x="2" y="2" width="156" height="96" fill="none" stroke="#c0a"/></svg>';
const KEY = "doc\u0000p1";

interface Run {
  request: DesktopAiSkillDraftRequest;
  runId: string;
  emit: (event: DesktopAiSkillDraftEvent) => void;
  finish: (result: DesktopAiSkillDraftResult) => void;
  fail: (error: Error) => void;
}

function installBridge() {
  const runs: Run[] = [];
  const cancel = vi.fn(async () => ({ ok: true, cancelled: true }));
  const generate = vi.fn((
    request: DesktopAiSkillDraftRequest,
    onEvent?: (event: DesktopAiSkillDraftEvent) => void,
    onRunId?: (runId: string) => void,
  ) => new Promise<DesktopAiSkillDraftResult>((resolve, reject) => {
    const runId = `run-${runs.length + 1}`;
    onRunId?.(runId);
    runs.push({ request, runId, emit: (event) => onEvent?.(event), finish: resolve, fail: reject });
  }));
  (window as { desktopAPI?: unknown }).desktopAPI = { aiSkillDraft: { generate, cancel } };
  return { runs, generate, cancel };
}

function request(patch: Partial<FrameChatSendRequest> = {}): FrameChatSendRequest {
  return {
    key: KEY,
    documentIdentityKey: "doc",
    target: { kind: "problem", id: "p1" },
    instruction: "淡いピンクの枠",
    provider: "claude",
    baseSvg: "",
    ...patch,
  };
}

const session = () => frameChatStore.getSession(KEY)!;
const lastAssistant = () => {
  const turn = session().turns.at(-1)!;
  if (turn.role !== "assistant") throw new Error("not an assistant turn");
  return turn;
};

beforeEach(() => frameChatStore.resetForTests());
afterEach(() => {
  delete (window as { desktopAPI?: unknown }).desktopAPI;
});

describe("frameChatStore", () => {
  it("streams thinking and the reply into the running turn, then settles it with the drawing", async () => {
    const { runs } = installBridge();
    expect(frameChatStore.send(request({ model: "sonnet", reasoningEffort: "high" }))).toEqual({ ok: true });

    expect(runs[0].request).toMatchObject({
      provider: "claude",
      purpose: "frameDrawing",
      frameTarget: "problem",
      prompt: "淡いピンクの枠",
      model: "sonnet",
      reasoningEffort: "high",
      context: { currentContent: "", history: [] },
    });
    expect(session().runId).toBe("run-1");
    expect(session().turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(lastAssistant().status).toBe("running");

    runs[0].emit({ kind: "reasoning", text: "角は " });
    runs[0].emit({ kind: "reasoning", text: "小さく" });
    runs[0].emit({ kind: "delta", text: "淡いピンクの枠です。\n<svg" });
    expect(lastAssistant()).toMatchObject({ reasoningText: "角は 小さく", streamText: "淡いピンクの枠です。\n<svg" });
    expect(lastAssistant().replyStartedAt).not.toBeNull();

    runs[0].finish({ ok: true, text: SVG, message: "淡いピンクの枠です。" });
    await vi.waitFor(() => expect(lastAssistant().status).toBe("done"));
    expect(lastAssistant()).toMatchObject({ message: "淡いピンクの枠です。", streamText: "", error: null, revised: false });
    expect(lastAssistant().drawing).toMatchObject({ width: 160, height: 100 });
    expect(lastAssistant().drawing?.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(session().runId).toBeNull();
  });

  it("hands a drawing that finishes while someone is watching to them, and shows no notice", async () => {
    const { runs } = installBridge();
    const watcher = vi.fn();
    const unwatch = frameChatStore.watch(KEY, watcher);
    frameChatStore.send(request({ baseSvg: SVG }));
    runs[0].finish({ ok: true, text: SVG });
    await vi.waitFor(() => expect(watcher).toHaveBeenCalledTimes(1));

    expect(watcher.mock.calls[0][0]).toMatchObject({ width: 160, height: 100 });
    expect(watcher.mock.calls[0][1]).toMatchObject({ revised: true, status: "done" });
    expect(session().appliedTurnId).toBe(lastAssistant().id);
    expect(frameChatStore.getNotices()).toEqual([]);
    unwatch();
  });

  it("keeps running after the last watcher is gone, and leaves a notice with the drawing", async () => {
    const { runs } = installBridge();
    const watcher = vi.fn();
    const unwatch = frameChatStore.watch(KEY, watcher);
    frameChatStore.send(request());
    unwatch(); // the dialog is closed
    runs[0].finish({ ok: true, text: SVG, message: "できました。" });
    await vi.waitFor(() => expect(lastAssistant().status).toBe("done"));

    expect(watcher).not.toHaveBeenCalled();
    expect(session().appliedTurnId).toBeNull();
    expect(frameChatStore.getNotices()).toEqual([
      expect.objectContaining({
        id: lastAssistant().id,
        key: KEY,
        documentIdentityKey: "doc",
        target: { kind: "problem", id: "p1" },
        kind: "drawn",
        message: "できました。",
        drawing: expect.objectContaining({ width: 160 }),
      }),
    ]);
    frameChatStore.dismissNotice(lastAssistant().id);
    expect(frameChatStore.getNotices()).toEqual([]);
  });

  it("tells about a failure that happens in the background, and about a reply with no drawing", async () => {
    const { runs } = installBridge();
    frameChatStore.send(request());
    runs[0].finish({ ok: false, error: "生成がタイムアウトしました。" });
    await vi.waitFor(() => expect(lastAssistant().status).toBe("error"));
    expect(lastAssistant().error).toBe("生成がタイムアウトしました。");
    expect(frameChatStore.getNotices()[0]).toMatchObject({ kind: "failed", error: "生成がタイムアウトしました。" });

    frameChatStore.send(request({ instruction: "もう一度" }));
    runs[1].finish({ ok: false, error: "枠として使える絵がありません", message: "どんな色にしますか？" });
    await vi.waitFor(() => expect(session().turns.length).toBe(4));
    await vi.waitFor(() => expect(lastAssistant().status).toBe("error"));
    expect(lastAssistant().message).toBe("どんな色にしますか？");
  });

  it("treats text that is not a usable drawing as a failed turn, and a thrown call as one too", async () => {
    const { runs } = installBridge();
    frameChatStore.send(request());
    runs[0].finish({ ok: true, text: "枠は描けません" });
    await vi.waitFor(() => expect(lastAssistant().status).toBe("error"));
    expect(lastAssistant().drawing).toBeNull();
    expect(lastAssistant().error).toContain("枠として使える絵");

    frameChatStore.send(request({ instruction: "もう一度" }));
    runs[1].fail(new Error("IPC が切れました"));
    await vi.waitFor(() => expect(lastAssistant().error).toBe("IPC が切れました"));
  });

  it("refuses a second request while one is running, an empty one, and any without the desktop bridge", () => {
    expect(frameChatStore.send(request())).toEqual({ ok: false, reason: "unavailable" });
    installBridge();
    expect(frameChatStore.send(request({ instruction: "  " }))).toEqual({ ok: false, reason: "empty" });
    expect(frameChatStore.send(request())).toEqual({ ok: true });
    expect(frameChatStore.send(request({ instruction: "続き" }))).toEqual({ ok: false, reason: "busy" });
  });

  it("carries the earlier requests as history and the base drawing into the next run", async () => {
    const { runs } = installBridge();
    frameChatStore.send(request({ instruction: "桜の枠" }));
    runs[0].finish({ ok: true, text: SVG });
    await vi.waitFor(() => expect(lastAssistant().status).toBe("done"));

    frameChatStore.send(request({ instruction: "もっと淡く", baseSvg: SVG }));
    expect(runs[1].request.context).toEqual({ title: "", description: "", currentContent: SVG, history: ["桜の枠"] });
    expect(lastAssistant().revised).toBe(true);
  });

  it("cancels the run: the bridge is told, the turn says so, and a late result is ignored", async () => {
    const { runs, cancel } = installBridge();
    frameChatStore.send(request());
    frameChatStore.cancel(KEY);

    expect(cancel).toHaveBeenCalledWith("run-1");
    expect(lastAssistant().status).toBe("cancelled");
    expect(session().runId).toBeNull();

    runs[0].finish({ ok: false, error: "生成を中止しました。" });
    await Promise.resolve();
    expect(lastAssistant().status).toBe("cancelled");
    expect(frameChatStore.getNotices()).toEqual([]);
    // The conversation can go on.
    expect(frameChatStore.send(request({ instruction: "続き" }))).toEqual({ ok: true });
  });

  it("keeps separate conversations for separate problems, and runs them side by side", () => {
    const { runs } = installBridge();
    const other = "doc\u0000p2";
    expect(frameChatStore.send(request())).toEqual({ ok: true });
    expect(frameChatStore.send(request({ key: other, target: { kind: "problem", id: "p2" } }))).toEqual({ ok: true });
    expect(runs).toHaveLength(2);
    expect(frameChatStore.getSession(other)?.target).toEqual({ kind: "problem", id: "p2" });
  });

  it("asks for a box's frame when the conversation is about a box, and says so in its notice", async () => {
    const { runs } = installBridge();
    const boxKey = "doc\u0000box\u0000box_1";
    expect(frameChatStore.send(request({ key: boxKey, target: { kind: "box", id: "box_1" } }))).toEqual({ ok: true });
    expect(runs[0].request).toMatchObject({ purpose: "frameDrawing", frameTarget: "box" });
    runs[0].finish({ ok: true, text: SVG });
    await vi.waitFor(() => expect(frameChatStore.getNotices()).toHaveLength(1));
    expect(frameChatStore.getNotices()[0]).toMatchObject({ kind: "drawn", target: { kind: "box", id: "box_1" } });
  });

  it("remembers which reply was put on the problem", async () => {
    const { runs } = installBridge();
    frameChatStore.send(request());
    runs[0].finish({ ok: true, text: SVG });
    await vi.waitFor(() => expect(lastAssistant().status).toBe("done"));
    frameChatStore.markApplied(KEY, lastAssistant().id);
    expect(session().appliedTurnId).toBe(lastAssistant().id);
  });
});
