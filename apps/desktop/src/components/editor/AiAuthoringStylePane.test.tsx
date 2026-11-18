// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AiAuthoringStylePane } from "./AiAuthoringStylePane";
import type { AuthoringStyleAPI, AuthoringStyleProfile } from "@/lib/ai/authoring-style";

const base: AuthoringStyleProfile = { workspaceId: null, enabled: true, aiSummary: true, aiSummaryProvider: null, userContent: "画面にあるメモ", userPath: "/user.md", revision: "original",
  generatedContent: "", generatedPath: "", generatedRevision: "", exampleCount: 1, items: [], pending: [], usage: { characters: 0, limit: 3000 },
  outcomes: { kept: 0, edited: 0, reverted: 0, rejected: 0 }, lastReviewedAt: null, reviewedDocuments: 0, lastUpdate: null, autoApply: true, autoChanges: [], canUndo: false, blockedLines: 0, memberEntries: [],
  sync: { available: true, signedIn: true, pro: true, scope: "account", enabled: false, state: "off", lastSyncedAt: null, manage: true, wide: null } };

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
  return { read: resolved(), save: resolved(), saveLearned: resolved(), setEnabled: resolved(), setAiSummary: resolved(), setAutoApply: resolved(), revertAutoChange: resolved(), reset: resolved(), review: resolved(), resolvePending: resolved(), removeItem: resolved(), undo: resolved(), resolveMemberEntries: resolved(), setSync: resolved(), syncNow: resolved(), relinkSync: resolved(), deleteSynced: resolved(), ...overrides };
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
  const profile: AuthoringStyleProfile = { ...base, workspaceId: "ws1", generatedContent: "# 学んだ書き方\n- 解説・説明は常体（だ・である）で書く。\n- 要点を先に述べる。\n", generatedRevision: "memo1", generatedPath: "/learned.md",
    items: [{ id: "auto:tone.explanation", section: "style", text: "解説・説明は常体（だ・である）で書く。", origin: "auto", basis: "writing", support: 4, documents: 2, firstSeenAt: "", lastConfirmedAt: "" },
      { id: "auto:summary.style:1", section: "style", text: "要点を先に述べる。", origin: "auto", basis: "summary", support: 3, documents: 3, firstSeenAt: "2026-11-17T00:00:00Z", lastConfirmedAt: "" }],
    pending: [{ id: "rewrite:tone.explanation", kind: "rewrite", reason: "contradicted", currentText: "常体で書く。", proposedText: "丁寧体で書く。", support: 3 },
      { id: "add:summary.style:2", kind: "add", reason: "limit", currentText: "", proposedText: "結論を先に書く。", support: 2 }],
    outcomes: { kept: 5, edited: 2, reverted: 1, rejected: 3 }, canUndo: true, lastUpdate: { at: "", added: 1, staged: 1 }, blockedLines: 2 };
  const api = fakeApi({}, profile);
  const view = mount(api, "ws1");
  try {
    await view.render();
    expect(view.host.querySelector<HTMLTextAreaElement>("#authoring-style-learned")!.value).toBe(profile.generatedContent);
    for (const text of ["そのまま 5・手直し 2・取り消し 1 / 却下した提案 3", "自分の文章 4箇所・教材2件", "AIによる要約・教材3件", "書き換え: 「常体で書く。」→「丁寧体で書く。」（根拠3箇所）", "追加: 「結論を先に書く。」（メモが上限に達しているため保留。根拠2箇所）", "AIが追加した項目", "1項目を追加、0件を書き換え、0件を削除、1件が確認待ち", "2行あり、AIへは渡していません"]) {
      expect(view.host.textContent).toContain(text);
    }
    await act(async () => view.button("反映する").click());
    expect(api.resolvePending).toHaveBeenCalledWith({ workspaceId: "ws1", id: "rewrite:tone.explanation", approve: true });
    await act(async () => view.button("見送る").click());
    expect(api.resolvePending).toHaveBeenLastCalledWith({ workspaceId: "ws1", id: "rewrite:tone.explanation", approve: false });
    await act(async () => view.host.querySelectorAll<HTMLButtonElement>('[role="switch"]')[1].click());
    expect(api.setAiSummary).toHaveBeenCalledWith("ws1", false);
    // An item the AI added is marked as such and can be removed on the spot, by its id.
    expect([...view.host.querySelectorAll("li")].filter(li => li.textContent!.includes("AIが追加")).map(li => li.textContent!.includes("要点を先に述べる。"))).toEqual([true, true]);
    await act(async () => view.host.querySelector<HTMLButtonElement>('[aria-label="「要点を先に述べる。」を削除"]')!.click());
    expect(api.removeItem).toHaveBeenCalledWith({ workspaceId: "ws1", id: "auto:summary.style:1" });
    await act(async () => view.button("今すぐ見直す").click());
    expect(api.review).toHaveBeenCalledWith("ws1");
    await act(async () => view.button("1つ前に戻す").click());
    expect(api.undo).toHaveBeenCalledWith("ws1");
    expect(view.button("学んだ書き方を保存").disabled).toBe(true);
  } finally { await view.unmount(); }
});

it("lists what the review changed by itself, lets one change be put back, and has a switch for doing so without asking", async () => {
  const profile: AuthoringStyleProfile = { ...base, workspaceId: "ws1", generatedContent: "- 丁寧体で書く。\n", generatedRevision: "memo1",
    lastUpdate: { at: "", added: 0, staged: 0, rewritten: 1, removed: 1 },
    autoChanges: [{ id: "rewrite:1", kind: "rewrite", reason: "contradicted", at: "2026-11-17T00:00:00Z", before: "常体で書く。", after: "丁寧体で書く。" },
      { id: "remove:2", kind: "remove", reason: "stale", at: "2026-11-18T00:00:00Z", before: "分数は大きく書く。", after: "" }] };
  const api = fakeApi({}, profile);
  const view = mount(api, "ws1");
  try {
    await view.render();
    const list = view.host.querySelector('[data-testid="authoring-style-auto-changes"]')!;
    // Newest first.
    expect([...list.querySelectorAll("li")].map(li => li.querySelector("span")!.textContent)).toEqual(["削除: 「分数は大きく書く。」", "書き換え: 「常体で書く。」→「丁寧体で書く。」"]);
    for (const text of ["自動で反映した変更", "最近は確認できないため", "最近の書き方と食い違ったため", "0項目を追加、1件を書き換え、1件を削除、0件が確認待ち"]) expect(view.host.textContent).toContain(text);
    await act(async () => view.host.querySelector<HTMLButtonElement>('[aria-label="「常体で書く。」を元に戻す"]')!.click());
    expect(api.revertAutoChange).toHaveBeenCalledWith({ workspaceId: "ws1", id: "rewrite:1" });
    const switches = view.host.querySelectorAll<HTMLButtonElement>('[role="switch"]');
    expect(switches[2].getAttribute("aria-checked")).toBe("true");
    await act(async () => switches[2].click());
    expect(api.setAutoApply).toHaveBeenCalledWith("ws1", false);
  } finally { await view.unmount(); }
  // Nothing was changed: no list.
  const none = mount(fakeApi({}, { ...profile, autoChanges: [] }), "ws1");
  try {
    await none.render();
    expect(none.host.querySelector('[data-testid="authoring-style-auto-changes"]')).toBeNull();
  } finally { await none.unmount(); }
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

it("offers account sync only on the global page, says what state it is in, and asks before deleting the server's copy", async () => {
  const synced: AuthoringStyleProfile = { ...base, sync: { ...base.sync, enabled: true, state: "other-account" } };
  const relinkSync = vi.fn<AuthoringStyleAPI["relinkSync"]>().mockResolvedValue({ ...synced, sync: { ...synced.sync, state: "ok" } });
  const deleteSynced = vi.fn<AuthoringStyleAPI["deleteSynced"]>().mockResolvedValue(base);
  const view = mount(fakeApi({ relinkSync, deleteSynced }, synced), null);
  try {
    await view.render();
    expect(view.host.textContent).toContain("別のアカウントと同期していました");
    expect(view.button("今すぐ同期")).toBeUndefined();
    expect(view.button("サーバーのデータを削除").disabled).toBe(true);
    await act(async () => view.button("このアカウントと同期し直す").click());
    expect(relinkSync).toHaveBeenCalledWith(null);
    expect(view.host.textContent).toContain("同期しています。");
    await act(async () => view.button("サーバーのデータを削除").click());
    expect(deleteSynced).not.toHaveBeenCalled();
    const confirm = [...document.body.querySelectorAll("button")].filter(b => b.textContent === "サーバーのデータを削除").at(-1)!;
    await act(async () => confirm.click());
    expect(deleteSynced).toHaveBeenCalledWith(null);
    expect(view.host.textContent).toContain("同期していません。");
  } finally { await view.unmount(); }

  const workspace = mount(fakeApi({}, { ...synced, workspaceId: "ws1" }), "ws1");
  try {
    await workspace.render();
    expect(workspace.host.textContent).not.toContain("書き方をアカウントで同期する");
  } finally { await workspace.unmount(); }

  const unavailable = mount(fakeApi({}, { ...base, sync: { ...base.sync, available: false, state: "unavailable" } }), null);
  try {
    await unavailable.render();
    expect(unavailable.host.textContent).not.toContain("書き方をアカウントで同期する");
  } finally { await unavailable.unmount(); }
});

it("shows that sync is for Pro and cannot be turned on without it, while the rest of the page keeps working", async () => {
  const free: AuthoringStyleProfile = { ...base, sync: { ...base.sync, pro: false, enabled: false, state: "pro-required" } };
  const view = mount(fakeApi({}, free), null);
  try {
    await view.render();
    expect(view.host.textContent).toContain("アカウントで同期する（Pro）");
    expect(view.host.textContent).toContain("同期は Pro プランの機能です。");
    const toggle = [...view.host.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button[role=switch], input[type=checkbox]")].find(el => el.getAttribute("aria-label") === "アカウントで同期する（Pro）" || el.closest("label")?.textContent?.includes("アカウントで同期する（Pro）"))!;
    expect(toggle.disabled).toBe(true);
    expect(view.host.querySelector<HTMLTextAreaElement>("#authoring-style-note")!.disabled).toBe(false);
  } finally { await view.unmount(); }
});

it("says on a workspace's page whether that workspace is synced or stays on this device", async () => {
  for (const [scope, text] of [["shared", "あなたの変更はほかのメンバーにも届きます"], ["shared-view", "この端末での変更はほかのメンバーには反映されません"], ["device", "この端末だけに保存されます"]] as const) {
    const view = mount(fakeApi({}, { ...base, workspaceId: "ws1", sync: { ...base.sync, scope } }), "ws1");
    try {
      await view.render();
      expect(view.host.textContent).toContain(text);
      // The switch itself is on the account's page only.
      expect(view.host.textContent).not.toContain("アカウントで同期する（Pro）");
    } finally { await view.unmount(); }
  }
});

it("lists what other members wrote for approval, one by one or all at once", async () => {
  const profile: AuthoringStyleProfile = { ...base, workspaceId: "ws1", sync: { ...base.sync, scope: "shared", manage: true, wide: { enabled: true, aiSummary: true } },
    memberEntries: [{ id: "m1", kind: "item", text: "解説・説明は常体（だ・である）で書く。", declined: false }, { id: "m2", kind: "note", text: "図は必ず右に置く。", declined: false },
      { id: "m3", kind: "note", text: "使わないと決めた行。", declined: true }] };
  const api = fakeApi({}, profile);
  const view = mount(api, "ws1");
  try {
    await view.render();
    for (const text of ["ほかのメンバーが書いた項目（承認待ち 2件）", "あなたが承認するまで、あなたのAIには渡しません", "学んだ項目", "メモ", "使わないことにした項目（1件）", "あなたはオーナーまたは管理者です"]) {
      expect(view.host.textContent).toContain(text);
    }
    await act(async () => view.host.querySelector<HTMLButtonElement>('[aria-label="「図は必ず右に置く。」を承認する"]')!.click());
    expect(api.resolveMemberEntries).toHaveBeenLastCalledWith({ workspaceId: "ws1", ids: ["m2"], approve: true });
    await act(async () => view.host.querySelector<HTMLButtonElement>('[aria-label="「解説・説明は常体（だ・である）で書く。」を使わない"]')!.click());
    expect(api.resolveMemberEntries).toHaveBeenLastCalledWith({ workspaceId: "ws1", ids: ["m1"], approve: false });
    await act(async () => view.button("すべて承認する").click());
    expect(api.resolveMemberEntries).toHaveBeenLastCalledWith({ workspaceId: "ws1", ids: ["m1", "m2"], approve: true });
    // What was declined can still be approved after all, and is not part of "all".
    await act(async () => view.host.querySelector<HTMLButtonElement>('[aria-label="「使わないと決めた行。」を承認する"]')!.click());
    expect(api.resolveMemberEntries).toHaveBeenLastCalledWith({ workspaceId: "ws1", ids: ["m3"], approve: true });
  } finally { await view.unmount(); }
});

it("leaves the reset and the switches that hold for everyone to a shared workspace's owner and admins", async () => {
  const member: AuthoringStyleProfile = { ...base, workspaceId: "ws1", aiSummary: false, sync: { ...base.sync, scope: "shared", manage: false, wide: { enabled: true, aiSummary: false } } };
  const api = fakeApi({}, member);
  const view = mount(api, "ws1");
  try {
    await view.render();
    expect(view.host.textContent).toContain("全員分のリセットは、オーナーと管理者だけができます");
    expect(view.host.textContent).toContain("このワークスペース全体でオフにしています: AIによる要約");
    expect(view.button("学習をリセット").disabled).toBe(true);
    const [learning, summary] = view.host.querySelectorAll<HTMLButtonElement>('[role="switch"]');
    // Off for everyone cannot be turned on here; what is on for everyone can be turned off for this device.
    expect(summary.disabled).toBe(true);
    expect(learning.disabled).toBe(false);
    await act(async () => learning.click());
    expect(api.setEnabled).toHaveBeenCalledWith("ws1", false);
  } finally { await view.unmount(); }
});
