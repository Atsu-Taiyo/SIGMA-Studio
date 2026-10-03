// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setAppLocale } from "@/lib/i18n";
import type { SigmaCommentThread, SigmaDocument } from "@/features/document";
import { CommentRail, type CommentRailProps } from "./CommentRail";

let root: Root;
let container: HTMLDivElement;

const at = "2026-10-03T00:00:00.000Z";
const thread = (id: string, authors: string[], anchor: SigmaCommentThread["anchor"] = { type: "block", blockId: "p_1" }): SigmaCommentThread => ({
  id,
  anchor,
  createdAt: at,
  messages: authors.map((authorName, index) => ({ id: `${id}_m${index}`, authorName, body: [{ type: "text", text: `${authorName}のコメント` }], createdAt: at })),
});

const document: SigmaDocument = {
  version: "2.0",
  docId: "comment_rail_test",
  metadata: { title: "コメントのカード" },
  content: [{ id: "p_1", type: "paragraph", children: [{ type: "text", text: "本文" }] }],
  comments: [],
  outputProfiles: { student: {}, teacher: {}, answerBook: {} },
};

const noop = () => {};
function props(threads: SigmaCommentThread[], overrides: Partial<CommentRailProps> = {}): CommentRailProps {
  return {
    document,
    open: true,
    whiteboard: false,
    onPeekHostChange: noop,
    onCompactChange: noop,
    panel: {
      activeThreadId: null,
      author: { name: "木村" },
      candidateAnchor: null,
      pendingAnchor: null,
      pendingDraft: [],
      replyDrafts: {},
      showResolved: false,
      threads,
      onAddThread: noop,
      onCancelPending: noop,
      onDeleteMessage: noop,
      onDeleteThread: noop,
      onEditMessage: noop,
      onEditThread: noop,
      onPendingDraftChange: noop,
      onReply: noop,
      onReplyDraftChange: noop,
      onResolveThread: noop,
      onReopenThread: noop,
      onSelectThread: noop,
      onShowResolvedChange: noop,
      onStartThread: noop,
      onToggleReaction: noop,
    },
    ...overrides,
  };
}

const render = (next: CommentRailProps) => act(() => root.render(<CommentRail {...next} />));
const cards = () => [...container.querySelectorAll<HTMLElement>(".comment-thread-card")];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setAppLocale("ja");
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  }
  container = window.document.createElement("div");
  window.document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("CommentRail", () => {
  it("hands out the slot the sidebar's card is placed in, even with no comments", () => {
    const onPeekHostChange = vi.fn();
    render(props([], { onPeekHostChange }));
    const host = onPeekHostChange.mock.calls[0][0] as HTMLElement;
    expect(host).toBeInstanceOf(HTMLElement);
    expect(container.querySelector("[data-comment-rail]")?.contains(host)).toBe(true);
    // 空の案内カードは浮かぶ面に出さない。
    expect(container.querySelector('[role="region"]')).toBeNull();
  });

  it("stacks every thread as a card in a list, not at positions beside the page", () => {
    render(props([thread("t1", ["田中"]), thread("t2", ["佐藤"])]));
    expect(container.querySelector('[role="region"]')?.getAttribute("aria-label")).toBe("コメントのカード");
    expect(cards().map((card) => card.dataset.commentCardKey)).toEqual(["t1", "t2"]);
    expect(cards().every((card) => card.style.top === "")).toBe(true);
  });

  it("keeps self-mention counts accessible while cards are hidden and opens the mentioned thread", () => {
    const mentioned = thread("mentioned", ["田中"]);
    mentioned.messages[0].body = [{ type: "text", text: "@木村", mentionUserId: "me" }];
    const resolved = { ...mentioned, id: "resolved", resolved: true };
    const other = thread("other", ["佐藤"]);
    other.messages[0].body = [{ type: "text", text: "@他の人", mentionUserId: "someone-else" }];
    const base = props([mentioned, resolved, other]);
    const onSelectThread = vi.fn();
    render({ ...base, open: false, document: { ...document, comments: [mentioned, resolved, other] },
      panel: { ...base.panel, currentUserId: "me", onSelectThread } });
    const button = container.querySelector<HTMLButtonElement>('[aria-label="あなたへのメンション"]')!;
    expect(button.textContent).toBe("@1");
    expect(cards()).toHaveLength(0);
    act(() => button.click());
    expect(onSelectThread).toHaveBeenCalledWith("mentioned");
  });

  it("shows who spoke on a thread only once two or more people did, fading the third", () => {
    render(props([thread("solo", ["田中"]), thread("pair", ["田中", "佐藤"]), thread("trio", ["田中", "佐藤", "木村", "鈴木"])]));
    const stack = (key: string) => cards().find((card) => card.dataset.commentCardKey === key)!.querySelector<HTMLElement>("[data-participant-count]");
    expect(stack("solo")).toBeNull();
    expect(stack("pair")?.querySelectorAll('[data-participant="solid"]')).toHaveLength(2);
    const trio = stack("trio")!;
    expect(trio.querySelectorAll('[data-participant="solid"]')).toHaveLength(2);
    expect(trio.querySelectorAll('[data-participant="faded"]')).toHaveLength(1);
    expect(trio.querySelector('[data-participant="more"]')?.textContent).toBe("+1");
    expect(trio.getAttribute("aria-label")).toBe("参加者: 田中、佐藤、木村、鈴木");
  });

  it("draws nothing for the comments while they are hidden", () => {
    render(props([thread("t1", ["田中"])], { open: false }));
    expect(cards()).toHaveLength(0);
    expect(container.querySelector("[data-comment-rail]")).not.toBeNull();
  });

  describe("when there is no room right of the paper", () => {
    // 用紙の右端を 1097、窓の右端を 1000 として、置く余白が足りない状況を作る。
    const rect = (left: number, right: number) => ({ left, right, top: 0, bottom: 800, width: right - left, height: 800, x: left, y: 0, toJSON() {} }) as DOMRect;
    function mountApp(threads: SigmaCommentThread[], overrides: Partial<CommentRailProps> = {}) {
      const shell = window.document.createElement("div");
      shell.className = "app-shell";
      const canvas = window.document.createElement("section");
      canvas.className = "editor-canvas";
      canvas.getBoundingClientRect = () => rect(0, 1000);
      const paper = window.document.createElement("div");
      paper.className = "page-canvas";
      paper.getBoundingClientRect = () => rect(303, 1097);
      canvas.append(paper);
      const host = window.document.createElement("div");
      shell.append(canvas, host);
      container.append(shell);
      const hostRoot = createRoot(host);
      const onCompactChange = vi.fn();
      act(() => hostRoot.render(<CommentRail {...props(threads, { onCompactChange, ...overrides })} />));
      return { host, hostRoot, onCompactChange };
    }
    const flush = () => act(async () => { await new Promise((resolve) => window.requestAnimationFrame(() => resolve(null))); });

    it("turns the cards into small round buttons and reports it", async () => {
      const { host, hostRoot, onCompactChange } = mountApp([thread("t1", ["田中"]), thread("t2", ["佐藤", "木村"])]);
      await flush();
      expect(onCompactChange).toHaveBeenLastCalledWith(true);
      expect(host.querySelector("[data-comment-rail]")?.getAttribute("data-compact")).toBe("true");
      expect(host.querySelectorAll(".comment-thread-card")).toHaveLength(0);
      expect([...host.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"))).toEqual([
        "コメントを開く: 田中",
        "コメントを開く: 佐藤",
      ]);
      act(() => hostRoot.unmount());
    });

    it("opens the cards when a button is pressed, selecting that thread, and folds back on Escape", async () => {
      const onSelectThread = vi.fn();
      const base = props([thread("t1", ["田中"])]);
      const { host, hostRoot, onCompactChange } = mountApp([thread("t1", ["田中"])], { panel: { ...base.panel, onSelectThread } });
      await flush();
      act(() => host.querySelector<HTMLButtonElement>('button[aria-label="コメントを開く: 田中"]')!.click());
      expect(onSelectThread).toHaveBeenCalledWith("t1");
      expect(host.querySelectorAll(".comment-thread-card")).toHaveLength(1);
      expect(onCompactChange).toHaveBeenLastCalledWith(false);
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      expect(host.querySelectorAll(".comment-thread-card")).toHaveLength(0);
      expect(onCompactChange).toHaveBeenLastCalledWith(true);
      act(() => hostRoot.unmount());
    });

    it("folds the extra comments into a count", async () => {
      const many = Array.from({ length: 8 }, (_, index) => thread(`t${index}`, [`人${index}`]));
      const { host, hostRoot } = mountApp(many);
      await flush();
      const labels = [...host.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
      expect(labels).toHaveLength(7);
      expect(labels.at(-1)).toBe("ほか2件のコメントを開く");
      act(() => hostRoot.unmount());
    });

    it("keeps a comment being written visible", async () => {
      const base = props([]);
      const { host, hostRoot } = mountApp([], { panel: { ...base.panel, pendingAnchor: { type: "document" } } });
      await flush();
      expect(host.querySelector(".comment-compose-card")).not.toBeNull();
      act(() => hostRoot.unmount());
    });
  });
});
