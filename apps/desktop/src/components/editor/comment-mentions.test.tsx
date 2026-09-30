// @vitest-environment happy-dom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentMentionMenu } from "./CommentMentionMenu";
import { CommentMentionMark, commentMentionQuery, insertCommentMention } from "./comment-mentions";
import { inlineNodesToTiptapDoc, tiptapDocToInlineNodes, type TiptapDoc } from "@/lib/tiptap-adapter";
import { detectCommentAiMention } from "@/lib/ai/comment-mention";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { sampleDocument } from "@/lib/sample-document";
import type { InlineNode } from "@/features/document";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).reverse().forEach((fn) => fn()));
function createEditor(text: string) {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({ element, extensions: [StarterKit, CommentMentionMark], content: inlineNodesToTiptapDoc([{ type: "text", text }]) });
  editor.commands.setTextSelection(text.length + 1);
  editor.isFocused = true;
  cleanup.push(() => { editor.destroy(); element.remove(); });
  return editor;
}
describe("collaborator mentions", () => {
  it("keeps distinct recipient IDs through editing and the document save format", () => {
    const body: InlineNode[] = [
      { type: "text", text: "@同じ名前", mentionUserId: "user-a" },
      { type: "text", text: "@同じ名前", mentionUserId: "user-b" },
      { type: "text", text: " を確認してください" },
    ];
    expect(tiptapDocToInlineNodes(inlineNodesToTiptapDoc(body))).toEqual(body);
    const value = { ...sampleDocument, comments: [{ id: "thread", anchor: { type: "block", blockId: "block-1" }, createdAt: "2026-09-24T00:00:00.000Z", messages: [{ id: "message", body, createdAt: "2026-09-24T00:00:00.000Z" }] }] };
    const saved = parseSigmaDocument(JSON.parse(JSON.stringify(value)));
    expect(saved.comments?.[0].messages[0].body).toEqual(body);
    const editor = createEditor("");
    editor.commands.setContent(inlineNodesToTiptapDoc(saved.comments![0].messages[0].body));
    expect(tiptapDocToInlineNodes(editor.getJSON() as TiptapDoc)).toEqual(body);
  });
  it("does not run an AI agent for a collaborator named Claude", () => {
    expect(detectCommentAiMention([{ type: "text", text: "@Claude", mentionUserId: "person" }])).toBeNull();
    expect(detectCommentAiMention([{ type: "text", text: "@Claude", mentionUserId: "person" }, { type: "text", text: " @codex 確認して" }])?.provider).toBe("chatgpt");
  });
  it("inserts a recipient, leaves following text unmentioned, and supports undo", () => {
    const editor = createEditor("確認 @ta");
    expect(commentMentionQuery(editor)?.query).toBe("ta");
    insertCommentMention(editor, { userId: "taro", name: "太郎" });
    expect(tiptapDocToInlineNodes(editor.getJSON() as TiptapDoc)).toEqual([
      { type: "text", text: "確認 " }, { type: "text", text: "@太郎", mentionUserId: "taro" }, { type: "text", text: " " },
    ]);
    editor.commands.insertContent("お願いします");
    expect(tiptapDocToInlineNodes(editor.getJSON() as TiptapDoc).at(-1)).toEqual({ type: "text", text: " お願いします" });
    editor.commands.undo();
    expect(editor.getText()).toBe("確認 @ta");
  });
  it("lists AI agents after collaborators and inserts one as plain text the AI trigger can read", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const editor = createEditor("確認 @cl");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    cleanup.push(() => { act(() => root.unmount()); container.remove(); });
    const load = vi.fn(async () => [{ userId: "a", name: "clara@example.com", email: "clara@example.com" }, { userId: "b", name: "Bob" }]);
    await act(async () => { root.render(<CommentMentionMenu editor={editor} loadCandidates={load} />); });
    await act(async () => { editor.emit("focus", { editor, event: new FocusEvent("focus"), transaction: editor.state.tr }); });
    const options = Array.from(container.querySelectorAll('[role="option"]'));
    expect(options.map((option) => option.querySelector(".comment-mention-option-name")?.textContent)).toEqual(["clara@example.com", "Claude"]);
    expect(options[0].querySelector(".comment-mention-option-sub")).toBeNull();
    act(() => { (options[1] as HTMLElement).click(); });
    const body = tiptapDocToInlineNodes(editor.getJSON() as TiptapDoc);
    expect(body.map((node) => node.type === "text" ? node.text : "").join("")).toBe("確認 @claude ");
    expect(body.every((node) => node.type === "text" && !node.mentionUserId)).toBe(true);
    expect(detectCommentAiMention(body)?.provider).toBe("claude");
  });
  it("shows the collaborator's email under the name only when it differs", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const editor = createEditor("@ta");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    cleanup.push(() => { act(() => root.unmount()); container.remove(); });
    const load = vi.fn(async () => [{ userId: "taro", name: "太郎", email: "taro@example.com" }]);
    await act(async () => { root.render(<CommentMentionMenu editor={editor} loadCandidates={load} />); });
    await act(async () => { editor.emit("focus", { editor, event: new FocusEvent("focus"), transaction: editor.state.tr }); });
    const option = container.querySelector('[role="option"]')!;
    expect(option.querySelector(".comment-mention-option-name")?.textContent).toBe("太郎");
    expect(option.querySelector(".comment-mention-option-sub")?.textContent).toBe("taro@example.com");
  });
  it("ignores email addresses and a selected range", () => {
    const editor = createEditor("person@example.com");
    expect(commentMentionQuery(editor)).toBeNull();
    editor.commands.setContent(inlineNodesToTiptapDoc([{ type: "text", text: "@太郎" }]));
    editor.commands.setTextSelection({ from: 1, to: 3 });
    expect(commentMentionQuery(editor)).toBeNull();
  });
  it("selects collaborators with the keyboard without consuming IME confirmation", async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const editor = createEditor("@");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    cleanup.push(() => { act(() => root.unmount()); container.remove(); });
    const load = vi.fn(async () => [{ userId: "a", name: "Alice" }, { userId: "b", name: "Bob" }]);
    await act(async () => { root.render(<CommentMentionMenu editor={editor} loadCandidates={load} />); });
    await act(async () => { editor.emit("focus", { editor, event: new FocusEvent("focus"), transaction: editor.state.tr }); });
    // 共同編集者 2 人 + AI 4 つ。人が先に並ぶ。
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(6);
    const ime = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
    // Observe after the mention handler, before ProseMirror handles the synthetic IME event.
    const stopAtEditor = (event: Event) => event.stopImmediatePropagation();
    editor.view.dom.addEventListener("keydown", stopAtEditor, { capture: true, once: true });
    act(() => { editor.view.dom.dispatchEvent(ime); });
    expect(ime.defaultPrevented).toBe(false);
    act(() => { editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); });
    act(() => { editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(tiptapDocToInlineNodes(editor.getJSON() as TiptapDoc)[0]).toMatchObject({ text: "@Bob", mentionUserId: "b" });
  });
});
