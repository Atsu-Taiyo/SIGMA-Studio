import { describe, expect, it } from "vitest";

import {
  createSessionTreeTracker,
  createSubagentResultHold,
  finalResponseOf,
  parseStartedSubagentId,
} from "../dsh-runtime/bridge.mjs";

// dsh 0.2.1-rc.5 に偽の中継をつないで記録した通知の形 (サブエージェントを 1 つ使った実行)。
const ROOT = "session-root";
const CHILD = "child-1";
const status = (sessionId: string, value: string) => ({ method: "session.status", params: { sessionId, status: value } });
const inbox = (sessionId: string, inserted: number, removedCount?: number) => ({
  method: "session.event",
  params: {
    sessionId,
    event: {
      type: "agent/inbox/spliced",
      data: { target: "next-turn", start: 0, inserted: Array.from({ length: inserted }, (_, index) => ({ id: `m${index}` })), ...(removedCount === undefined ? {} : { removedCount }) },
    },
  },
});
const started = { method: "subagent.started", params: { parentSessionId: ROOT, childSessionId: CHILD } };
const finished = (statusValue = "ok") => ({ method: "subagent.finished", params: { parentSessionId: ROOT, childSessionId: CHILD, status: statusValue } });

describe("createSessionTreeTracker", () => {
  it("treats a run without subagents as done once the parent is idle", () => {
    const tracker = createSessionTreeTracker(ROOT);
    for (const notification of [inbox(ROOT, 1), status(ROOT, "running"), inbox(ROOT, 0, 1)]) tracker.observe(notification);
    expect(tracker.isRootIdle()).toBe(false);
    tracker.observe(status(ROOT, "idle"));
    expect(tracker.isRootIdle()).toBe(true);
    expect(tracker.usedSubagents()).toBe(false);
    expect(tracker.isSettled()).toBe(true);
  });

  it("is not done while a child is still working, even though the parent went idle", () => {
    const tracker = createSessionTreeTracker(ROOT);
    for (const notification of [
      inbox(ROOT, 1), status(ROOT, "running"), inbox(ROOT, 0, 1),
      started, inbox(CHILD, 1), status(CHILD, "running"), inbox(CHILD, 0, 1),
      status(ROOT, "idle"),
    ]) tracker.observe(notification);

    // SDK の session.run はここで終わってしまう。子はまだ動いている。
    expect(tracker.usedSubagents()).toBe(true);
    expect(tracker.isRootIdle()).toBe(true);
    expect(tracker.isQuiet()).toBe(false);
    expect(tracker.isSettled()).toBe(false);
  });

  it("is not done in the gap after the child finished, while its completion notice is unread", () => {
    const tracker = createSessionTreeTracker(ROOT);
    for (const notification of [
      inbox(ROOT, 1), status(ROOT, "running"), inbox(ROOT, 0, 1),
      started, status(CHILD, "running"), status(ROOT, "idle"),
      status(CHILD, "idle"),
    ]) tracker.observe(notification);
    // 子は idle になったが、終わったという知らせ (subagent.finished) がまだ無い。
    expect(tracker.isQuiet()).toBe(false);

    // 完了の知らせが親の受信箱に入った: 親がそれを読んで動き出すまでは終わっていない。
    tracker.observe(inbox(ROOT, 1));
    tracker.observe(finished());
    expect(tracker.hasUnreadInbox()).toBe(true);
    expect(tracker.isSettled()).toBe(false);
  });

  it("is done after the parent read the notice, ran its last turn, and went idle again", () => {
    const tracker = createSessionTreeTracker(ROOT);
    for (const notification of [
      inbox(ROOT, 1), status(ROOT, "running"), inbox(ROOT, 0, 1),
      started, status(CHILD, "running"), status(ROOT, "idle"),
      status(CHILD, "idle"),
      inbox(ROOT, 1), status(ROOT, "running"), inbox(ROOT, 0, 1), finished(),
    ]) tracker.observe(notification);
    expect(tracker.isSettled()).toBe(false);
    tracker.observe(status(ROOT, "idle"));
    expect(tracker.isSettled()).toBe(true);
  });

  it("ignores malformed notifications", () => {
    const tracker = createSessionTreeTracker(ROOT);
    for (const notification of [null, {}, { method: "session.status" }, { method: "session.status", params: { sessionId: 1 } }]) {
      tracker.observe(notification);
    }
    expect(tracker.isRootIdle()).toBe(false);
  });
});

describe("createSubagentResultHold", () => {
  const call = { type: "tool-call" as const, id: "call_0", name: "subagent", arguments: "{}" };
  const startedResult = { type: "tool-result" as const, id: "call_0", isError: false, text: "started subagent child-1", images: [] };

  it("keeps a launch's result until that child has finished", () => {
    const hold = createSubagentResultHold("subagent");
    expect(hold.filter(call)).toEqual([call]);
    // 起動しただけ。ここで流すと、進行表示の行がすぐ完了になる。
    expect(hold.filter(startedResult)).toEqual([]);
    expect(hold.release(status(CHILD, "idle"))).toEqual([]);
    expect(hold.release(finished())).toEqual([{ ...startedResult, text: "" }]);
    // 同じ子の知らせが重なっても、二度は流さない。
    expect(hold.release(finished())).toEqual([]);
  });

  it("marks the row failed when the child did not finish normally", () => {
    const hold = createSubagentResultHold("subagent");
    hold.filter(call);
    hold.filter(startedResult);
    expect(hold.release(finished("error"))).toEqual([{ ...startedResult, text: "", isError: true }]);
  });

  it("passes a refused launch straight through (depth or count limit)", () => {
    const hold = createSubagentResultHold("subagent");
    const refused = { type: "tool-result" as const, id: "call_0", isError: true, text: "Error: subagent depth 2 exceeds maxDepth 1", images: [] };
    hold.filter(call);
    expect(hold.filter(refused)).toEqual([refused]);
  });

  it("leaves other tools alone, and does nothing when subagents are not in use", () => {
    const material = { type: "tool-result" as const, id: "call_9", isError: false, text: "started subagent child-1", images: [] };
    const hold = createSubagentResultHold("subagent");
    hold.filter({ type: "tool-call", id: "call_9", name: "mcp__sigma-studio-local__insert_content", arguments: "{}" });
    expect(hold.filter(material)).toEqual([material]);

    const off = createSubagentResultHold(null);
    off.filter(call);
    expect(off.filter(startedResult)).toEqual([startedResult]);
  });
});

describe("bridge helpers", () => {
  it("reads the started child id out of the subagent tool's result", () => {
    expect(parseStartedSubagentId("started subagent ecca43a1-192a-4650-adb9-666c5901c4e4")).toBe("ecca43a1-192a-4650-adb9-666c5901c4e4");
    expect(parseStartedSubagentId("Error: subagent limit reached (active child limit: 1)")).toBeNull();
    expect(parseStartedSubagentId(undefined)).toBeNull();
  });

  it("takes the parent's last message as the final response, across the turn that follows the notice", () => {
    const message = (text: string) => ({ type: "assistant/message", data: { message: { content: [{ type: "text", text }] } } });
    expect(finalResponseOf([message("サブエージェントに任せました。待ちます。"), { type: "turn/end", data: {} }, message("まとめを追加しました。")]))
      .toBe("まとめを追加しました。");
    expect(finalResponseOf([])).toBe("");
  });
});
