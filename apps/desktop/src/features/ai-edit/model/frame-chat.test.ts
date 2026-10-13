import { describe, expect, it } from "vitest";

import {
  isFrameChatRunning,
  latestFrameChatDrawing,
  frameChatHistory,
  frameChatKey,
  splitStreamedFrameReply,
  type FrameChatAssistantTurn,
  type FrameChatSession,
} from "./frame-chat";

function assistant(patch: Partial<FrameChatAssistantTurn> = {}): FrameChatAssistantTurn {
  return {
    id: "a1",
    role: "assistant",
    status: "done",
    provider: "claude",
    streamText: "",
    reasoningText: "",
    message: "",
    drawing: null,
    revised: false,
    error: null,
    startedAt: 0,
    replyStartedAt: null,
    endedAt: 1,
    ...patch,
  };
}

function session(turns: FrameChatSession["turns"], patch: Partial<FrameChatSession> = {}): FrameChatSession {
  return { key: "k", documentIdentityKey: "d", target: { kind: "problem", id: "p" }, turns, runId: null, appliedTurnId: null, ...patch };
}

describe("frameChatKey", () => {
  it("keeps two documents' problems with the same id apart", () => {
    const p1 = { kind: "problem", id: "p1" } as const;
    expect(frameChatKey("doc-a", p1)).not.toBe(frameChatKey("doc-b", p1));
    expect(frameChatKey(undefined, p1)).toBe(frameChatKey(null, p1));
  });

  it("keeps a problem's and a box's conversations apart even when their ids match", () => {
    expect(frameChatKey("doc", { kind: "problem", id: "x" })).not.toBe(frameChatKey("doc", { kind: "box", id: "x" }));
  });
});

describe("splitStreamedFrameReply", () => {
  it("shows the note the model wrote before the SVG and counts how much SVG is written so far", () => {
    const raw = "桜を入れました。\n<svg viewBox=\"0 0 160 100\"><rect/>";
    expect(splitStreamedFrameReply(raw)).toEqual({ message: "桜を入れました。", drawingChars: raw.length - raw.indexOf("<svg") });
  });

  it("does not let a half-written <svg tag or a code fence opener leak into the note", () => {
    expect(splitStreamedFrameReply("桜です。\n<sv").message).toBe("桜です。");
    expect(splitStreamedFrameReply("桜です。\n<").message).toBe("桜です。");
    expect(splitStreamedFrameReply("桜です。\n```svg\n<svg>")).toEqual({ message: "桜です。", drawingChars: 5 });
    expect(splitStreamedFrameReply("桜です。\n```").message).toBe("桜です。");
  });

  it("is all note while no SVG has started", () => {
    expect(splitStreamedFrameReply("まず")).toEqual({ message: "まず", drawingChars: 0 });
    expect(splitStreamedFrameReply("")).toEqual({ message: "", drawingChars: 0 });
  });
});

describe("conversation reads", () => {
  const drawing = { svg: "<svg/>", width: 160, height: 100 };

  it("finds the latest drawing to rework, and the earlier requests in order", () => {
    const turns: FrameChatSession["turns"] = [
      { id: "u1", role: "user", text: "桜", at: 0 },
      assistant({ id: "a1", drawing: { ...drawing, svg: "<svg id='1'/>" } }),
      { id: "u2", role: "user", text: "淡く", at: 1 },
      assistant({ id: "a2", status: "error", error: "x" }),
    ];
    expect(latestFrameChatDrawing(session(turns))?.svg).toBe("<svg id='1'/>");
    expect(latestFrameChatDrawing(session([]))).toBeNull();
    expect(latestFrameChatDrawing(null)).toBeNull();
    expect(frameChatHistory(session(turns))).toEqual(["桜", "淡く"]);
  });

  it("is running while a run id is held or a turn is still running", () => {
    expect(isFrameChatRunning(null)).toBe(false);
    expect(isFrameChatRunning(session([assistant()]))).toBe(false);
    expect(isFrameChatRunning(session([assistant({ status: "running" })]))).toBe(true);
    expect(isFrameChatRunning(session([assistant()], { runId: "r" }))).toBe(true);
  });
});
