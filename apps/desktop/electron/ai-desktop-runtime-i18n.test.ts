import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setAppLocale } from "@/lib/i18n";
import { LocalAiEditChatRoomStore } from "./ai-edit-chat-room-store";
import { AiEditAttachmentItemSchema } from "./ai-edit-run-context";
import { LocalAiResourceStore } from "./ai-resource-store";
import { resolvePageContextCapturePage } from "./ai-render-bridge";
import { generateAiSkillDraft } from "./ai-skill-draft";

describe("Electron AI runtime i18n", () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-ai-runtime-i18n-"));
  });

  afterEach(async () => {
    setAppLocale("ja");
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("resolves execution errors in the locale active when each operation runs", async () => {
    const resources = new LocalAiResourceStore(userDataDir);
    const chatRooms = new LocalAiEditChatRoomStore(userDataDir);

    setAppLocale("en");
    await expect(generateAiSkillDraft({
      provider: "chatgpt",
      prompt: "",
      context: { title: "", description: "", currentContent: "" },
    }, {} as never, "run_en")).resolves.toEqual({ ok: false, error: "Enter an instruction for the AI." });
    const resourceTree = await resources.getTree();
    expect(resourceTree.resources.find((resource) => resource.id === "global-instructions")?.title)
      .toBe("グローバル指示");
    expect(resourceTree.resources.find((resource) => resource.id === "official-image-material")?.title)
      .toBe("画像からSigma Studio教材を作成");
    await expect(resources.readFile("missing")).rejects.toThrow("The AI resource was not found.");
    await expect(chatRooms.deleteRoom("")).resolves.toEqual({ ok: false, error: "The AI chat history has no ID." });
    expect(resolvePageContextCapturePage({
      requestedPageIndex: 0,
      pageCount: 0,
      targetId: null,
      anchorBlockFound: false,
      anchorPageIndex: null,
    })).toEqual({ ok: false, error: "There are no pages to render." });
    expect(AiEditAttachmentItemSchema.safeParse({
      id: "attachment_1",
      name: "bad.png",
      mimeType: "image/png",
      dataUrl: "invalid",
    }).error?.issues[0]?.message).toBe("The dataUrl format is invalid.");

    setAppLocale("ja");
    await expect(chatRooms.deleteRoom("")).resolves.toEqual({ ok: false, error: "AI会話履歴のIDがありません。" });
    expect(resolvePageContextCapturePage({
      requestedPageIndex: 0,
      pageCount: 0,
      targetId: null,
      anchorBlockFound: false,
      anchorPageIndex: null,
    })).toEqual({ ok: false, error: "レンダリング対象のページがありません。" });
  });
});
