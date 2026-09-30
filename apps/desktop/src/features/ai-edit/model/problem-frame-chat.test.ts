import { describe, expect, it } from "vitest";

import {
  isProblemFrameChatRunning,
  latestProblemFrameDrawing,
  problemFrameChatHistory,
  problemFrameChatKey,
  splitStreamedFrameReply,
  type ProblemFrameChatAssistantTurn,
  type ProblemFrameChatSession,
} from "./problem-frame-chat";

function assistant(patch: Partial<ProblemFrameChatAssistantTurn> = {}): ProblemFrameChatAssistantTurn {
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

function session(turns: ProblemFrameChatSession["turns"], patch: Partial<ProblemFrameChatSession> = {}): ProblemFrameChatSession {
  return { key: "k", documentIdentityKey: "d", problemId: "p", turns, runId: null, appliedTurnId: null, ...patch };
}

describe("problemFrameChatKey", () => {
  it("keeps two documents' problems with the same id apart", () => {
    expect(problemFrameChatKey("doc-a", "p1")).not.toBe(problemFrameChatKey("doc-b", "p1"));
    expect(problemFrameChatKey(undefined, "p1")).toBe(problemFrameChatKey(null, "p1"));
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
    const turns: ProblemFrameChatSession["turns"] = [
      { id: "u1", role: "user", text: "桜", at: 0 },
      assistant({ id: "a1", drawing: { ...drawing, svg: "<svg id='1'/>" } }),
      { id: "u2", role: "user", text: "淡く", at: 1 },
      assistant({ id: "a2", status: "error", error: "x" }),
    ];
    expect(latestProblemFrameDrawing(session(turns))?.svg).toBe("<svg id='1'/>");
    expect(latestProblemFrameDrawing(session([]))).toBeNull();
    expect(latestProblemFrameDrawing(null)).toBeNull();
    expect(problemFrameChatHistory(session(turns))).toEqual(["桜", "淡く"]);
  });

  it("is running while a run id is held or a turn is still running", () => {
    expect(isProblemFrameChatRunning(null)).toBe(false);
    expect(isProblemFrameChatRunning(session([assistant()]))).toBe(false);
    expect(isProblemFrameChatRunning(session([assistant({ status: "running" })]))).toBe(true);
    expect(isProblemFrameChatRunning(session([assistant()], { runId: "r" }))).toBe(true);
  });
});
