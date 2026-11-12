// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AiAuthoringStylePane } from "./AiAuthoringStylePane";
import type { AuthoringStyleAPI, AuthoringStyleProfile } from "@/lib/ai/authoring-style";

it("keeps the displayed note's revision when another action returns a newer external note", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const original: AuthoringStyleProfile = { workspaceId: null, enabled: true, userContent: "画面にあるメモ", generatedContent: "特徴",
    userPath: "/user.md", generatedPath: "/learned.md", revision: "original", generatedEdited: false, exampleCount: 1, evidenceRevision: "evidence", needsSynthesis: false };
  const save = vi.fn<AuthoringStyleAPI["save"]>().mockRejectedValue(new Error("Style note changed"));
  const api: AuthoringStyleAPI = {
    read: vi.fn().mockResolvedValue(original), save,
    setEnabled: vi.fn().mockResolvedValue({ ...original, enabled: false, userContent: "外部で編集したメモ", revision: "external" }),
    reset: vi.fn().mockResolvedValue(original),
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<AiAuthoringStylePane id="style" api={api} workspaceId={null} />));
    await act(async () => host.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(host.querySelector<HTMLTextAreaElement>("#authoring-style-note")!.value).toBe("画面にあるメモ");
    const saveButton = [...host.querySelectorAll("button")].find(b => b.textContent === "メモを保存")!;
    await act(async () => saveButton.click());
    expect(save).toHaveBeenCalledWith({ workspaceId: null, content: "画面にあるメモ", expectedRevision: "original" });
    expect(host.textContent).toContain("読み込み・保存に失敗");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
