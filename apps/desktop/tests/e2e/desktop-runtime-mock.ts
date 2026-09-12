import type { Page } from "@playwright/test";

import type { SigmaDocument } from "@/types/sigma-doc";
import type { MaterialItem } from "@/types/material";
import type { TemplateItem } from "@/types/template";
import type { LedgerSchemaFailure } from "@/lib/library-schema";
import type { DocumentVersion, DocumentVersionMetadata } from "@/lib/document-version-history";
import type {
  DesktopAiEditChatRoom,
  DesktopMcpEditProposalListOptions,
  DesktopMcpEditProposalSummary,
  DesktopStorageChangeEvent,
} from "@/types/desktop";

export interface DesktopRuntimeMockAiOptions {
  /**
   * Unlocks the AI panel (codex/claude/gemini report available+loggedIn) and
   * replaces the stub `aiEdit` with an in-memory chat-room store plus a fake
   * streaming run. Instruction keywords control each run:
   * - "SLOW" → run lasts ~15s (default ~3s)
   * - "FAIL" → run rejects at the end (after ~2s, or ~15s when combined with "SLOW")
   * - "PROPOSAL" → on success, a pending MCP edit proposal targeting the run's
   *   selected block is stored and a storage `mcpProposal` change event fires
   *   (exercises the in-body proposal preview card).
   * - "PROPOSAL FORMAT" → replaces the selected paragraph with the same inline
   *   content plus a bold mark, exercising a formatting-only pending diff.
   * - "PROPOSAL PROBLEM" → inserts a framed problem with prompt and solution
   *   after the selected block, exercising the shared paper/print preview path.
   * - Add "MATH_BREAK" to "PROPOSAL" to replace the selected paragraph with
   *   the same inline-math id but a two-line `aligned` expression. This covers
   *   authoritative AI updates to an already-mounted math node view.
   * - "PROPOSAL SHAPE" → instead of the default replace/insert draft, the
   *   pending proposal's draft carries a single `updateOverlayShape`
   *   mutationOperation against the document's first overlay shape (see
   *   `ensureOverlayShapeFixture` below, which synthesizes one anchored to a
   *   body block when the test document doesn't already define one) —
   *   exercises the shape-mutation inline preview card / ghost / ai-diff
   *   classes instead of the text-replace path.
   * - Add "INSERT" or "DELETE" to "PROPOSAL SHAPE" to exercise the
   *   corresponding green insertion or red deletion preview.
   * - "PROPOSAL SHAPE REPLACE" emits a same-run delete + insert pair whose
   *   insert requested the deleted id, exercising one atomic replacement UI.
   * Every accepted run payload is appended to `window.__aiEditRunPayloads` for
   * assertions (instruction, agentThreadId, provider, selectedId, references).
   */
  enabled: boolean;
  /** An image proposal fixture for browser-level approval/preview tests. */
  generatedImageFixture?: {
    draft: DesktopMcpEditProposalSummary["draft"];
    changedIds: string[];
    imageId: string;
    dataUrl: string;
    previewDataUrl: string;
  };
  /** Simulates a compatible bridge that returns the approved document without
   * the optional file metadata in the batch-approval result. */
  omitBatchApproveFileMetadata?: boolean;
}

/**
 * 教材の中身が原因で本文を組み立てられない状態を再現する。
 * `window.__sigmaRepairFailedDocument()` を呼ぶと「AIが直した」状態になり、
 * 以降の読み込みは成功する (失敗画面の再読み込み導線を検証するため)。
 */
export interface DesktopRuntimeMockDocumentLoadFailure {
  error: string;
  failureKind?: "schema" | "json";
  failures?: Array<{
    path: string;
    message: string;
    code?: string;
    expected?: string;
    received?: string;
  }>;
  documentPath?: string;
  title?: string;
}

export interface DesktopRuntimeMockOptions {
  materials?: MaterialItem[];
  templates?: TemplateItem[];
  ai?: DesktopRuntimeMockAiOptions;
  storageLoadDelayMs?: number;
  platform?: NodeJS.Platform;
  preserveAiModelPreferences?: boolean;
  /**
   * Extra `localStorage` keys to carry across a reload.
   *
   * The mock wipes storage on every page load so tests start clean, which also erases anything the
   * app deliberately keeps there. A test about surviving a restart has to opt its key out.
   */
  preserveStorageKeys?: readonly string[];
  /**
   * Initial UI layout preference, seeded right after storage is wiped.
   *
   * The default is the Google-Docs-style chrome with onboarding already completed. Leaving
   * `onboardingCompleted` at its stored default of `false` would put the first-run UI picker on
   * top of every single spec, so a spec that wants the picker has to ask for it explicitly.
   */
  uiLayout?: { mode?: "docs" | "word"; onboardingCompleted?: boolean };
  documentLoadFailure?: DesktopRuntimeMockDocumentLoadFailure;
  ledgerSchemaFailure?: LedgerSchemaFailure;
  /**
   * 自分の保存でも fs watcher の通知を返す。
   *
   * **実機はこれが常に起きる** — main の store はファイルを書けば watcher が発火し、
   * 保存した本人にも `storage:changed` が返る。レンダラがそれを「外部変更」と誤読すると
   * `documentHistory.clear()` まで走る (WI-4 の症状)。
   *
   * 既定 off なのは、この通知が既存 spec の想定していない再入を増やすため。**この経路を
   * 測る spec だけが on にする** (= 既定の mock はこのクラスの不具合を再現しない、という
   * 限界がここにある)。
   */
  emitWatcherEventOnSave?: boolean;
}

export async function installDesktopRuntimeMock(
  page: Page,
  document: SigmaDocument,
  options: DesktopRuntimeMockOptions = {},
): Promise<void> {
  await page.addInitScript(({ initialDocument, initialMaterials, initialTemplates, aiEnabled, generatedImageFixture, omitBatchApproveFileMetadata, storageLoadDelayMs, runtimePlatform, preserveAiModelPreferences, preserveStorageKeys, initialUiLayout, initialDocumentLoadFailure, initialLedgerSchemaFailure, emitWatcherEventOnSave }: {
    initialDocument: SigmaDocument;
    initialMaterials: MaterialItem[];
    initialTemplates: TemplateItem[];
    aiEnabled: boolean;
    generatedImageFixture: DesktopRuntimeMockAiOptions["generatedImageFixture"] | null;
    omitBatchApproveFileMetadata: boolean;
    storageLoadDelayMs: number;
    runtimePlatform: NodeJS.Platform;
    preserveAiModelPreferences: boolean;
    preserveStorageKeys: readonly string[];
    initialUiLayout: { mode: "docs" | "word"; onboardingCompleted: boolean };
    initialDocumentLoadFailure: DesktopRuntimeMockDocumentLoadFailure | null;
    initialLedgerSchemaFailure: LedgerSchemaFailure | null;
    emitWatcherEventOnSave: boolean;
  }) => {
    const fileId = "file_e2e_document";
    const workspaceId = "workspace_e2e";
    // A "PROPOSAL SHAPE" run (see fakeAiEditRun below) needs an existing overlay shape,
    // anchored to a body block, to build an updateOverlayShape mutationOperation against —
    // resolveOverlayShapeAnchorBlockId (ai-edit-preview-types.ts) requires a real
    // `anchor: {type:"block"}` for the inline preview card to mount at all. Synthesize one
    // when the AI mock is enabled and the test document doesn't already define an overlay
    // snapshot with shapes, so callers don't have to hand-build one themselves. Anchored to
    // the LAST paragraph-type block: a block-anchored shape renders directly on top of its
    // anchor block's content (regression seen anchoring to the 2nd paragraph — the shape's
    // hit target sat over an early paragraph and silently ate a text-selection click meant
    // for it, selecting the shape instead of placing a caret). Existing specs conventionally
    // put their interactive/named paragraphs first and use trailing filler paragraphs purely
    // for scroll padding (see e.g. ai-parallel-run.spec.ts's para_pad_N), so the last one is
    // the safest bet for a block no test clicks into.
    const ensureOverlayShapeFixture = (doc: SigmaDocument): SigmaDocument => {
      const existingShapes = doc.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
      if (existingShapes.length > 0) {
        return doc;
      }
      const paragraphBlocks = doc.content.filter((block) => block.type === "paragraph");
      const anchorBlockId = (paragraphBlocks[paragraphBlocks.length - 1] ?? doc.content[0])?.id;
      if (!anchorBlockId) {
        return doc;
      }
      return {
        ...doc,
        pageLayout: {
          ...doc.pageLayout,
          overlay: {
            ...doc.pageLayout?.overlay,
            overlaySnapshot: {
              version: 1,
              shapes: [
                {
                  id: "e2e_shape_1",
                  type: "geo",
                  x: 40,
                  y: 40,
                  rotation: 0,
                  props: {
                    w: 80,
                    h: 40,
                    geo: "rectangle",
                    fill: "solid",
                    color: "#111111",
                    fillColor: "#ffffff",
                    labelColor: "#111111",
                    dash: "solid",
                    size: "m",
                  },
                  anchor: { type: "block", blockId: anchorBlockId, dy: 0 },
                },
              ],
              assets: {},
            },
          },
        },
      } as unknown as SigmaDocument;
    };
    let currentDocument = aiEnabled ? ensureOverlayShapeFixture(structuredClone(initialDocument)) : structuredClone(initialDocument);
    let currentRevision = 1;
    let currentVersions: DocumentVersion[] = [];
    let currentMaterials = structuredClone(initialMaterials);
    let currentTemplates = structuredClone(initialTemplates);
    let currentDocumentLoadFailure = initialDocumentLoadFailure
      ? structuredClone(initialDocumentLoadFailure)
      : null;
    let currentLedgerSchemaFailure = initialLedgerSchemaFailure
      ? structuredClone(initialLedgerSchemaFailure)
      : null;
    const now = new Date().toISOString();
    (window as unknown as { __sigmaRepairFailedDocument?: () => void }).__sigmaRepairFailedDocument = () => {
      currentDocumentLoadFailure = null;
    };
    (window as unknown as { __sigmaRepairLedger?: () => void }).__sigmaRepairLedger = () => {
      currentLedgerSchemaFailure = null;
    };

    const metadata = () => ({
      fileId,
      workspaceId,
      folderId: null,
      docId: currentDocument.docId,
      title: currentDocument.metadata.title,
      documentPath: `/tmp/${fileId}.sigmadoc.json`,
      revision: currentRevision,
      createdAt: now,
      updatedAt: now,
    });
    const cloneDocument = () => structuredClone(currentDocument);
    const saveSnapshot = () => {
      window.localStorage.setItem("sigma-studio:e2e-document", JSON.stringify(currentDocument));
    };
    const applyProposalDraft = (proposal: DesktopMcpEditProposalSummary) => {
      const draft = proposal.draft as {
        operations?: Array<Record<string, unknown>>;
        mutationOperations?: Array<Record<string, unknown>>;
      };
      for (const operation of draft.operations ?? []) {
        if (operation.operation === "replace") {
          const replacement = operation.replacementBlock as { id: string };
          currentDocument = {
            ...currentDocument,
            content: currentDocument.content.map((block) =>
              block.id === (operation.targetId as string) ? (replacement as never) : block),
          } as SigmaDocument;
        } else if (operation.operation === "insertAfter") {
          const index = currentDocument.content.findIndex((block) => block.id === (operation.targetId as string));
          const nextContent = [...currentDocument.content];
          nextContent.splice(index >= 0 ? index + 1 : nextContent.length, 0, operation.insertedBlock as never);
          currentDocument = { ...currentDocument, content: nextContent };
        } else if (operation.operation === "insertOverlayShape") {
          const snapshot = currentDocument.pageLayout?.overlay?.overlaySnapshot;
          if (!snapshot || !operation.overlayShape) {
            continue;
          }
          currentDocument = {
            ...currentDocument,
            pageLayout: {
              ...currentDocument.pageLayout,
              overlay: {
                ...currentDocument.pageLayout?.overlay,
                overlaySnapshot: {
                  ...snapshot,
                  shapes: [...snapshot.shapes, operation.overlayShape as never],
                  assets: { ...snapshot.assets, ...(operation.assets as Record<string, never> | undefined) },
                },
              },
            },
          } as SigmaDocument;
        }
      }
      for (const operation of draft.mutationOperations ?? []) {
        const snapshot = currentDocument.pageLayout?.overlay?.overlaySnapshot;
        if (!snapshot) {
          continue;
        }
        if (operation.operation === "deleteOverlayShapes") {
          const deletedIds = new Set((operation.shapeIds as string[] | undefined) ?? []);
          currentDocument = {
            ...currentDocument,
            pageLayout: {
              ...currentDocument.pageLayout,
              overlay: {
                ...currentDocument.pageLayout?.overlay,
                overlaySnapshot: {
                  ...snapshot,
                  shapes: snapshot.shapes.filter((shape) => !deletedIds.has(shape.id)),
                },
              },
            },
          } as SigmaDocument;
        } else if (operation.operation === "updateOverlayShape") {
          const patch = (operation.patch ?? {}) as Record<string, unknown>;
          currentDocument = {
            ...currentDocument,
            pageLayout: {
              ...currentDocument.pageLayout,
              overlay: {
                ...currentDocument.pageLayout?.overlay,
                overlaySnapshot: {
                  ...snapshot,
                  shapes: snapshot.shapes.map((shape) => shape.id === operation.shapeId
                    ? {
                        ...shape,
                        ...patch,
                        props: patch.props
                          ? { ...shape.props, ...(patch.props as Record<string, unknown>) }
                          : shape.props,
                      } as never
                    : shape),
                  assets: { ...snapshot.assets, ...(operation.assets as Record<string, never> | undefined) },
                },
              },
            },
          } as SigmaDocument;
        }
      }
    };

    const buildAppliedDiff = (
      before: SigmaDocument,
      after: SigmaDocument,
      proposal: DesktopMcpEditProposalSummary,
    ): NonNullable<DesktopMcpEditProposalSummary["appliedDiff"]> => {
      const beforeBlocks = new Map(before.content.map((block) => [block.id, block]));
      const afterBlocks = new Map(after.content.map((block) => [block.id, block]));
      const beforeShapes = new Map(
        (before.pageLayout?.overlay?.overlaySnapshot?.shapes ?? []).map((shape) => [shape.id, shape]),
      );
      const afterShapes = new Map(
        (after.pageLayout?.overlay?.overlaySnapshot?.shapes ?? []).map((shape) => [shape.id, shape]),
      );
      const removedBodyIds = new Set<string>();
      const addedBodyIds = new Set<string>();
      const removedShapeIds = new Set<string>();
      const addedShapeIds = new Set<string>();
      for (const operation of proposal.draft.operations) {
        if (operation.operation === "replace") {
          removedBodyIds.add(operation.targetId);
          addedBodyIds.add(operation.replacementBlock.id);
        } else if (operation.operation === "insertAfter") {
          addedBodyIds.add(operation.insertedBlock.id);
        } else if (operation.operation === "insertOverlayShape") {
          addedShapeIds.add(operation.overlayShape.id);
        } else if (operation.operation === "insertTableShape") {
          addedShapeIds.add(operation.tableShape.id);
        }
      }
      for (const operation of proposal.draft.mutationOperations ?? []) {
        if (operation.operation === "deleteBlocks") {
          operation.blockIds.forEach((id) => removedBodyIds.add(id));
        } else if (operation.operation === "moveBlocks") {
          operation.blockIds.forEach((id) => {
            removedBodyIds.add(id);
            addedBodyIds.add(id);
          });
        } else if (operation.operation === "updateOverlayShape") {
          removedShapeIds.add(operation.shapeId);
          addedShapeIds.add(operation.shapeId);
        } else if (operation.operation === "alignOverlayShapes") {
          operation.shapeIds.forEach((id) => {
            removedShapeIds.add(id);
            addedShapeIds.add(id);
          });
        } else if (operation.operation === "deleteOverlayShapes") {
          operation.shapeIds.forEach((id) => removedShapeIds.add(id));
        }
      }
      return {
        body: [
          ...[...removedBodyIds].flatMap((id) => {
            const block = beforeBlocks.get(id);
            return block ? [{ change: "removed" as const, block }] : [];
          }),
          ...[...addedBodyIds].flatMap((id) => {
            const block = afterBlocks.get(id);
            return block ? [{ change: "added" as const, block }] : [];
          }),
        ],
        shapes: [
          ...[...removedShapeIds].flatMap((id) => {
            const shape = beforeShapes.get(id);
            return shape ? [{ change: "removed" as const, shape }] : [];
          }),
          ...[...addedShapeIds].flatMap((id) => {
            const shape = afterShapes.get(id);
            return shape ? [{ change: "added" as const, shape }] : [];
          }),
        ],
      };
    };

    // ---- AI runtime mock (opt-in via options.ai) -------------------------
    // Matches the real preload contract: aiEdit.run(payload, onEvent) streams
    // AiEditRunEvent objects through the onEvent callback while the returned
    // promise stays pending, then resolves with an AiEditRunResult (or rejects).
    type StorageChangeHandler = (event: DesktopStorageChangeEvent) => void;
    const storageChangeHandlers = new Set<StorageChangeHandler>();
    const emitStorageChange = (event: DesktopStorageChangeEvent) => {
      storageChangeHandlers.forEach((handler) => handler(event));
    };
    const versionCounter = (window as unknown as { __sigmaVersionCount: number });
    versionCounter.__sigmaVersionCount = 0;
    const comparableDocument = (doc: SigmaDocument) => {
      const value = structuredClone(doc) as SigmaDocument & { updatedAt?: string };
      delete value.updatedAt;
      if (value.pageLayout?.overlay) delete value.pageLayout.overlay.updatedAt;
      return JSON.stringify(value);
    };
    const captureMockVersion = (
      origin: "user" | "ai" | "restore-backup" | "tab-switch" | "app-close",
      before: SigmaDocument,
      after: SigmaDocument,
      force = false,
    ) => {
      const boundaryOrigin = origin === "tab-switch" || origin === "app-close";
      const comparisonDocument = boundaryOrigin ? currentVersions[0]?.document : before;
      if (!force && comparisonDocument && comparableDocument(comparisonDocument) === comparableDocument(after)) return null;
      if (
        !force
        && origin === "user"
        && currentVersions[0]
        && Date.now() - Date.parse(currentVersions[0].capturedAt) < 10 * 60 * 1_000
      ) return null;
      const version: DocumentVersion = {
        versionId: `version_e2e_${currentVersions.length + 1}`,
        revision: currentRevision,
        capturedAt: new Date(Date.now() + currentVersions.length).toISOString(),
        origin,
        document: structuredClone(after),
      };
      currentVersions = [version, ...currentVersions].slice(0, 200);
      versionCounter.__sigmaVersionCount = currentVersions.length;
      emitStorageChange({ type: "documentVersion", fileId, change: "captured", timestamp: Date.now() });
      return version;
    };
    (window as unknown as { __seedSigmaVersionHistory?: () => void }).__seedSigmaVersionHistory = () => {
      const replaceFirstParagraph = (text: string) => ({
        ...currentDocument,
        content: currentDocument.content.map((block, index) => index === 0 && block.type === "paragraph"
          ? { ...block, children: [{ type: "text" as const, text }] }
          : block),
        updatedAt: new Date().toISOString(),
      });
      let before = cloneDocument();
      currentDocument = replaceFirstParagraph("first saved version");
      currentRevision += 1;
      captureMockVersion("ai", before, currentDocument);
      before = cloneDocument();
      currentDocument = replaceFirstParagraph("second saved version with additions");
      currentRevision += 1;
      captureMockVersion("ai", before, currentDocument);
      emitStorageChange({ type: "document", fileId, change: "changed", timestamp: Date.now() });
    };

    let chatRooms: DesktopAiEditChatRoom[] = [];
    let mcpProposals: DesktopMcpEditProposalSummary[] = [];
    // Real proposal files keep a private revertDocument that is intentionally
    // omitted from DesktopMcpEditProposalSummary. Mirror it out-of-band here so
    // the chat's revision-gated rollback button can be exercised end to end.
    const proposalRevertDocuments = new Map<string, SigmaDocument>();
    let runCounter = 0;
    const runPayloads: unknown[] = [];
    (window as unknown as { __aiEditRunPayloads: unknown[] }).__aiEditRunPayloads = runPayloads;
    // 教材ファイルが増えたかをspecから見るためのカウンタ (AI承認は増やしてはいけない)。
    const createdFileCounter = (window as unknown as { __sigmaCreatedFileCount: number });
    createdFileCounter.__sigmaCreatedFileCount = 0;
    (window as unknown as { __autoApplyFirstPendingProposal?: () => string | null }).__autoApplyFirstPendingProposal = () => {
      const proposal = mcpProposals.find((item) => item.status === "pending");
      if (!proposal) {
        return null;
      }
      const revertDocument = cloneDocument();
      proposalRevertDocuments.set(proposal.proposalId, revertDocument);
      proposal.status = "approved";
      proposal.autoApplied = true;
      proposal.updatedAt = new Date().toISOString();
      applyProposalDraft(proposal);
      currentRevision += 1;
      captureMockVersion("ai", revertDocument, currentDocument);
      proposal.appliedRevision = currentRevision;
      proposal.appliedDiff = buildAppliedDiff(revertDocument, currentDocument, proposal);
      saveSnapshot();
      emitStorageChange({
        type: "mcpProposal",
        proposalId: proposal.proposalId,
        change: "changed",
        timestamp: Date.now(),
        autoApplied: true,
      });
      emitStorageChange({
        type: "document",
        fileId,
        change: "changed",
        timestamp: Date.now(),
        autoAppliedProposalIds: [proposal.proposalId],
      });
      // 実環境では上のmain通知に続いて、同じ保存を見たfs watcherの一般通知も届く。
      // 後発通知が先の非同期loadを追い越すraceを意図的に再現する。
      window.queueMicrotask(() => emitStorageChange({
        type: "document",
        fileId,
        change: "changed",
        timestamp: Date.now() + 1,
      }));
      return proposal.proposalId;
    };

    const loggedInCodexStatus = () => ({
      available: true,
      running: false,
      loggedIn: true,
      codexHome: "/tmp/e2e-codex-home",
      codexBin: "codex",
      configuredCodexBin: null,
      account: { type: "chatgpt", email: "e2e@example.com", planType: "plus" },
      error: null,
    });
    const loggedOutCodexStatus = () => ({
      available: false, running: false, loggedIn: false, codexHome: "", codexBin: "codex", configuredCodexBin: null, account: null, error: null,
    });
    const codexStatus = () => (aiEnabled ? loggedInCodexStatus() : loggedOutCodexStatus());

    const fakeAiEditRun = (payload: unknown, onEvent?: (event: unknown) => void) => {
      const request = (payload ?? {}) as {
        instruction?: string;
        agentThreadId?: string | null;
        selectedId?: string | null;
        document?: SigmaDocument;
        provider?: string;
        references?: unknown[];
        roomId?: string;
        turnId?: string;
      };
      runCounter += 1;
      const runIndex = runCounter;
      runPayloads.push(structuredClone({
        instruction: request.instruction ?? "",
        agentThreadId: request.agentThreadId ?? null,
        selectedId: request.selectedId ?? null,
        provider: request.provider ?? "chatgpt",
        references: request.references ?? [],
      }));
      const instruction = request.instruction ?? "";
      const shouldFail = instruction.includes("FAIL");
      const slow = instruction.includes("SLOW");
      const wantsProposal = instruction.includes("PROPOSAL");
      const duration = slow ? 15000 : shouldFail ? 2000 : 3000;
      const emit = (event: Record<string, unknown>) => {
        try {
          onEvent?.(event);
        } catch {
          // Mirrors the real bridge: a throwing renderer handler must not kill the run.
        }
      };

      return new Promise((resolve, reject) => {
        emit({ kind: "phase", phase: "preparing", message: "準備中...", timestamp: Date.now() });
        window.setTimeout(() => {
          emit({ kind: "phase", phase: "thinking", message: "編集内容を検討中...", timestamp: Date.now() });
        }, Math.round(duration * 0.2));
        window.setTimeout(() => {
          emit({
            kind: "stream", phase: "streaming", channel: "output",
            delta: "指示内容を確認し、編集案を作成しています。",
            message: "指示内容を確認し、編集案を作成しています。",
            timestamp: Date.now(),
          });
        }, Math.round(duration * 0.5));
        window.setTimeout(() => {
          emit({ kind: "phase", phase: "validating", message: "検証中...", timestamp: Date.now() });
        }, Math.round(duration * 0.8));
        window.setTimeout(() => {
          if (shouldFail) {
            emit({ kind: "error", phase: "complete", message: "E2E疑似実行を失敗させました。", timestamp: Date.now() });
            reject(new Error("E2E疑似実行を失敗させました。"));
            return;
          }
          if (wantsProposal && request.selectedId) {
            const targetId = request.selectedId;
            const proposalId = `proposal_e2e_${runIndex}`;
            const createdAt = new Date().toISOString();
            const wantsShapeProposal = instruction.includes("SHAPE");
            const wantsProblemProposal = !wantsShapeProposal && instruction.includes("PROBLEM");
            const wantsFormattingProposal = !wantsShapeProposal && instruction.includes("FORMAT");
            const wantsShapeInsertion = wantsShapeProposal && instruction.includes("INSERT");
            const wantsShapeDeletion = wantsShapeProposal && instruction.includes("DELETE");
            const wantsShapeReplacement = wantsShapeProposal && instruction.includes("REPLACE");
            const wantsMathLineBreak = instruction.includes("MATH_BREAK");
            const overlayShape = currentDocument.pageLayout?.overlay?.overlaySnapshot?.shapes?.[0];
            const shapeChangedId = overlayShape?.id ?? "e2e_shape_1";
            const insertedShapeId = `e2e_inserted_shape_${runIndex}`;
            const targetBlock = currentDocument.content.find((block) => block.id === targetId);
            const formattingChildren = (
              targetBlock?.type === "paragraph" || targetBlock?.type === "heading"
            )
              ? targetBlock.children.map((child) => child.type === "text"
                  ? { ...child, marks: [...new Set([...(child.marks ?? []), "bold" as const])] }
                  : child)
              : [{ type: "text" as const, text: "E2E書式変更対象" as const, marks: ["bold" as const] }];
            const proposal: DesktopMcpEditProposalSummary = {
              proposalId,
              fileId,
              // The draft below is built from currentDocument in this callback,
              // so its base must be the revision of that same snapshot. Overlay
              // editing can legitimately autosave before a shape-targeted run
              // finishes; pinning this to the fixture's initial revision would
              // manufacture a legacy overwrite conflict that the real proposal
              // store correctly refuses to present as current.
              baseRevision: currentRevision,
              baseDocId: currentDocument.docId,
              title: "E2E編集案",
              summary: `E2E疑似編集案 (${runIndex})`,
              plan: ["段落を書き換える"],
              warnings: [],
              // 実運用では書き込みツールがrun contextから帰属runIdを記録する (提案グルーピングは
              // runId単位)。並列run同士が別カードに分かれる挙動をe2eでも再現するため常に付ける。
              runId: `e2e-run-${runIndex}`,
              roomId: request.roomId,
              turnId: request.turnId,
              changedIds: wantsShapeProposal
                ? [wantsShapeInsertion ? insertedShapeId : shapeChangedId]
                : [targetId],
              provider: "chatgpt",
              draft: wantsShapeProposal
                ? wantsShapeInsertion
                  ? {
                      summary: `E2E疑似編集案 (${runIndex})`,
                      plan: ["図形を挿入する"],
                      operations: [{
                        operation: "insertOverlayShape",
                        summary: "図形を挿入",
                        targetId,
                        overlayShape: instruction.includes("SVG") ? {
                          id: insertedShapeId,
                          type: "image",
                          x: 360,
                          y: 0,
                          anchor: { type: "block", blockId: targetId, dx: 300, dy: 64 },
                          props: { w: 150, h: 84, assetId: "e2e_svg_asset" },
                        } : {
                          id: insertedShapeId,
                          type: "geo",
                          x: 360,
                          y: 0,
                          anchor: { type: "block", blockId: targetId, dx: 300, dy: 64 },
                          props: {
                            w: 150,
                            h: 84,
                            geo: "rectangle",
                            fill: "none",
                            color: "#111111",
                            fillColor: "#ffffff",
                            labelColor: "#111111",
                            dash: "solid",
                            size: "m",
                          },
                        },
                        assets: instruction.includes("SVG") ? {
                          e2e_svg_asset: {
                            id: "e2e_svg_asset",
                            type: "image",
                            props: {
                              w: 150, h: 84, name: "AI SVG", mimeType: "image/svg+xml", fileSize: 150,
                              isAnimated: false,
                              src: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="150" height="84"><circle cx="75" cy="42" r="30" fill="blue"/></svg>'),
                            },
                          },
                        } : {},
                      }],
                      warnings: [],
                    }
                  : wantsShapeDeletion
                    ? {
                        summary: `E2E疑似編集案 (${runIndex})`,
                        plan: ["図形を削除する"],
                        operations: [],
                        mutationOperations: [{
                          operation: "deleteOverlayShapes",
                          summary: "図形を削除",
                          shapeIds: [shapeChangedId],
                        }],
                        warnings: [],
                      }
                  : {
                    summary: `E2E疑似編集案 (${runIndex})`,
                    plan: ["図形を移動する"],
                    operations: [],
                    mutationOperations: [
                      {
                        operation: "updateOverlayShape",
                        summary: "図形を右へ移動",
                        shapeId: shapeChangedId,
                        patch: { x: (overlayShape?.x ?? 0) + 120 },
                      },
                    ],
                    warnings: [],
                  }
                : {
                    summary: `E2E疑似編集案 (${runIndex})`,
                    plan: [wantsProblemProposal ? "問題を挿入する" : "段落を書き換える"],
                    operations: wantsProblemProposal
                      ? [{
                          operation: "insertAfter",
                          summary: "枠付きの問題を挿入",
                          targetId,
                          insertedBlock: {
                            id: `e2e_problem_${runIndex}`,
                            type: "problem",
                            tags: [],
                            lead: [],
                            prompt: [{
                              id: `e2e_problem_prompt_${runIndex}`,
                              type: "paragraph",
                              children: [{ type: "text", text: "E2Eで追加した問題文" }],
                            }],
                            hints: [],
                            solution: [{
                              id: `e2e_problem_solution_${runIndex}`,
                              type: "paragraph",
                              children: [{ type: "text", text: "E2Eで追加した解答" }],
                            }],
                            answer: { type: "math", expected: "" },
                            frame: { enabled: true },
                          },
                        }]
                      : instruction.includes("CHAIN")
                        ? [
                          {
                            operation: "replace",
                            summary: "段落を置き換え",
                            targetId,
                            replacementBlock: {
                              id: targetId,
                              type: "paragraph",
                              children: [{ type: "text", text: `E2E提案で書き換えた本文 (${runIndex})` }],
                            },
                          },
                          // Chained inserts: each targets the previous op's inserted
                          // (not-yet-existing) block id. Exercises that the preview
                          // still shows every candidate, folded onto the real anchor.
                          {
                            operation: "insertAfter",
                            summary: "連鎖1",
                            targetId,
                            insertedBlock: {
                              id: "chain_1",
                              type: "paragraph",
                              children: [{ type: "text", text: "連鎖挿入1: 初項aの説明" }],
                            },
                          },
                          {
                            operation: "insertAfter",
                            summary: "連鎖2",
                            targetId: "chain_1",
                            insertedBlock: {
                              id: "chain_2",
                              type: "paragraph",
                              children: [{ type: "text", text: "連鎖挿入2: 公式本体" }],
                            },
                          },
                          ]
                        : [{
                          operation: "replace",
                          summary: "段落を置き換え",
                          targetId,
                          replacementBlock: {
                            id: targetId,
                            type: "paragraph",
                            children: wantsFormattingProposal
                              ? formattingChildren
                              : wantsMathLineBreak
                              ? [
                                  { type: "text", text: "式：" },
                                  {
                                    type: "mathInline",
                                    id: "e2e_two_column_math",
                                    tex: "\\begin{aligned}(n+1)^7&=n^7+7n^6+21n^5+35n^4\\\\&\\quad+35n^3+21n^2+7n+1\\end{aligned}",
                                    display: "inline",
                                    semanticRole: "expression",
                                  },
                                ]
                              : [{ type: "text", text: `E2E提案で書き換えた本文 (${runIndex})` }],
                          },
                        }],
                    warnings: [],
                  },
              status: "pending",
              createdAt,
              updatedAt: createdAt,
            };
            if (generatedImageFixture) {
              proposal.draft = structuredClone(generatedImageFixture.draft);
              proposal.changedIds = generatedImageFixture.changedIds;
              proposal.summary = generatedImageFixture.draft.summary;
              emit({ kind: "activity", phase: "streaming", itemType: "imageGeneration", itemStatus: "completed", itemId: "native-image", timestamp: Date.now(), message: "画像を生成しました。",
                images: [{ dataUrl: generatedImageFixture.previewDataUrl, generatedImage: { runId: "image-fixture-run", imageId: generatedImageFixture.imageId } }],
              });
            }
            const proposalsToAdd: DesktopMcpEditProposalSummary[] = wantsShapeReplacement
              ? [
                  {
                    ...proposal,
                    proposalId: `${proposalId}_delete`,
                    changedIds: [shapeChangedId],
                    runId: `e2e-run-${runIndex}`,
                    sessionLabel: "図形を置き換えて",
                    draft: {
                      summary: `E2E疑似置換案 (${runIndex})`,
                      plan: ["旧図形を削除する"],
                      operations: [],
                      mutationOperations: [{
                        operation: "deleteOverlayShapes",
                        summary: "旧図形を削除",
                        shapeIds: [shapeChangedId],
                      }],
                      warnings: [],
                    },
                  },
                  {
                    ...proposal,
                    proposalId: `${proposalId}_insert`,
                    changedIds: [insertedShapeId],
                    requestedShapeId: shapeChangedId,
                    runId: `e2e-run-${runIndex}`,
                    sessionLabel: "図形を置き換えて",
                    createdAt: new Date(Date.parse(createdAt) + 1).toISOString(),
                    updatedAt: new Date(Date.parse(createdAt) + 1).toISOString(),
                    draft: {
                      summary: `E2E疑似置換案 (${runIndex})`,
                      plan: ["新図形を挿入する"],
                      operations: [{
                        operation: "insertOverlayShape",
                        summary: "新図形を挿入",
                        targetId,
                        overlayShape: {
                          id: insertedShapeId,
                          type: "geo",
                          x: 360,
                          y: 0,
                          anchor: { type: "block", blockId: targetId, dx: 300, dy: 64 },
                          props: {
                            w: 150,
                            h: 84,
                            geo: "rectangle",
                            fill: "none",
                            color: "#111111",
                            fillColor: "#ffffff",
                            labelColor: "#111111",
                            dash: "solid",
                            size: "m",
                          },
                        },
                        assets: {},
                      }],
                      warnings: [],
                    },
                  },
                ]
              : [proposal];
            mcpProposals = [...mcpProposals, ...proposalsToAdd];
            proposalsToAdd.forEach((createdProposal) => {
              emitStorageChange({
                type: "mcpProposal",
                proposalId: createdProposal.proposalId,
                change: "changed",
                timestamp: Date.now(),
              });
            });
          }
          resolve({
            draft: {
              summary: `疑似実行が完了しました: ${instruction.slice(0, 60) || "(指示なし)"}`,
              plan: ["指示内容を確認", "編集方針を決定"],
              operations: [],
              warnings: [],
            },
            nextDocument: structuredClone(request.document ?? currentDocument),
            operationResults: [],
            logs: [{ kind: "model", message: "e2e fake run" }],
            repaired: false,
            changedIds: [],
            status: "answer",
            agentThreadId: request.agentThreadId ?? `e2e-thread-${runIndex}`,
            runtime: "codex-mcp",
          });
        }, duration);
      });
    };

    const aiEditSection = aiEnabled
      ? {
          run: fakeAiEditRun,
          getGeneratedImage: async (runId: string, imageId: string) => ({
            dataUrl: runId === "image-fixture-run" && imageId === generatedImageFixture?.imageId ? generatedImageFixture.dataUrl : null,
          }),
          listChatRooms: async (documentIdentityKey?: string) =>
            structuredClone(documentIdentityKey
              ? chatRooms.filter((room) => room.documentIdentityKey === documentIdentityKey)
              : chatRooms),
          saveChatRoom: async (room: DesktopAiEditChatRoom) => {
            const next = structuredClone(room);
            const index = chatRooms.findIndex((candidate) => candidate.id === next.id);
            if (index >= 0) {
              chatRooms = chatRooms.map((candidate, i) => (i === index ? next : candidate));
            } else {
              chatRooms = [next, ...chatRooms];
            }
            return { ok: true as const, room: structuredClone(next) };
          },
          deleteChatRoom: async (roomId: string) => {
            chatRooms = chatRooms.filter((room) => room.id !== roomId);
            return { ok: true };
          },
        }
      : {
          run: async () => ({ ok: false }),
        };
    // ----------------------------------------------------------------------

    const storedAiModelPreferences = preserveAiModelPreferences
      ? window.localStorage.getItem("sigma-studio:ai-edit-model-preferences")
      : null;
    const preserved = preserveStorageKeys
      .map((key) => [key, window.localStorage.getItem(key)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== null);
    window.localStorage.clear();
    if (storedAiModelPreferences) {
      window.localStorage.setItem("sigma-studio:ai-edit-model-preferences", storedAiModelPreferences);
    }
    // Seeded right after the wipe: the app's own default leaves onboarding incomplete, which
    // would drop the first-run UI picker on top of every spec. This goes BEFORE the
    // preserveStorageKeys restore so a spec that explicitly carries this key across a reload
    // still wins — seeding afterwards would clobber it and look like an app persistence bug.
    window.localStorage.setItem(
      "sigma-studio:ui-layout-preference",
      JSON.stringify(initialUiLayout),
    );
    for (const [key, value] of preserved) {
      window.localStorage.setItem(key, value);
    }
    saveSnapshot();
    window.desktopAPI = {
      isDesktop: true,
      platform: runtimePlatform,
      app: {
        getInfo: async () => ({ version: "0.1.0", releaseUrl: "https://github.com/Atsu-Taiyo/SIGMA-Studio/releases/latest" }),
        openLatestReleasePage: async () => ({ ok: true }),
        onCloseRequested: () => () => undefined,
        acknowledgeCloseRequest: async () => true,
        notifyCloseReady: async () => true,
        cancelCloseRequest: async () => true,
      },
      shell: {
        openExternal: async () => ({ ok: true }),
      },
      codex: {
        getStatus: async () => codexStatus(),
        listModels: async () => ({
          models: [
            {
              id: "gpt-5.5",
              label: "GPT 5.5",
              isDefault: true,
              defaultReasoningEffort: "xhigh",
              supportedReasoningEfforts: [{ id: "low" }, { id: "high" }, { id: "xhigh" }],
            },
            {
              id: "gpt-e2e-runtime",
              label: "GPT E2E Runtime",
              defaultReasoningEffort: "max",
              supportedReasoningEfforts: [{ id: "none" }, { id: "max" }],
            },
          ],
        }),
        setBin: async () => codexStatus(),
        selectBin: async () => ({ canceled: true }),
        login: async () => ({ ok: false, error: "disabled in e2e" }),
        openInstallPage: async () => ({ ok: true }),
        logout: async () => ({ ok: true }),
        onStatusChange: () => () => undefined,
      },
      ...(aiEnabled
        ? {
            claude: {
              getStatus: async () => ({ available: true, running: false, loggedIn: true, claudeBin: "claude", configuredClaudeBin: null, account: { apiKeySource: "subscription" }, error: null }),
              listModels: async () => ({
                models: [
                  {
                    id: "sonnet",
                    label: "Claude Sonnet 5",
                    isDefault: true,
                    defaultReasoningEffort: "low",
                    supportedReasoningEfforts: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }],
                  },
                  {
                    id: "opus",
                    label: "Claude Opus (latest)",
                    defaultReasoningEffort: "low",
                    supportedReasoningEfforts: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }],
                  },
                ],
              }),
              setBin: async () => ({ available: true, running: false, loggedIn: true, claudeBin: "claude", configuredClaudeBin: null, account: { apiKeySource: "subscription" }, error: null }),
              selectBin: async () => ({ canceled: true }),
              openInstallPage: async () => ({ ok: true }),
              onStatusChange: () => () => undefined,
            },
            gemini: {
              getStatus: async () => ({ available: true, loggedIn: true, geminiBin: "agy", configuredGeminiBin: null, account: { type: "google" }, error: null }),
              listModels: async () => ({ models: [{ id: "Gemini 3.5 Flash (High)", label: "Gemini 3.5 Flash (High)", isDefault: true }, { id: "Claude Sonnet 4.6 (Thinking)", label: "Claude Sonnet 4.6 (Thinking)" }] }),
              setBin: async () => ({ available: true, loggedIn: true, geminiBin: "agy", configuredGeminiBin: null, account: { type: "google" }, error: null }),
              selectBin: async () => ({ canceled: true }),
              openInstallPage: async () => ({ ok: true }),
              onStatusChange: () => () => undefined,
            },
          }
        : {}),
      aiEdit: aiEditSection,
      file: {
        openSigmaDoc: async () => null,
        saveSigmaDoc: async () => null,
        exportPdf: async (payload: {
          suggestedName?: string;
          surfaceId: string;
          revision: number;
          pageCount: number;
          pageWidthMm: number;
          pageHeightMm: number;
        }) => {
          window.localStorage.setItem("sigma-studio:e2e-export-pdf-payload", JSON.stringify(payload));
          return {
            filePath: `/Users/e2e/Downloads/${payload.suggestedName ?? "document.pdf"}`,
            pageCount: payload.pageCount,
          };
        },
        /** 実物は書かない。呼ばれたことと中身の大きさだけ残す。 */
        saveToDownloads: async (payload: { fileName: string; dataBase64: string }) => {
          window.localStorage.setItem("sigma-studio:e2e-saved-download", JSON.stringify({
            fileName: payload.fileName,
            byteLength: Math.floor(payload.dataBase64.length * 0.75),
          }));
          return { filePath: `/Users/e2e/Downloads/${payload.fileName}` };
        },
      },
      materials: {
        listMaterials: async () => structuredClone(currentMaterials),
        createMaterial: async (input: { name: string; content: MaterialItem["content"] } & Partial<MaterialItem>) => {
          const material: MaterialItem = {
            version: 1,
            id: `material_e2e_${currentMaterials.length + 1}`,
            name: input.name.trim() || "無題の素材",
            ...(input.description?.trim() ? { description: input.description.trim() } : {}),
            ...(input.tags?.length ? { tags: input.tags } : {}),
            ...(input.usage ? { usage: input.usage } : {}),
            ...(input.visualConcepts?.length ? { visualConcepts: input.visualConcepts } : {}),
            ...(input.transformPolicy ? { transformPolicy: input.transformPolicy } : {}),
            ...(input.ports?.length ? { ports: input.ports } : {}),
            content: structuredClone(input.content),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          currentMaterials = [material, ...currentMaterials];
          return structuredClone(material);
        },
        renameMaterial: async (id: string, name: string) => {
          const material = currentMaterials.find((item) => item.id === id);
          if (!material) {
            throw new Error("素材が見つかりません。");
          }
          material.name = name.trim() || "無題の素材";
          material.updatedAt = new Date().toISOString();
          return structuredClone(material);
        },
        updateMaterialMetadata: async (id: string, input: Partial<MaterialItem>) => {
          const material = currentMaterials.find((item) => item.id === id);
          if (!material) {
            throw new Error("素材が見つかりません。");
          }
          if (typeof input.name === "string") {
            material.name = input.name.trim() || "無題の素材";
          }
          if (input.content) {
            material.content = structuredClone(input.content);
          }
          for (const key of ["description", "tags", "usage", "visualConcepts", "transformPolicy", "ports"] as const) {
            if (key in input) {
              delete material[key];
            }
          }
          if (input.description?.trim()) material.description = input.description.trim();
          if (input.tags?.length) material.tags = structuredClone(input.tags);
          if (input.usage) material.usage = structuredClone(input.usage);
          if (input.visualConcepts?.length) material.visualConcepts = structuredClone(input.visualConcepts);
          if (input.transformPolicy) material.transformPolicy = structuredClone(input.transformPolicy);
          if (input.ports?.length) material.ports = structuredClone(input.ports);
          material.updatedAt = new Date().toISOString();
          return structuredClone(material);
        },
        deleteMaterial: async (id: string) => {
          const nextMaterials = currentMaterials.filter((item) => item.id !== id);
          if (nextMaterials.length === currentMaterials.length) {
            return { ok: false, error: "素材が見つかりません。" };
          }
          currentMaterials = nextMaterials;
          return { ok: true };
        },
      },
      templates: {
        listTemplates: async (requestedWorkspaceId?: string | null) => {
          const nextTemplates = requestedWorkspaceId
            ? currentTemplates.filter((item) => item.workspaceId === requestedWorkspaceId)
            : currentTemplates;
          return structuredClone(nextTemplates);
        },
        createTemplate: async (input: { workspaceId: string; name: string; document: SigmaDocument }) => {
          const template: TemplateItem = {
            version: 1,
            id: `template_e2e_${currentTemplates.length + 1}`,
            workspaceId: input.workspaceId,
            name: input.name.trim() || "無題のテンプレート",
            document: structuredClone(input.document),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          currentTemplates = [template, ...currentTemplates];
          return structuredClone(template);
        },
        renameTemplate: async (id: string, name: string) => {
          const template = currentTemplates.find((item) => item.id === id);
          if (!template) {
            throw new Error("テンプレートが見つかりません。");
          }
          template.name = name.trim() || "無題のテンプレート";
          template.updatedAt = new Date().toISOString();
          return structuredClone(template);
        },
        deleteTemplate: async (id: string) => {
          const nextTemplates = currentTemplates.filter((item) => item.id !== id);
          if (nextTemplates.length === currentTemplates.length) {
            return { ok: false, error: "テンプレートが見つかりません。" };
          }
          currentTemplates = nextTemplates;
          return { ok: true };
        },
      },
      storage: {
        initializeWorkspace: async () => currentLedgerSchemaFailure
          ? { ok: false as const, ledgerError: structuredClone(currentLedgerSchemaFailure) }
          : {
              ok: true as const,
              state: { openFileIds: [fileId], activeFileId: fileId },
            },
        listFiles: async () => [metadata()],
        loadDocument: async (requestedFileId: string) => {
          if (storageLoadDelayMs > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, storageLoadDelayMs));
          }
          if (currentDocumentLoadFailure) {
            return null;
          }
          return requestedFileId === fileId ? cloneDocument() : null;
        },
        loadDocumentWithRecovery: async (requestedFileId: string) => {
          if (storageLoadDelayMs > 0) {
            await new Promise((resolve) => window.setTimeout(resolve, storageLoadDelayMs));
          }
          if (requestedFileId !== fileId) {
            return { ok: false as const, error: "教材を読み込めませんでした。", failureKind: "missing" as const };
          }
          if (currentDocumentLoadFailure) {
            return {
              ok: false as const,
              error: currentDocumentLoadFailure.error,
              failureKind: currentDocumentLoadFailure.failureKind ?? ("schema" as const),
              failures: currentDocumentLoadFailure.failures ?? [],
              documentPath: currentDocumentLoadFailure.documentPath,
              title: currentDocumentLoadFailure.title,
            };
          }
          return {
            ok: true as const,
            document: cloneDocument(),
            revision: currentRevision,
            recoveryIssues: [],
          };
        },
        saveDocument: async (
          requestedFileId: string,
          nextDocument: SigmaDocument,
          saveOptions: { expectedRevision: number; origin?: "user" | "ai" | "restore-backup" | "tab-switch" | "app-close" },
        ) => {
          if (requestedFileId !== fileId) {
            return { ok: false, error: "教材が見つかりません。" };
          }
          if (saveOptions.expectedRevision !== currentRevision) {
            return {
              ok: false,
              code: "revision-mismatch" as const,
              currentRevision,
              error: "他の変更が先に保存されています。",
            };
          }
          const previousDocument = cloneDocument();
          currentDocument = structuredClone(nextDocument);
          currentRevision += 1;
          captureMockVersion(saveOptions.origin ?? "user", previousDocument, currentDocument);
          saveSnapshot();
          if (emitWatcherEventOnSave) {
            // 実機の fs watcher は「誰が書いたか」を知らないので、自分の保存でも返ってくる。
            // 書き込みより後に届くのでマイクロタスクへ逃がす。
            window.queueMicrotask(() => emitStorageChange({
              type: "document",
              fileId,
              change: "changed",
              timestamp: Date.now(),
            }));
          }
          return { ok: true, revision: currentRevision };
        },
        listDocumentVersions: async (requestedFileId: string): Promise<DocumentVersionMetadata[]> => requestedFileId === fileId
          ? currentVersions.map((version) => structuredClone({
              versionId: version.versionId,
              revision: version.revision,
              capturedAt: version.capturedAt,
              origin: version.origin,
            }))
          : [],
        getDocumentVersion: async (requestedFileId: string, versionId: string) => requestedFileId === fileId
          ? structuredClone(currentVersions.find((version) => version.versionId === versionId) ?? null)
          : null,
        captureDocumentVersion: async (
          requestedFileId: string,
          nextDocument: SigmaDocument,
          captureOptions: { expectedRevision: number; origin: "user" | "ai" | "restore-backup" | "tab-switch" | "app-close" },
        ) => {
          if (requestedFileId !== fileId || captureOptions.expectedRevision !== currentRevision) {
            return { ok: false, error: "他の変更が先に保存されています。" };
          }
          const version = captureMockVersion(
            captureOptions.origin,
            cloneDocument(),
            nextDocument,
            captureOptions.origin === "restore-backup",
          );
          return { ok: true, ...(version ? { version: {
            versionId: version.versionId,
            revision: version.revision,
            capturedAt: version.capturedAt,
            origin: version.origin,
          } } : {}) };
        },
        createDocument: async () => ({ file: metadata(), document: cloneDocument() }),
        createFileFromDocument: async ({ document: nextDocument }: { document: SigmaDocument }) => {
          createdFileCounter.__sigmaCreatedFileCount += 1;
          currentDocument = structuredClone(nextDocument);
          saveSnapshot();
          return { file: metadata(), document: cloneDocument() };
        },
        duplicateFile: async () => ({ file: metadata(), document: cloneDocument() }),
        deleteFile: async () => ({ ok: true }),
        saveWorkspace: async () => ({ ok: true }),
        getWorkspaceOverview: async () => currentLedgerSchemaFailure
          ? { state: "ledger-schema-error" as const, failure: structuredClone(currentLedgerSchemaFailure) }
          : {
              state: "ready" as const,
              overview: {
                activeWorkspaceId: workspaceId,
                workspaces: [{ id: workspaceId, name: "E2E", createdAt: now, updatedAt: now }],
                folders: [],
                files: [metadata()],
              },
            },
        createWorkspace: async () => ({ state: "error", error: "disabled in e2e" }),
        renameWorkspace: async () => ({ state: "error", error: "disabled in e2e" }),
        deleteWorkspace: async () => ({ state: "error", error: "disabled in e2e" }),
        createFolder: async () => ({ state: "error", error: "disabled in e2e" }),
        updateFolder: async () => ({ state: "error", error: "disabled in e2e" }),
        deleteFolder: async () => ({ state: "error", error: "disabled in e2e" }),
        moveFileToFolder: async () => ({ state: "error", error: "disabled in e2e" }),
        moveFileToWorkspace: async () => ({ state: "error", error: "disabled in e2e" }),
        getDataDir: async () => ({ path: "/tmp/sigma-e2e" }),
        listMcpEditProposals: async (listOptions?: DesktopMcpEditProposalListOptions) => {
          const status = listOptions?.status ?? "pending";
          const resolvedLimit = listOptions?.resolvedLimit ?? 50;
          let resolvedCount = 0;
          return structuredClone(
            mcpProposals
              .filter((proposal) => status === "all" || proposal.status === status)
              .filter((proposal) => (
                proposal.status === "pending"
                || !listOptions?.fileId
                || proposal.fileId === listOptions.fileId
              ))
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .filter((proposal) => {
                if (proposal.status === "pending") {
                  return true;
                }
                resolvedCount += 1;
                return resolvedCount <= resolvedLimit;
              }),
          );
        },
        approveMcpEditProposal: async (proposalId: string) => {
          const proposal = mcpProposals.find((item) => item.proposalId === proposalId);
          if (!proposal) {
            return { ok: false, error: "提案が見つかりません。" };
          }
          const revertDocument = cloneDocument();
          proposalRevertDocuments.set(proposalId, revertDocument);
          proposal.status = "approved";
          proposal.updatedAt = new Date().toISOString();
          applyProposalDraft(proposal);
          currentRevision += 1;
          currentDocument = { ...currentDocument, updatedAt: new Date().toISOString() };
          captureMockVersion("ai", revertDocument, currentDocument);
          proposal.appliedRevision = currentRevision;
          proposal.appliedDiff = buildAppliedDiff(revertDocument, currentDocument, proposal);
          saveSnapshot();
          emitStorageChange({ type: "mcpProposal", proposalId, change: "changed", timestamp: Date.now() });
          return { ok: true, proposal: structuredClone(proposal), file: metadata(), document: cloneDocument() };
        },
        approveMcpEditProposals: async (proposalIds: string[]) => {
          const revertDocument = cloneDocument();
          const approvedProposals: DesktopMcpEditProposalSummary[] = [];
          for (const proposalId of proposalIds) {
            const proposal = mcpProposals.find((item) => item.proposalId === proposalId);
            if (proposal) {
              proposalRevertDocuments.set(proposalId, structuredClone(revertDocument));
              proposal.status = "approved";
              proposal.appliedRevision = metadata().revision;
              proposal.updatedAt = new Date().toISOString();
              // 実運用のbatch承認と同様に本文operationとoverlay mutationを実docへ反映する。
              applyProposalDraft(proposal);
              approvedProposals.push(proposal);
            }
          }
          if (approvedProposals.length > 0) {
            currentRevision += 1;
            // main側の書き込みヘルパは承認保存のたびに updatedAt を押す。ここを省くと、
            // 「保存時刻だけが動いた文書」を人手編集と誤認する退行をe2eで captureできない。
            currentDocument = { ...currentDocument, updatedAt: new Date().toISOString() };
            captureMockVersion("ai", revertDocument, currentDocument);
          }
          approvedProposals.forEach((proposal) => {
            proposal.appliedDiff = buildAppliedDiff(revertDocument, currentDocument, proposal);
          });
          approvedProposals.forEach((proposal) => {
            proposal.appliedRevision = currentRevision;
          });
          saveSnapshot();
          emitStorageChange({ type: "mcpProposal", change: "changed", timestamp: Date.now() });
          return {
            ok: true,
            ...(!omitBatchApproveFileMetadata ? { file: metadata() } : {}),
            document: cloneDocument(),
          };
        },
        rejectMcpEditProposal: async (proposalId: string) => {
          const proposal = mcpProposals.find((item) => item.proposalId === proposalId);
          if (!proposal) {
            return { ok: false, error: "提案が見つかりません。" };
          }
          proposal.status = "rejected";
          emitStorageChange({ type: "mcpProposal", proposalId, change: "changed", timestamp: Date.now() });
          return { ok: true, proposal: structuredClone(proposal) };
        },
        // エディタundo/redoのストア整合 (approved⇄reverted)。実IPCと同じ遷移規則。
        markMcpEditProposalsReverted: async (proposalIds: string[]) => {
          const transitioned: string[] = [];
          for (const proposalId of proposalIds) {
            const proposal = mcpProposals.find((item) => item.proposalId === proposalId);
            if (proposal?.status === "approved") {
              proposal.status = "reverted";
              transitioned.push(proposalId);
            }
          }
          if (transitioned.length > 0) {
            emitStorageChange({ type: "mcpProposal", change: "changed", timestamp: Date.now() });
          }
          return { ok: transitioned.length > 0, transitioned, skipped: proposalIds.filter((id) => !transitioned.includes(id)) };
        },
        markMcpEditProposalsReapplied: async (proposalIds: string[]) => {
          const transitioned: string[] = [];
          for (const proposalId of proposalIds) {
            const proposal = mcpProposals.find((item) => item.proposalId === proposalId);
            if (proposal?.status === "reverted") {
              proposal.status = "approved";
              transitioned.push(proposalId);
            }
          }
          if (transitioned.length > 0) {
            emitStorageChange({ type: "mcpProposal", change: "changed", timestamp: Date.now() });
          }
          return { ok: transitioned.length > 0, transitioned, skipped: proposalIds.filter((id) => !transitioned.includes(id)) };
        },
        revertMcpEditProposal: async (proposalId: string) => {
          const proposal = mcpProposals.find((item) => item.proposalId === proposalId);
          const revertDocument = proposalRevertDocuments.get(proposalId);
          if (!proposal || proposal.status !== "approved" || proposal.appliedRevision !== metadata().revision || !revertDocument) {
            return { ok: false, reason: "承認後に教材が変更されているため取り消せません。" };
          }
          currentDocument = structuredClone(revertDocument);
          currentRevision += 1;
          proposal.status = "reverted";
          proposal.updatedAt = new Date().toISOString();
          saveSnapshot();
          emitStorageChange({ type: "mcpProposal", proposalId, change: "changed", timestamp: Date.now() });
          emitStorageChange({ type: "document", fileId, change: "changed", timestamp: Date.now() });
          return { ok: true, proposal: structuredClone(proposal) };
        },
        onChange: (handler: StorageChangeHandler) => {
          storageChangeHandlers.add(handler);
          return () => {
            storageChangeHandlers.delete(handler);
          };
        },
      },
      onMenuAction: () => () => undefined,
    };
  }, {
    initialDocument: document,
    initialMaterials: options.materials ?? [],
    initialTemplates: options.templates ?? [],
    aiEnabled: options.ai?.enabled ?? false,
    generatedImageFixture: options.ai?.generatedImageFixture ?? null,
    omitBatchApproveFileMetadata: options.ai?.omitBatchApproveFileMetadata ?? false,
    storageLoadDelayMs: options.storageLoadDelayMs ?? 0,
    runtimePlatform: options.platform ?? "darwin",
    preserveAiModelPreferences: options.preserveAiModelPreferences ?? false,
    preserveStorageKeys: options.preserveStorageKeys ?? [],
    initialUiLayout: {
      mode: options.uiLayout?.mode ?? "docs",
      onboardingCompleted: options.uiLayout?.onboardingCompleted ?? true,
    },
    initialDocumentLoadFailure: options.documentLoadFailure ?? null,
    initialLedgerSchemaFailure: options.ledgerSchemaFailure ?? null,
    emitWatcherEventOnSave: options.emitWatcherEventOnSave ?? false,
  });
}
