// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { createTranslator } from "@/lib/i18n";
import type { CreatedMaterialNotice } from "./editor-shell/new-material-destination";
import { NewMaterialCreatedDialog } from "./NewMaterialCreatedDialog";

const notice: CreatedMaterialNotice = {
  kind: "material", title: "無題の教材", workspaceId: "local", workspaceName: "マイ教材", sharedItems: false,
  folderPath: ["2年", "関数"], storage: "device", origin: "previous",
};

async function renderDialog(value: CreatedMaterialNotice | null, onClose = vi.fn()) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<NewMaterialCreatedDialog notice={value} onClose={onClose} />));
  const text = (selector: string) => document.querySelector(selector)?.textContent ?? null;
  return { root, container, text, onClose };
}

describe("NewMaterialCreatedDialog", () => {
  it("names the workspace and the folder hierarchy, not just the last folder", async () => {
    const { root, container, text, onClose } = await renderDialog(notice);
    try {
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog?.textContent).toContain("教材を作成しました");
      expect(text("[data-new-material-workspace]")).toBe("マイ教材");
      expect(text("[data-new-material-folder]")).toBe("2年 / 関数");
      expect(text("[data-new-material-storage]")).toBe("このPC");
      expect(dialog?.textContent).not.toContain("既定の作成先");
      act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it("says when the material is directly under the workspace, in the cloud, or moved to the default location", async () => {
    const { root, container, text } = await renderDialog({
      ...notice, kind: "whiteboard", workspaceId: "shared-items", workspaceName: "Shared Items", sharedItems: true,
      folderPath: [], storage: "cloud", origin: "fallback",
    });
    try {
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog?.textContent).toContain("ホワイトボードを作成しました");
      expect(text("[data-new-material-workspace]")).toBe("共有アイテム");
      expect(text("[data-new-material-folder]")).toBe("ワークスペースの直下");
      expect(text("[data-new-material-storage]")).toBe("クラウド（共有）");
      expect(dialog?.textContent).toContain("直前の教材のワークスペースには作成できないため、既定の作成先に作成しました。");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it("titles a duplicate and says the copy is not shared (#250)", async () => {
    const { root, container, text } = await renderDialog({ ...notice, kind: "duplicate", title: "図つきの教材-のコピー", folderPath: [], origin: "fallback" });
    try {
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog?.textContent).toContain("教材を複製しました");
      expect(text("[data-new-material-storage]")).toBe("このPC");
      expect(dialog?.textContent).toContain("複製元の場所には作成できないため、既定の作成先に複製しました。複製した教材は共有されていません。");
      expect(dialog?.textContent).not.toContain("直前の教材");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
    const beside = await renderDialog({ ...notice, kind: "duplicate", origin: "previous" });
    try {
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain("複製した教材は共有されず、このPCに保存されます。");
    } finally {
      act(() => beside.root.unmount());
      beside.container.remove();
    }
    const t = createTranslator("en", "workspace");
    expect([t("createdDialog.duplicateTitle"), t("createdDialog.duplicateFallbackNote"), t("createdDialog.duplicatePrivateNote")]).toEqual([
      "Material duplicated",
      "The copy can't be created where the original is, so it was created in the default location. The copy is not shared.",
      "The copy is not shared; it is saved on this PC.",
    ]);
  });

  it("renders nothing without a notice", async () => {
    const { root, container } = await renderDialog(null);
    try {
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it("has English copy for every label it shows", () => {
    const t = createTranslator("en", "workspace");
    expect([
      t("createdDialog.title"), t("createdDialog.whiteboardTitle"), t("createdDialog.description"), t("createdDialog.material"),
      t("createdDialog.workspace"), t("createdDialog.folder"), t("createdDialog.storage"), t("createdDialog.root"),
      t("createdDialog.unknown"), t("createdDialog.thisPc"), t("createdDialog.thisBrowser"), t("createdDialog.cloud"),
      t("createdDialog.fallbackNote"),
    ]).toEqual([
      "Material created", "Whiteboard created", "It was created here.", "Material", "Workspace", "Folder", "Saved to",
      "Workspace root", "Unavailable", "This PC", "This browser", "Cloud (shared)",
      "New materials can't be created in the previous material's workspace, so this one was created in the default location.",
    ]);
    const chrome = createTranslator("en", "chrome");
    expect(chrome("tabs.newInWorkspace", { replace: { name: "Team" } })).toBe("Create in Team");
    expect(createTranslator("ja", "chrome")("tabs.newInWorkspace", { replace: { name: "マイ教材" } })).toBe("マイ教材に作成");
  });
});
