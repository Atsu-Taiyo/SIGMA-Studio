// @vitest-environment happy-dom

import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appendCommentMessage, updateCommentMessageBody, type InlineNode, type SigmaCommentAnchor, type SigmaDocument } from "@/features/document";
import type { AiEditRunResult } from "@/lib/ai/ai-edit-runtime";
import { createTranslator } from "@/lib/i18n";

import { useCommentAiRun, type CommentAiRunOptions } from "./use-comment-ai-run";

const NOW = "2026-09-09T01:00:00.000Z";
const text = (value: string): InlineNode[] => [{ type: "text", text: value }];
const anchor: SigmaCommentAnchor = { type: "block", blockId: "paragraph-1" };
const tEditor = createTranslator("ja", "editor");
const tAi = createTranslator("ja", "ai");

let root: Root;
let container: HTMLDivElement;
let trigger: ReturnType<typeof useCommentAiRun>;
let submissionAtLayout: ReturnType<typeof useCommentAiRun>;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Probe({ options }: { options: CommentAiRunOptions }) {
  const result = useCommentAiRun(options);
  useLayoutEffect(() => {
    trigger = result;
    submissionAtLayout = options.onCommentSubmittedRef.current;
  });
  return null;
}

function render(options: CommentAiRunOptions) {
  act(() => root.render(<Probe options={options} />));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const documentRef: { current: SigmaDocument } = { current: {
    version: "2.0",
    docId: "comment-ai-hook",
    metadata: { title: "コメントAI" },
    content: [{ id: "paragraph-1", type: "paragraph", children: text("本文") }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    comments: ["first", "second"].map((id) => ({
      id, anchor, messages: [{ id: `${id}-first`, authorName: "あなた", body: text("質問"), createdAt: NOW }], createdAt: NOW, updatedAt: NOW,
    })),
  } };
  const events: string[] = [];
  const pendingRun = deferred<AiEditRunResult>();
  const pendingRefresh = deferred<void>();
  let sequence = 0;
  const mutationPorts = { now: () => NOW, createId: (prefix: string) => `${prefix}-${++sequence}` };
  const appendReplyMessage = vi.fn<CommentAiRunOptions["appendReplyMessage"]>((threadId, authorName, body, agent) => {
    events.push(`append:${threadId}`);
    const result = appendCommentMessage(documentRef.current, { threadId, authorName, body, agent }, mutationPorts);
    documentRef.current = result.document;
    return result.messageId;
  });
  const editCommentMessage = vi.fn<CommentAiRunOptions["editCommentMessage"]>((threadId, messageId, body) => {
    events.push(`edit:${threadId}`);
    documentRef.current = updateCommentMessageBody(documentRef.current, { threadId, messageId, body }, mutationPorts).document;
  });
  const runAiEdit = vi.fn<CommentAiRunOptions["runAiEdit"]>(() => { events.push("run"); return pendingRun.promise; });
  const refreshMcpEditProposals = vi.fn(() => { events.push("refresh"); return pendingRefresh.promise; });
  const initialSubmission = vi.fn();
  const options: CommentAiRunOptions = {
    documentRef,
    activeFileIdRef: { current: "file-before-render" },
    connectedProviders: { chatgpt: true, claude: true, antigravity: true },
    appendReplyMessage,
    editCommentMessage,
    refreshMcpEditProposals,
    onCommentSubmittedRef: { current: initialSubmission },
    models: { chatgpt: "gpt-model", claude: "claude-model", antigravity: "gemini-model" },
    reasoningEffort: "high",
    runAiEdit,
    tEditor,
    tAi,
  };
  const result = (summary = "回答の要約", operations: AiEditRunResult["draft"]["operations"] = []): AiEditRunResult => ({
    draft: { summary, plan: [], operations, warnings: [] },
    nextDocument: documentRef.current,
    operationResults: [],
    logs: [],
    repaired: false,
    changedIds: [],
  });
  return { options, documentRef, events, pendingRun, pendingRefresh, appendReplyMessage, editCommentMessage, runAiEdit, refreshMcpEditProposals, initialSubmission, result };
}

describe("mounted comment AI run", () => {
  it("publishes its handler in a passive effect and refreshes provider state after rerender", async () => {
    const f = fixture();
    render({ ...f.options, connectedProviders: { ...f.options.connectedProviders, claude: false } });
    expect(submissionAtLayout).toBe(f.initialSubmission);
    expect(f.options.onCommentSubmittedRef.current).toBe(trigger);
    act(() => f.options.onCommentSubmittedRef.current("first", text("通常の返信"), anchor));
    expect(f.events).toEqual([]);
    act(() => f.options.onCommentSubmittedRef.current("first", text("@claude 確認して"), anchor));
    expect(f.runAiEdit).not.toHaveBeenCalled();
    expect(f.appendReplyMessage).toHaveBeenLastCalledWith("first", "Claude", text("Claudeに接続されていません。サイドバーのAIパネルからログインしてください。"), { vendor: "anthropic" });

    const previousHandler = trigger;
    render(f.options);
    expect(submissionAtLayout).toBe(previousHandler);
    expect(f.options.onCommentSubmittedRef.current).toBe(trigger);
    expect(trigger).not.toBe(previousHandler);
    act(() => f.options.onCommentSubmittedRef.current("first", text("@claude 確認して"), anchor));
    expect(f.runAiEdit).toHaveBeenCalledOnce();
    await act(async () => { f.pendingRun.resolve(f.result()); f.pendingRefresh.resolve(); });
  });

  it.each([
    ["@codex", "chatgpt", "ChatGPT", "openai", "gpt-model"],
    ["@claude", "claude", "Claude", "anthropic", "claude-model"],
    ["@antigravity", "antigravity", "Antigravity", "google", "gemini-model"],
  ])("starts %s from the document containing its placeholder and the current file", async (mention, provider, author, vendor, model) => {
    const f = fixture();
    render(f.options);
    f.options.activeFileIdRef.current = "file-current";
    const latestContent: SigmaDocument["content"] = [{ id: "paragraph-1", type: "paragraph", children: text("変更後の本文") }];
    f.documentRef.current = { ...f.documentRef.current, content: latestContent };
    act(() => trigger("first", text(`${mention} 確認して`), anchor));

    expect(f.events).toEqual(["append:first", "run"]);
    expect(f.appendReplyMessage).toHaveBeenCalledWith("first", author, text(tEditor("status.aiThinking", { name: author })), { vendor });
    const request = f.runAiEdit.mock.calls[0][0];
    expect(request).toMatchObject({ fileId: "file-current", provider, model, reasoningEffort: "high", selectedId: "paragraph-1" });
    expect(request.document).toBe(f.documentRef.current);
    expect(request.document.content).toBe(latestContent);
    expect(request.document.comments?.[0]?.messages).toHaveLength(2);

    await act(async () => { f.pendingRun.resolve(f.result("  要約の本文  ")); });
    expect(f.events).toEqual(["append:first", "run", "refresh"]);
    expect(f.editCommentMessage).not.toHaveBeenCalled();
    await act(async () => { f.pendingRefresh.resolve(); });
    expect(f.events).toEqual(["append:first", "run", "refresh", "edit:first"]);
    expect(f.editCommentMessage).toHaveBeenCalledWith("first", "comment_msg-1", text("要約の本文"));
    expect(f.documentRef.current.content).toBe(latestContent);
    expect(f.documentRef.current.comments?.[0]?.messages[1].body).toEqual(text("要約の本文"));
  });

  it("keeps a synchronous per-thread running guard through rerenders and proposal refresh", async () => {
    const f = fixture();
    render(f.options);
    act(() => {
      trigger("first", text("@codex 一つ目"), anchor);
      trigger("first", text("@claude 重複"), anchor);
      trigger("second", text("@claude 別スレッド"), anchor);
    });
    expect(f.runAiEdit).toHaveBeenCalledTimes(2);
    expect(f.appendReplyMessage).toHaveBeenCalledTimes(2);
    render({ ...f.options, connectedProviders: { ...f.options.connectedProviders, chatgpt: false } });
    act(() => trigger("first", text("@codex 接続状態変更後の重複"), anchor));
    expect(f.appendReplyMessage).toHaveBeenCalledTimes(2);
    await act(async () => { f.pendingRun.resolve(f.result()); });
    act(() => trigger("second", text("@claude 提案再取得中の重複"), anchor));
    expect(f.runAiEdit).toHaveBeenCalledTimes(2);
    await act(async () => { f.pendingRefresh.resolve(); });
    expect(f.editCommentMessage).toHaveBeenCalledTimes(2);
    expect(f.documentRef.current.comments?.map((thread) => thread.messages[1].body)).toEqual([text("回答の要約"), text("回答の要約")]);
    await act(async () => trigger("second", text("@claude 次の実行"), anchor));
    expect(f.runAiEdit).toHaveBeenCalledTimes(3);
    expect(f.documentRef.current.comments?.[1]?.messages).toHaveLength(3);
  });

  it.each(["run", "refresh", "unknown"] as const)("replaces the placeholder and permits a retry after %s failure", async (failure) => {
    const f = fixture();
    render(f.options);
    act(() => trigger("first", text("@codex 確認して"), anchor));
    await act(async () => {
      if (failure === "refresh") {
        f.pendingRun.resolve(f.result());
        // Let the async continuation attach its refresh handler before rejection.
        await f.pendingRun.promise;
        f.pendingRefresh.reject(new Error("再取得失敗"));
      } else {
        f.pendingRun.reject(failure === "unknown" ? "unknown failure" : new Error("実行失敗"));
      }
    });
    const message = failure === "unknown" ? tEditor("status.aiRunFailed") : failure === "run" ? "実行失敗" : "再取得失敗";
    expect(f.editCommentMessage).toHaveBeenCalledWith("first", "comment_msg-1", text(tEditor("status.errorWith", { message })));
    expect(f.documentRef.current.comments?.[0]?.messages[1].body).toEqual(text(tEditor("status.errorWith", { message })));
    f.runAiEdit.mockResolvedValue(f.result("再実行の回答"));
    f.refreshMcpEditProposals.mockResolvedValue();
    await act(async () => trigger("first", text("@codex 再実行"), anchor));
    expect(f.runAiEdit).toHaveBeenCalledTimes(2);
    expect(f.documentRef.current.comments?.[0]?.messages[2].body).toEqual(text("再実行の回答"));
  });

  it.each([false, true])("uses the existing completion fallback when summary is blank (operations: %s)", async (hasOperations) => {
    const f = fixture();
    const operations: AiEditRunResult["draft"]["operations"] = hasOperations ? [{
      operation: "replace", targetId: "paragraph-1", summary: "本文を更新", replacementBlock: { id: "paragraph-1", type: "paragraph", children: text("提案の本文") },
    }] : [];
    render(f.options);
    act(() => trigger("first", text("@codex 確認して"), anchor));
    await act(async () => { f.pendingRun.resolve(f.result("  ", operations)); f.pendingRefresh.resolve(); });
    const expected = tEditor(hasOperations ? "status.aiDraftReady" : "status.aiAnswerReady");
    expect(f.editCommentMessage).toHaveBeenCalledWith("first", "comment_msg-1", text(expected));
    expect(f.documentRef.current.content[0]).toMatchObject({ children: text("本文") });
  });
});
