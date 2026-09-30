// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { ProblemNode, SigmaDocument } from "@/features/document";
import { PROBLEM_FRAME_LIBRARY_STORAGE_KEY } from "@/lib/problem-frame-library";
import type { DesktopAiSkillDraftResult } from "@/types/desktop";

import { problemFrameChatStore } from "../application/problem-frame-chat-store";
import { ProblemFrameChatNotices } from "./ProblemFrameChatNotices";

const SVG = '<svg viewBox="0 0 160 100"><rect x="2" y="2" width="156" height="96" fill="none" stroke="#c0a"/></svg>';
const KEY = "doc\u0000p1";
const PROBLEM = { type: "problem", id: "p1", tags: [], lead: [], prompt: [], solution: [], hints: [] } as unknown as ProblemNode;
const DOCUMENT = { content: [PROBLEM] } as unknown as SigmaDocument;

let container: HTMLDivElement;
let root: Root;
let finishRun: (result: DesktopAiSkillDraftResult) => void;

function startRun(problemId = "p1", documentIdentityKey = "doc") {
  (window as { desktopAPI?: unknown }).desktopAPI = {
    aiSkillDraft: {
      cancel: vi.fn(),
      generate: (...args: unknown[]) => {
        (args[2] as ((runId: string) => void) | undefined)?.("run-1");
        return new Promise<DesktopAiSkillDraftResult>((resolve) => { finishRun = resolve; });
      },
    },
  };
  problemFrameChatStore.send({
    key: `${documentIdentityKey}\u0000${problemId}`,
    documentIdentityKey,
    problemId,
    instruction: "桜の枠",
    provider: "claude",
    baseSvg: "",
  });
}

async function finish(result: DesktopAiSkillDraftResult) {
  await act(async () => {
    finishRun(result);
    await Promise.resolve();
  });
}

function mount(props: Partial<Parameters<typeof ProblemFrameChatNotices>[0]> = {}) {
  const onChange = (props.onChange ?? vi.fn()) as Mock;
  act(() => root.render(
    <ProblemFrameChatNotices documentIdentityKey="doc" document={DOCUMENT} onChange={onChange} {...props} />,
  ));
  return onChange;
}

const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
const useButton = () => document.body.querySelector<HTMLButtonElement>('[data-testid="problem-custom-frame-ai-notice-use"]');
const buttonByText = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === text);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  window.localStorage.removeItem(PROBLEM_FRAME_LIBRARY_STORAGE_KEY);
  act(() => problemFrameChatStore.resetForTests());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as { desktopAPI?: unknown }).desktopAPI;
});

describe("ProblemFrameChatNotices", () => {
  it("says nothing while nothing has finished, or when what finished belongs to another document", async () => {
    mount();
    expect(dialog()).toBeNull();

    act(() => startRun("p9", "other-doc"));
    await finish({ ok: true, text: SVG });
    expect(problemFrameChatStore.getNotices()).toHaveLength(1);
    expect(dialog()).toBeNull();
  });

  it("tells the reader a frame is ready after the dialog was closed, and puts it on the problem when asked", async () => {
    const onChange = mount();
    act(() => startRun());
    await finish({ ok: true, text: SVG, message: "桜を四隅に入れました。" });

    expect(dialog()?.textContent).toContain("枠を描き終えました");
    expect(dialog()?.textContent).toContain("桜を四隅に入れました。");
    expect(dialog()?.querySelector("img")?.getAttribute("src")).toContain("data:image/svg+xml");

    act(() => useButton()!.click());

    expect(onChange).toHaveBeenCalledTimes(1);
    const [blockId, updater] = onChange.mock.calls[0];
    expect(blockId).toBe("p1");
    const updated = updater(PROBLEM);
    expect(updated.frame).toMatchObject({ enabled: true, styleId: "custom", custom: { width: 160, height: 100, slice: 24 } });
    // It is kept on the shelf of the user's own frames, as every frame put on a problem is.
    expect(JSON.parse(window.localStorage.getItem(PROBLEM_FRAME_LIBRARY_STORAGE_KEY)!)).toHaveLength(1);
    expect(problemFrameChatStore.getSession(KEY)?.appliedTurnId).not.toBeNull();
    expect(problemFrameChatStore.getNotices()).toEqual([]);
    expect(dialog()).toBeNull();
  });

  it("closes without touching the problem, and the drawing stays in the conversation", async () => {
    const onChange = mount();
    act(() => startRun());
    await finish({ ok: true, text: SVG });

    act(() => buttonByText("閉じる")!.click());

    expect(onChange).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(PROBLEM_FRAME_LIBRARY_STORAGE_KEY)).toBeNull();
    expect(dialog()).toBeNull();
    const turn = problemFrameChatStore.getSession(KEY)!.turns.at(-1)!;
    expect(turn.role === "assistant" && turn.drawing).toBeTruthy();
  });

  it("reports a failure without offering to use anything", async () => {
    mount();
    act(() => startRun());
    await finish({ ok: false, error: "生成がタイムアウトしました。" });

    expect(dialog()?.textContent).toContain("枠を描けませんでした");
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe("生成がタイムアウトしました。");
    expect(useButton()).toBeNull();
  });

  it("does not offer to use a frame on a problem that has since been deleted", async () => {
    mount({ document: { content: [] } as unknown as SigmaDocument });
    act(() => startRun());
    await finish({ ok: true, text: SVG });

    expect(dialog()?.textContent).toContain("枠を描き終えました");
    expect(useButton()).toBeNull();
  });

  it("shows that a frame is being drawn while nobody is looking at the conversation, and can stop it", async () => {
    const cancel = vi.fn(async () => ({ ok: true, cancelled: true }));
    mount();
    act(() => startRun());
    (window as { desktopAPI?: { aiSkillDraft: { cancel: unknown } } }).desktopAPI!.aiSkillDraft.cancel = cancel;
    const busy = () => document.body.querySelector<HTMLElement>('[data-testid="problem-custom-frame-ai-busy"]');
    expect(busy()?.textContent).toContain("枠を描いています");

    act(() => busy()!.querySelector("button")!.click());
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(busy()).toBeNull();
  });

  it("shows no status for a conversation that is on screen, or for another document's run", async () => {
    mount();
    let unwatch = () => {};
    act(() => { unwatch = problemFrameChatStore.watch(KEY, () => {}); });
    act(() => startRun());
    expect(document.body.querySelector('[data-testid="problem-custom-frame-ai-busy"]')).toBeNull();
    act(() => unwatch());
    expect(document.body.querySelector('[data-testid="problem-custom-frame-ai-busy"]')).not.toBeNull();
    await finish({ ok: false, error: "x" });
    expect(document.body.querySelector('[data-testid="problem-custom-frame-ai-busy"]')).toBeNull();

    act(() => startRun("p9", "other-doc"));
    expect(document.body.querySelector('[data-testid="problem-custom-frame-ai-busy"]')).toBeNull();
  });

  it("shows one notice at a time", async () => {
    mount();
    act(() => startRun());
    await finish({ ok: true, text: SVG, message: "一つ目" });
    act(() => startRun());
    await finish({ ok: true, text: SVG, message: "二つ目" });

    expect(dialog()?.textContent).toContain("一つ目");
    act(() => buttonByText("閉じる")!.click());
    expect(dialog()?.textContent).toContain("二つ目");
  });
});
