// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AiAuthoringStylePane } from "./AiAuthoringStylePane";
import type { AuthoringStyleAPI, AuthoringStyleProfile } from "@/lib/ai/authoring-style";

const base: AuthoringStyleProfile = { workspaceId: null, enabled: true, userContent: "画面にあるメモ", userPath: "/user.md", revision: "original",
  generatedContent: "", generatedPath: "", generatedRevision: "", exampleCount: 1, items: [], pending: [], usage: { characters: 0, limit: 3000 },
  outcomes: { kept: 0, edited: 0, reverted: 0, rejected: 0 }, lastReviewedAt: null, reviewedDocuments: 0, lastUpdate: null, canUndo: false, blockedLines: 0 };

function mount(api: AuthoringStyleAPI, workspaceId: string | null) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const button = (label: string) => [...host.querySelectorAll("button")].find(b => b.textContent === label)!;
  return { host, button, render: () => act(async () => root.render(<AiAuthoringStylePane id="style" api={api} workspaceId={workspaceId} />)),
    unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

function fakeApi(overrides: Partial<AuthoringStyleAPI>, profile: AuthoringStyleProfile): AuthoringStyleAPI {
  const resolved = () => vi.fn().mockResolvedValue(profile);
  return { read: resolved(), save: resolved(), saveLearned: resolved(), setEnabled: resolved(), reset: resolved(), review: resolved(), resolvePending: resolved(), undo: resolved(), ...overrides };
}

it("keeps the displayed note's revision when another action returns a newer external note", async () => {
  const save = vi.fn<AuthoringStyleAPI["save"]>().mockRejectedValue(new Error("Style note changed"));
  const api = fakeApi({ save, setEnabled: vi.fn().mockResolvedValue({ ...base, enabled: false, userContent: "外部で編集したメモ", revision: "external" }) }, base);
  const view = mount(api, null);
  try {
    await view.render();
    await act(async () => view.host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(view.host.querySelector<HTMLTextAreaElement>("#authoring-style-note")!.value).toBe("画面にあるメモ");
    expect(view.host.querySelector("#authoring-style-learned")).toBeNull();
    await act(async () => view.button("メモを保存").click());
    expect(save).toHaveBeenCalledWith({ workspaceId: null, content: "画面にあるメモ", expectedRevision: "original" });
    expect(view.host.textContent).toContain("読み込み・保存に失敗");
  } finally { await view.unmount(); }
});

it("shows the learned memo with its evidence and lets the user decide staged changes", async () => {
  const profile: AuthoringStyleProfile = { ...base, workspaceId: "ws1", generatedContent: "# 学んだ書き方\n- 解説・説明は常体（だ・である）で書く。\n", generatedRevision: "memo1", generatedPath: "/learned.md",
    items: [{ id: "auto:tone.explanation", section: "style", text: "解説・説明は常体（だ・である）で書く。", origin: "auto", basis: "writing", support: 4, documents: 2, status: "active", lastConfirmedAt: "" }],
    pending: [{ id: "rewrite:tone.explanation", kind: "rewrite", reason: "contradicted", currentText: "常体で書く。", proposedText: "丁寧体で書く。", support: 3 }],
    outcomes: { kept: 5, edited: 2, reverted: 1, rejected: 3 }, canUndo: true, lastUpdate: { at: "", added: 1, staged: 1 }, blockedLines: 2 };
  const api = fakeApi({}, profile);
  const view = mount(api, "ws1");
  try {
    await view.render();
    expect(view.host.querySelector<HTMLTextAreaElement>("#authoring-style-learned")!.value).toBe(profile.generatedContent);
    for (const text of ["そのまま 5・手直し 2・取り消し 1 / 却下した提案 3", "自分の文章 4箇所・教材2件", "書き換え: 「常体で書く。」→「丁寧体で書く。」（根拠3箇所）", "1項目を追加、1件が確認待ち", "2行あり、AIへは渡していません"]) {
      expect(view.host.textContent).toContain(text);
    }
    await act(async () => view.button("反映する").click());
    expect(api.resolvePending).toHaveBeenCalledWith({ workspaceId: "ws1", id: "rewrite:tone.explanation", approve: true });
    await act(async () => view.button("見送る").click());
    expect(api.resolvePending).toHaveBeenLastCalledWith({ workspaceId: "ws1", id: "rewrite:tone.explanation", approve: false });
    await act(async () => view.button("今すぐ見直す").click());
    expect(api.review).toHaveBeenCalledWith("ws1");
    await act(async () => view.button("1つ前に戻す").click());
    expect(api.undo).toHaveBeenCalledWith("ws1");
    expect(view.button("学んだ書き方を保存").disabled).toBe(true);
  } finally { await view.unmount(); }
});

it("keeps an unsaved manual note when only the learned memo is saved", async () => {
  const profile: AuthoringStyleProfile = { ...base, workspaceId: "ws1", generatedContent: "- 学んだ行\n", generatedRevision: "memo1" };
  const saveLearned = vi.fn<AuthoringStyleAPI["saveLearned"]>().mockResolvedValue({ ...profile, generatedContent: "- 自分の行\n", generatedRevision: "memo2" });
  const view = mount(fakeApi({ saveLearned }, profile), "ws1");
  const type = (selector: string, value: string) => act(async () => {
    const field = view.host.querySelector<HTMLTextAreaElement>(selector)!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  try {
    await view.render();
    await type("#authoring-style-note", "書きかけのメモ");
    await type("#authoring-style-learned", "- 自分の行");
    await act(async () => view.button("学んだ書き方を保存").click());
    expect(saveLearned).toHaveBeenCalledWith({ workspaceId: "ws1", content: "- 自分の行", expectedRevision: "memo1" });
    expect(view.host.querySelector<HTMLTextAreaElement>("#authoring-style-note")!.value).toBe("書きかけのメモ");
    expect(view.host.querySelector<HTMLTextAreaElement>("#authoring-style-learned")!.value).toBe("- 自分の行\n");
  } finally { await view.unmount(); }
});
