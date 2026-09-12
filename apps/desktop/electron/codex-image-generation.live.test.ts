import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { normalizeOverlaySnapshot, type SigmaDocument } from "@/features/document";
import { createTranslator } from "@/lib/i18n";
import { CodexAppServerClient } from "./codex-app-server-client";
import { buildCodexAgentConfigToml } from "./codex-mcp-config";
import { LocalAiEditRunContextStore } from "./ai-edit-run-context";
import { LocalSigmaDocStore } from "./local-sigma-doc-store";
import { LocalMcpEditProposalStore } from "./local-sigma-doc-proposal-store";
import { createProposalApprovalCoordinator } from "./proposal-approval";
import { runAiEditForIpc } from "./ai-edit";
import { CodexGeneratedImageStore } from "./codex-generated-images";

// Explicit opt-in: consumes the signed-in account's image generation allowance.
// Build Electron/MCP first. Auth is copied into an isolated runtime and removed in finally.
const authSource = process.env.SIGMA_STUDIO_IMAGEGEN_LIVE_AUTH;
it.skipIf(!authSource)("generates and edits an image through the real app-server, then approves and reloads both proposals", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-imagegen-live-"));
  const codexHome = path.join(directory, "codex-home");
  const codexWorkspace = path.join(directory, "codex-workspace");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(codexWorkspace, { recursive: true });
  await fs.copyFile(authSource!, path.join(codexHome, "auth.json"));
  await fs.chmod(path.join(codexHome, "auth.json"), 0o600);
  const store = new LocalSigmaDocStore(directory);
  const proposals = new LocalMcpEditProposalStore(directory);
  const imageStore = new CodexGeneratedImageStore(store.getDataDir());
  const staticContext = new LocalAiEditRunContextStore(directory, "chatgpt");
  const client = new CodexAppServerClient({ codexHome, codexWorkspace, uiLocale: "ja", configToml: buildCodexAgentConfigToml({
    execPath: process.execPath, scriptPath: path.resolve("dist-electron/sigma-doc-mcp-server.cjs"),
    userDataDir: directory, runContextFile: staticContext.getRunContextFilePath(), renderBridgeFile: path.join(directory, "unused-render-bridge.json"),
    provider: "chatgpt", uiLocale: "ja", webSearchEnabled: false,
  }) });
  try {
    const document: SigmaDocument = { version: "2.0", docId: "imagegen-live", metadata: { title: "画像生成の動作確認" },
      content: [{ id: "p_image", type: "paragraph", children: [{ type: "text", text: "りんごのイラスト" }] }],
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    };
    await store.initializeWorkspace({ initialDocument: document });
    const fileId = (await store.listFiles())[0].fileId;
    expect((await client.getStatus()).loggedIn).toBe(true);
    const models = await client.listModels();
    const model = models.models.find((entry) => entry.isDefault)?.id;
    const approval = createProposalApprovalCoordinator({ localSigmaDocStore: store, localMcpProposalStore: proposals,
      broadcastLocalStoreChange: () => {}, runPostSaveHooks: async () => {}, translate: createTranslator("ja", "error"),
    });
    let shapeId = "";
    let originalSource = "";
    let threadId: string | undefined;
    for (const step of ["generate", "edit"] as const) {
      const runId = `live_${step}`;
      const file = (await store.listFiles())[0];
      const current = (await store.loadDocument(fileId))!;
      const context = { version: 1 as const, runId, provider: "chatgpt" as const, fileId, fileRevision: file.revision,
        createdAt: new Date().toISOString(), selectedId: step === "generate" ? "p_image" : shapeId,
        references: [], attachments: [], mentionedDocuments: [], roomId: "image-live-room", turnId: runId,
      };
      await new LocalAiEditRunContextStore(directory, "chatgpt", { runId }).write(context);
      await staticContext.write(context);
      const result = await runAiEditForIpc({ codex: client, userDataPath: directory, runId, cwd: codexWorkspace, locale: "ja",
        payload: { document: current, fileId, model, selectedId: context.selectedId, agentThreadId: threadId,
          instruction: step === "generate"
            ? "Codexのネイティブ画像生成ツールで、白背景に赤いりんご1個の小さな正方形イラストを1枚だけ生成し、p_imageの下へ幅200で挿入する提案を作成してください。SVGや図形ではなく必ず画像生成ツールを使ってください。"
            : `get_image_referenceで画像${shapeId}を読み、Codexのネイティブ画像編集でりんごを緑色に変えた画像を1枚だけ作り、update_generated_imageで同じ画像を差し替える提案を作ってください。位置と表示サイズは保持してください。`,
        },
        onEvent: (event) => {
          if (event.itemType === "imageGeneration" || event.kind === "phase") console.info(step, event.message);
        },
      });
      threadId = result.agentThreadId ?? undefined;
      const images = await imageStore.list(runId);
      expect(images, result.draft.summary).toHaveLength(1);
      const pending = await proposals.listProposals({ status: "pending" });
      expect(pending, result.draft.summary).toHaveLength(1);
      expect(await store.loadDocument(fileId)).toEqual(current);
      const accepted = await approval.approveSingleProposal(pending[0].proposalId);
      expect(accepted.ok, JSON.stringify(accepted.ok ? {} : accepted)).toBe(true);
      const saved = (await store.loadDocument(fileId))!;
      const snapshot = normalizeOverlaySnapshot(saved.pageLayout?.overlay?.overlaySnapshot);
      const imageShape = snapshot.shapes.find((shape) => shape.type === "image");
      expect(imageShape?.type).toBe("image");
      if (!imageShape || imageShape.type !== "image") throw new Error("Image shape missing");
      if (step === "generate") shapeId = imageShape.id;
      else expect(imageShape.id).toBe(shapeId);
      const source = snapshot.assets[imageShape.props.assetId].props.src;
      expect(source).toBe(images[0].image.dataUrl);
      if (step === "edit") expect(source).not.toBe(originalSource);
      originalSource = source;
      await fs.writeFile(path.join(directory, `${step}.png`), Buffer.from(source.split(",")[1], "base64"));
      expect((await store.listFiles()).length).toBe(1);
    }
    console.info("Image generation smoke artifacts:", directory);
  } finally {
    client.dispose();
    await fs.rm(path.join(codexHome, "auth.json"), { force: true });
    // Test artifacts intentionally survive for visual review; authentication never does.
  }
}, 600_000);
