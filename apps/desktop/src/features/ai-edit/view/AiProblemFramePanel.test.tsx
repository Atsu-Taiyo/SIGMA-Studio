// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { DesktopAiSkillDraftEvent, DesktopAiSkillDraftRequest, DesktopAiSkillDraftResult } from "@/types/desktop";

import { problemFrameChatStore } from "../application/problem-frame-chat-store";
import { AiProblemFramePanel } from "./AiProblemFramePanel";

const connectionKinds = vi.hoisted(() => ({
  chatgpt: "unavailable",
  claude: "loggedIn",
  antigravity: "loggedOut",
}));

vi.mock("@/lib/ai/ai-connection", () => {
  const connection = (provider: "chatgpt" | "claude" | "antigravity") => ({
    state: { kind: connectionKinds[provider] },
    status: null,
    loading: false,
    refresh: () => {},
  });
  return {
    useAiConnection: () => connection("chatgpt"),
    useClaudeConnection: () => connection("claude"),
    useGeminiConnection: () => connection("antigravity"),
  };
});

const SVG = '<svg viewBox="0 0 160 100"><rect x="2" y="2" width="156" height="96" fill="none" stroke="#c0a"/></svg>';
const PREFERENCES_KEY = "sigma-studio:ai-edit-model-preferences";

interface Run {
  request: DesktopAiSkillDraftRequest;
  runId: string;
  emit: (event: DesktopAiSkillDraftEvent) => void;
  finish: (result: DesktopAiSkillDraftResult) => void;
}

let container: HTMLDivElement;
let root: Root;
let runs: Run[];
let cancel: ReturnType<typeof vi.fn>;

function installBridge() {
  runs = [];
  cancel = vi.fn(async () => ({ ok: true, cancelled: true }));
  const generate = vi.fn((
    request: DesktopAiSkillDraftRequest,
    onEvent?: (event: DesktopAiSkillDraftEvent) => void,
    onRunId?: (runId: string) => void,
  ) => new Promise<DesktopAiSkillDraftResult>((resolve) => {
    const runId = `run-${runs.length + 1}`;
    onRunId?.(runId);
    runs.push({ request, runId, emit: (event) => onEvent?.(event), finish: resolve });
  }));
  (window as { desktopAPI?: unknown }).desktopAPI = { aiSkillDraft: { generate, cancel } };
  return generate;
}

function mount(props: Partial<Parameters<typeof AiProblemFramePanel>[0]> = {}) {
  const onDrawn = (props.onDrawn ?? vi.fn()) as Mock;
  act(() => root.render(
    <AiProblemFramePanel problemId="p1" documentIdentityKey="doc" currentSvg="" onDrawn={onDrawn} {...props} />,
  ));
  return onDrawn;
}

function unmount() {
  act(() => root.render(<div />));
}

function prompt() {
  return container.querySelector<HTMLTextAreaElement>('[data-testid="problem-custom-frame-ai-prompt"]')!;
}

function setPrompt(value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(prompt(), value);
    prompt().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function sendButton() {
  return container.querySelector<HTMLButtonElement>('[data-testid="problem-custom-frame-ai-generate"]');
}

async function send(text: string) {
  setPrompt(text);
  await act(async () => sendButton()!.click());
}

async function finish(run: Run, result: DesktopAiSkillDraftResult) {
  await act(async () => {
    run.finish(result);
    await Promise.resolve();
  });
}

const testId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  connectionKinds.chatgpt = "unavailable";
  connectionKinds.claude = "loggedIn";
  connectionKinds.antigravity = "loggedOut";
  window.localStorage.removeItem(PREFERENCES_KEY);
  act(() => problemFrameChatStore.resetForTests());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as { desktopAPI?: unknown }).desktopAPI;
});

describe("AiProblemFramePanel", () => {
  it("opens as a chat in which the AI has already asked what kind of frame to draw", () => {
    installBridge();
    mount();

    expect(testId("problem-custom-frame-ai-greeting")?.textContent).toContain("どんな枠線にしますか？");
    expect(container.querySelector('[role="log"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="problem-custom-frame-ai-turn"]')).toHaveLength(0);
    expect(prompt()).not.toBeNull();
    expect(sendButton()!.disabled).toBe(true);
    expect(container.textContent).toContain("桜");
  });

  it("answers in the chat input, shows the AI's thinking and reply as they stream, and puts the drawing on the problem", async () => {
    installBridge();
    const onDrawn = mount();

    await send("ピンクの細い枠");

    expect(runs[0].request).toMatchObject({
      provider: "claude",
      model: "sonnet",
      purpose: "problemFrame",
      prompt: "ピンクの細い枠",
      context: { currentContent: "", history: [] },
    });
    // The message is in the log and the input is empty again, like any chat.
    expect(container.querySelector('[role="log"]')?.textContent).toContain("ピンクの細い枠");
    expect(prompt().value).toBe("");
    expect(testId("problem-custom-frame-ai-stop")).not.toBeNull();

    act(() => runs[0].emit({ kind: "reasoning", text: "四隅に花びらを置く" }));
    expect(testId("problem-custom-frame-ai-reasoning")?.textContent).toBe("四隅に花びらを置く");
    expect(testId("problem-custom-frame-ai-thinking")?.textContent).toContain("考えています");

    act(() => runs[0].emit({ kind: "delta", text: "ピンクの細い枠にしました。\n<svg viewBox=" }));
    expect(container.querySelector('[role="log"]')?.textContent).toContain("ピンクの細い枠にしました。");
    expect(container.querySelector('[role="log"]')?.textContent).not.toContain("<svg");
    expect(testId("problem-custom-frame-ai-thinking")?.textContent).toContain("描いています");
    expect(container.querySelector('[role="log"]')?.textContent).toContain("SVGを書いています");

    await finish(runs[0], { ok: true, text: SVG, message: "ピンクの細い枠にしました。" });

    expect(onDrawn).toHaveBeenCalledTimes(1);
    expect(onDrawn.mock.calls[0][0]).toMatchObject({ width: 160, height: 100, slice: 24, asNew: true });
    expect(onDrawn.mock.calls[0][0].svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(testId("problem-custom-frame-ai-drawing")).not.toBeNull();
    expect(testId("problem-custom-frame-ai-in-use")).not.toBeNull();
    expect(testId("problem-custom-frame-ai-generate")).not.toBeNull();
    // The thinking folds away once the answer is there, and opens again from its header.
    expect(testId("problem-custom-frame-ai-reasoning")).toBeNull();
    act(() => testId("problem-custom-frame-ai-thinking")!.querySelector("button")!.click());
    expect(testId("problem-custom-frame-ai-reasoning")?.textContent).toBe("四隅に花びらを置く");
  });

  it("sends with Enter, but not with Shift+Enter or while composing Japanese", async () => {
    const generate = installBridge();
    mount();
    setPrompt("青い枠");
    const press = (init: KeyboardEventInit) => act(() => {
      prompt().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }));
    });
    press({ shiftKey: true });
    press({ isComposing: true });
    expect(generate).not.toHaveBeenCalled();
    await act(async () => press({}));
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("continues the conversation: the next request reworks the latest drawing and carries the earlier requests", async () => {
    installBridge();
    mount();
    await send("桜の枠");
    await finish(runs[0], { ok: true, text: SVG });
    await send("もっと淡く");

    expect(runs[1].request).toMatchObject({
      prompt: "もっと淡く",
      context: { history: ["桜の枠"] },
    });
    expect(runs[1].request.context.currentContent).toContain('viewBox="0 0 160 100"');
    expect(prompt().placeholder).toContain("続けて指示できます");
  });

  it("marks a redraw as such, so the dialog updates the frame instead of adding another", async () => {
    installBridge();
    const onDrawn = mount();
    await send("桜の枠");
    await finish(runs[0], { ok: true, text: SVG });
    await send("もっと淡く");
    await finish(runs[1], { ok: true, text: SVG });
    expect(onDrawn.mock.calls.map(([drawing]) => drawing.asNew)).toEqual([true, false]);
  });

  it("offers to start from the current frame, and drops that when the reader takes the chip off", async () => {
    installBridge();
    mount({ currentSvg: SVG });
    expect(testId("problem-custom-frame-ai-greeting")?.textContent).toContain("今の枠を元に直すこともできます");
    expect(container.textContent).toContain("今の枠を元にする");

    await send("もっと太く");
    expect(runs[0].request.context.currentContent).toBe(SVG);
    await finish(runs[0], { ok: false, error: "x" });

    act(() => problemFrameChatStore.resetForTests());
    mount({ currentSvg: SVG });
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="今の枠を元にしない"]')!.click());
    expect(container.textContent).not.toContain("今の枠を元にする");
    await send("新しい枠");
    expect(runs[1].request.context.currentContent).toBe("");
  });

  it("keeps the frame and says why when the model returns something that is not a drawing", async () => {
    installBridge();
    const onDrawn = mount();
    await send("何か");
    await finish(runs[0], { ok: true, text: "枠は作れませんでした" });

    expect(onDrawn).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("枠として使える絵");
  });

  it("shows the provider's own error, and the words the model did say", async () => {
    installBridge();
    mount();
    await send("何か");
    await finish(runs[0], { ok: false, error: "生成がタイムアウトしました。", message: "少し複雑すぎました。" });

    expect(container.querySelector('[role="alert"]')?.textContent).toBe("生成がタイムアウトしました。");
    expect(container.querySelector('[role="log"]')?.textContent).toContain("少し複雑すぎました。");
  });

  it("cannot be used without the desktop bridge, and says where to connect an AI", () => {
    mount();
    expect(prompt().disabled).toBe(true);
    expect(sendButton()!.disabled).toBe(true);
    expect(container.textContent).toContain("AI設定");
  });

  it("stops the run from the same button the send button turns into", async () => {
    installBridge();
    mount();
    await send("桜");

    act(() => testId("problem-custom-frame-ai-stop")!.click());
    expect(cancel).toHaveBeenCalledWith("run-1");
    expect(container.textContent).toContain("中止しました。");
    expect(sendButton()).not.toBeNull();
  });

  it("offers the provider, model and effort in the same menu as the AI chat, and runs what was picked", async () => {
    connectionKinds.antigravity = "loggedIn";
    window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ provider: "claude", geminiModel: "gemini-x" }));
    installBridge();
    // Antigravity's own model list, as the CLI reports it.
    (window as unknown as { desktopAPI: Record<string, unknown> }).desktopAPI.gemini = {
      listModels: vi.fn(async () => ({ models: [{ id: "gemini-x", label: "Gemini X", isDefault: true }] })),
    };
    mount();

    const modelButton = testId("problem-custom-frame-ai-model-button")!;
    expect(modelButton.textContent).toContain("Claude");
    act(() => modelButton.click());
    const menu = document.body.querySelector('[role="menu"]')!;
    const provider = (name: string) => menu.querySelector<HTMLButtonElement>(`[data-testid="problem-custom-frame-ai-provider-${name}"]`)!;
    expect(provider("claude").getAttribute("aria-checked")).toBe("true");
    expect(provider("chatgpt").disabled).toBe(true);
    expect(provider("chatgpt").textContent).toContain("利用できません");
    expect(provider("antigravity").disabled).toBe(false);
    // The model and effort rows are the chat's own.
    expect(menu.textContent).toContain("モデル");
    expect(menu.textContent).toContain("エフォート");

    act(() => provider("antigravity").click());
    // The model list is asked for on the next tick and comes back asynchronously.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(testId("problem-custom-frame-ai-model-button")!.textContent).toContain("Antigravity");
    expect(testId("problem-custom-frame-ai-model-button")!.textContent).toContain("Gemini X");
    await send("青い枠");
    expect(runs[0].request).toMatchObject({ provider: "antigravity", model: "gemini-x" });
    expect(runs[0].request.reasoningEffort).toBeUndefined();
    expect(JSON.parse(window.localStorage.getItem(PREFERENCES_KEY)!)).toMatchObject({ provider: "antigravity" });
  });

  it("does not rewrite the saved chat preferences just by opening", () => {
    installBridge();
    mount();
    expect(window.localStorage.getItem(PREFERENCES_KEY)).toBeNull();
  });

  it("keeps drawing after the panel is closed, and offers the result when it is opened again", async () => {
    installBridge();
    const onDrawn = mount();
    await send("桜の枠");
    unmount(); // the dialog is closed while the AI is still working

    await finish(runs[0], { ok: true, text: SVG, message: "桜の枠です。" });
    expect(onDrawn).not.toHaveBeenCalled();
    expect(problemFrameChatStore.getNotices()).toHaveLength(1);

    const reopened = mount();
    expect(container.querySelector('[role="log"]')?.textContent).toContain("桜の枠です。");
    expect(testId("problem-custom-frame-ai-in-use")).toBeNull();
    act(() => testId("problem-custom-frame-ai-use")!.click());
    expect(reopened).toHaveBeenCalledTimes(1);
    expect(reopened.mock.calls[0][0]).toMatchObject({ width: 160, asNew: true });
    expect(testId("problem-custom-frame-ai-in-use")).not.toBeNull();
  });

  it("shows a run that is still going when the panel is opened again", async () => {
    installBridge();
    mount();
    await send("桜の枠");
    act(() => runs[0].emit({ kind: "reasoning", text: "考え中の内容" }));
    unmount();
    mount();

    expect(testId("problem-custom-frame-ai-reasoning")?.textContent).toBe("考え中の内容");
    expect(testId("problem-custom-frame-ai-stop")).not.toBeNull();
    expect(container.textContent).toContain("閉じても描き続けます");
  });

  it("tells the user what is and is not sent to the AI", () => {
    mount();
    expect(container.textContent).toContain("教材の本文は送りません");
  });
});
