import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { getModuleSpecifiers as importSpecifiers } from "../../../tests/helpers/source-dependencies";

const reusableEditorFiles = [
  "../../components/editor/TextFlowEditor.tsx",
  "../../components/editor/RichTextEditor.tsx",
  "../../components/editor/OverlayCanvasEditorClient.tsx",
  "../../components/editor/overlay-canvas/shape-renderer.tsx",
];

const reusablePageCanvasFiles = [
  "../../components/editor/PageCanvasEditor.tsx",
  "../../components/editor/page-canvas/editor-extension.ts",
  "../../components/editor/page-canvas/extension-placement.ts",
  "../../components/editor/page-canvas/popover-anchors.ts",
];

const canonicalAiViewFiles = [
  "./view/AiAppliedDocumentDiff.tsx",
  "./view/AiEditInlinePreviewCard.tsx",
  "./view/AiSourceReferenceChips.tsx",
  "./view/AiStreamRenderer.tsx",
];

const legacyAiViewFacades = canonicalAiViewFiles.map((relativePath) => {
  const fileName = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  return {
    canonicalPath: relativePath,
    facadePath: `../../components/editor/${fileName}`,
    expectedSource: `export * from "@/features/ai-edit/view/${fileName.replace(/\.tsx$/, "")}";`,
  };
});

const aiCompositionEditorFiles = new Set([
  "DesktopSettingsModal.tsx",
  "EditorShell.tsx",
  "ai-edit-preview-types.ts",
  "ai-model-menu-contents.tsx",
  "ai-run-anchor-layer.tsx",
  "ai-run-card-composer.tsx",
]);

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function listProductionEditorSources(
  directory: URL,
  relativeDirectory = "",
): Array<{ relativePath: string; source: string }> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (entry.isDirectory()) {
      return listProductionEditorSources(
        new URL(`${entry.name}/`, directory),
        relativePath,
      );
    }
    if (
      !entry.isFile()
      || !/\.tsx?$/.test(entry.name)
      || entry.name.includes(".test.")
      || entry.name.includes(".spec.")
    ) {
      return [];
    }
    return [{
      relativePath,
      source: readFileSync(new URL(entry.name, directory), "utf8"),
    }];
  });
}

function listProductionTypeScriptFiles(relativeDirectory: string): string[] {
  return readdirSync(fileURLToPath(new URL(relativeDirectory, import.meta.url)))
    .filter((fileName) => /\.(?:ts|tsx)$/.test(fileName) && !fileName.includes(".test."))
    .map((fileName) => `${relativeDirectory}/${fileName}`);
}

function namedImportSource(source: string, importedName: string): string | null {
  const imports = [...source.matchAll(/import\s+(?:type\s*)?{([\s\S]*?)}\s*from\s*["']([^"']+)["'];/g)];
  const matchingImport = imports.find((match) => (
    new RegExp(`\\b${importedName}\\b`).test(match[1])
  ));
  return matchingImport?.[2] ?? null;
}

function isAiCompositionEditorFile(relativePath: string): boolean {
  const fileName = relativePath.split("/").at(-1) ?? relativePath;
  return /^Ai[A-Z0-9].*\.tsx?$/.test(fileName)
    || aiCompositionEditorFiles.has(relativePath);
}

describe("AI editor extension boundary", () => {
  it("keeps generic editor production independent from AI libraries and feature internals", () => {
    const editorSources = listProductionEditorSources(
      new URL("../../components/editor/", import.meta.url),
    ).filter(({ relativePath }) => !isAiCompositionEditorFile(relativePath));
    const invalidImports = editorSources.flatMap(({ relativePath, source }) => (
      importSpecifiers(source)
        .filter((specifier) => (
          specifier === "@/lib/ai"
          || specifier.startsWith("@/lib/ai/")
          || specifier === "@/features/ai-edit"
          || specifier.startsWith("@/features/ai-edit/")
        ))
        .map((specifier) => ({ relativePath, specifier }))
    ));

    expect(invalidImports).toEqual([]);
  });

  it.each(reusableEditorFiles)("keeps %s independent from AI stores and feature internals", (relativePath) => {
    const source = readSource(relativePath);

    expect(source).not.toMatch(/from\s+["']@\/lib\/ai\//);
    expect(source).not.toMatch(/from\s+["']@\/features\/ai-edit\//);
    expect(source).not.toContain("useAiEditingBlockLocks");
    expect(source).not.toContain("useAiEditingShapeLocks");
    expect(source).not.toContain("requestAiEditLockStop");
    expect(source).not.toContain("AiProvider");
  });

  it("keeps PageCanvas free from lock-store/provider/cancellation wiring", () => {
    const source = readSource("../../components/editor/PageCanvasEditor.tsx");

    expect(source).not.toContain("ai-editing-block-locks");
    expect(source).not.toContain("ai-shape-lock");
    expect(source).not.toContain("OverlayShapeAiEditLock");
    expect(source).not.toContain("requestAiEditLockStop");
    expect(source).not.toContain("AiProvider");
  });

  it.each(reusablePageCanvasFiles)("keeps %s independent from AI presentation and reference concepts", (relativePath) => {
    const source = readSource(relativePath);

    expect(source).not.toMatch(/from\s+["']@\/lib\/ai\//);
    expect(source).not.toMatch(/from\s+["']@\/features\/ai-edit/);
    expect(source).not.toContain("AiEditPreview");
    expect(source).not.toContain("AiRun");
    expect(source).not.toContain("AiReference");
    expect(source).not.toContain("onAi");
    expect(source).not.toContain("提案");
    expect(source).not.toContain("proposal");
  });

  it("keeps TextFlow independent from AI reference highlighting", () => {
    const source = readSource("../../components/editor/TextFlowEditor.tsx");

    expect(source).not.toContain("AI_REFERENCE_TEXT_RANGE_EVENT");
    expect(source).not.toContain("AiReferenceHighlightExtension");
    expect(source).not.toContain("aiReferenceHighlight");
    expect(source).not.toContain("ai-");
  });

  it("keeps the Tiptap guard and inline-math editor on a generic atom-lock contract", () => {
    const guard = readSource("../../components/tiptap/edit-guard-extension.ts");
    const inlineMath = readSource("../../components/tiptap/inline-math-extension.tsx");

    for (const source of [guard, inlineMath]) {
      expect(source).not.toMatch(/from\s+["']@\/lib\/ai\//);
      expect(source).not.toMatch(/from\s+["']@\/features\/ai-edit/);
      expect(source).not.toContain("AiEditLock");
      expect(source).not.toContain("ai-edit-lock-atom");
      expect(source).not.toContain("AIを停止して編集");
    }
    expect(guard).toContain('"data-edit-guard-atom": "true"');
    expect(inlineMath).toContain("hasInlineMathEditGuardDecoration");
    expect(inlineMath).toContain('["data-edit-guard-atom"] === "true"');
  });

  it("owns AI lock projection, shimmer, and transaction compatibility in the feature adapter", () => {
    const adapter = readSource("./adapters/tiptap/edit-lock-adapter.ts");
    const composition = readSource("./editor-extensions.tsx");
    const publicEntry = readSource("./index.ts");

    expect(adapter).toContain('from "@/components/tiptap/edit-guard-extension"');
    expect(adapter).toContain("buildAiTextFlowEditPolicy");
    expect(adapter).toContain("createAiEditLockDecorations");
    expect(adapter).toContain("collectAiEditLockSpans");
    expect(adapter).toContain("shouldAllowTextFlowTransaction");
    expect(adapter).toContain('"ai-edit-lock-atom"');
    expect(adapter).not.toContain("@/components/tiptap/ai-edit-lock-extension");
    expect(adapter).not.toContain("@/lib/ai/ai-edit-lock-shimmer");
    expect(adapter).not.toContain("@/lib/ai/ai-edit-lock-transaction-guard");
    expect(composition).toContain('from "./adapters/tiptap/edit-lock-adapter"');
    expect(composition).toContain("buildAiTextFlowEditPolicy({");
    expect(composition).not.toContain("AI_EDIT_GUARD_PRESENTATION");
    expect(publicEntry).toContain('from "./adapters/tiptap/edit-lock-adapter"');
  });

  it.each([
    "../../components/tiptap/ai-edit-lock-extension.ts",
    "../../lib/ai/ai-edit-lock-shimmer.ts",
    "../../lib/ai/ai-edit-lock-transaction-guard.ts",
  ])("keeps legacy AI lock path %s as a logic-free compatibility facade", (relativePath) => {
    const source = readSource(relativePath);

    expect(source).toContain("@/features/ai-edit/adapters/tiptap/edit-lock-adapter");
    expect(source).not.toMatch(/\bfunction\s+\w+/);
    expect(source).not.toMatch(/\bconst\s+\w+\s*=/);
    expect(source).not.toContain("@/components/tiptap/edit-guard-extension");
    expect(source).not.toContain("AIを停止して編集");
  });

  it("preserves the external highlight event and CSS compatibility in the generic extension", () => {
    const source = readSource("../../components/tiptap/external-text-range-highlight-extension.ts");
    const alias = readSource("./text-range-highlight.ts");
    const contract = readSource("../text-editing/external-text-range-highlight.ts");

    expect(source).toContain('from "@/features/text-editing"');
    expect(source).toContain('class: "external-text-range-inline-math-highlight"');
    expect(source).toContain('{ class: "external-text-range-highlight" }');
    expect(source).not.toContain('"sigma-studio:ai-reference-text-range"');
    expect(contract).toContain('"sigma-studio:ai-reference-text-range"');
    expect(alias).toContain("EXTERNAL_TEXT_RANGE_HIGHLIGHT_EVENT");
    expect(alias).toContain('from "@/features/text-editing"');
    expect(alias).not.toContain("@/components/");
  });

  it("keeps the application shell on the AI feature's public entrypoint", () => {
    const source = readSource("../../components/editor/EditorShell.tsx");

    expect(source).toContain('from "@/features/ai-edit"');
    expect(source).not.toMatch(/from\s+["']@\/features\/ai-edit\//);
    expect(source).not.toContain("useAiEditorExtensions");
    expect(source).not.toContain("editorExtensions=");
    expect(namedImportSource(source, "useAiPinnedReferences")).toBe("@/features/ai-edit");
    expect(namedImportSource(source, "useAiProposalActions")).toBe("@/features/ai-edit");
    expect(namedImportSource(source, "useCommentAiRun")).toBe("@/features/ai-edit");
    expect(namedImportSource(source, "AI_SIDEBAR_WIDTH")).toBe("@/features/ai-edit");
    expect(namedImportSource(source, "AiEditReference")).toBe("@/features/ai-edit");
    expect(namedImportSource(source, "AiEditShapeOnlyPreview")).toBe("@/features/ai-edit");
    expect(namedImportSource(source, "groupMcpProposalsForPreview")).toBe("@/features/ai-edit");
    expect(namedImportSource(source, "deriveAiProposalPresentation")).toBe("@/features/ai-edit");
    expect(namedImportSource(source, "deriveAiReferenceRequestPlan")).toBe("@/features/ai-edit");
    expect(namedImportSource(source, "deriveAiRunStartTransition")).toBe("@/features/ai-edit");
    expect(source).not.toContain("@/components/editor/ai-edit-preview-types");
    expect(source).not.toContain("@/lib/ai/comment-mention");
    expect(source).not.toContain("sameProposalIdSet");
    expect(source).not.toContain("aiEditPinnedReferencesRef");
    expect(source).not.toContain("pinnedTextRangeSnapshotsRef");
    expect(source).not.toContain("getAiEditReferenceKey");
    expect(source).not.toContain("textRangeBlockSignature");
    expect(source).not.toContain("mcpProposalPreview.groups.filter");
    expect(source).not.toContain("const hasActiveAiRunForDocument");
    expect(source).not.toContain("fullyRejected");
    expect(source).not.toContain("approvedCitations");
    expect(source).not.toContain("AI編集案を閉じました");
    expect(source).not.toContain("編集案を破棄しました");
    expect(source).not.toContain("aiSurfaceAlreadyOpen");
    expect(source).not.toContain("runStartedForActiveDocument");
    expect(source).not.toContain("seenActiveAiRunIdsRef.current.add");
  });

  it("keeps proposal decisions and comment AI runs in independently mountable feature hooks", () => {
    const shell = readSource("../../components/editor/EditorShell.tsx");
    expect(shell).not.toContain("const handleMcpEditPreview =");
    expect(shell).not.toContain("const rejectProposals =");
    expect(shell).not.toContain("const maybeTriggerCommentAiRun =");
    for (const relativePath of ["./application/use-ai-proposal-actions.ts", "./application/use-comment-ai-run.ts"]) {
      const imports = importSpecifiers(readSource(relativePath));
      expect(imports.filter((specifier) => /(?:EditorShell|TextFlowEditor|PageCanvasEditor|OverlayCanvasEditorClient)(?:\.[cm]?[jt]sx?)?$/.test(specifier))).toEqual([]);
    }
    const actions = readSource("./application/use-ai-proposal-actions.ts");
    expect(namedImportSource(actions, "buildAiProposalApplyContext")).toBe("./proposal-action-model");
    expect(namedImportSource(actions, "AI_APPLY_ADD_FLASH_MS")).toBe("./proposal-feedback");
    expect(actions).toContain("applyAiApprovedDocument({");
    expect(actions).toContain("finishMcpPreviewBusy()");
    const comments = readSource("./application/use-comment-ai-run.ts");
    expect(namedImportSource(comments, "buildCommentAiRunRequestPlan")).toBe("./run-request-model");
  });

  it("keeps generic EditorShell document helpers free from AI responsibilities", () => {
    const source = readSource("../../components/editor/editor-shell/document-helpers.ts");

    expect(source).not.toMatch(/from\s+["']@\/lib\/ai\//);
    expect(source).not.toMatch(/from\s+["']@\/features\/ai-edit/);
    expect(source).not.toContain("buildCommentAiReference");
    expect(source).not.toContain("sameProposalIdSet");
  });

  it("keeps the legacy AI preview path as a compatibility-only re-export", () => {
    const facade = readSource("../../components/editor/ai-edit-preview-types.ts").trim();

    expect(facade).toBe('export * from "@/features/ai-edit/model/preview";');
  });

  it.each(legacyAiViewFacades)(
    "keeps legacy AI View path $facadePath as a logic-free compatibility facade",
    ({ facadePath, expectedSource }) => {
      expect(readSource(facadePath).trim()).toBe(expectedSource);
    },
  );

  it.each([
    ...listProductionTypeScriptFiles("./model"),
    ...listProductionTypeScriptFiles("./application"),
  ])("keeps AI model/application module %s independent from the React View layer", (relativePath) => {
    const source = readSource(relativePath);

    expect(source).not.toMatch(/from\s+["'][^"']*\/view(?:\/[^"']*)?["']/);
    expect(source).not.toMatch(/from\s+["'][^"']*Ai(?:AppliedDocumentDiff|EditInlinePreviewCard|SourceReferenceChips|StreamRenderer)["']/);
  });

  it("keeps AI page composition on the feature-local View entrypoint", () => {
    const source = readSource("./AiPageCanvasEditor.tsx");

    expect(source).toContain('from "./view"');
    expect(source).not.toMatch(/from\s+["']@\/components\/editor\/Ai(?:AppliedDocumentDiff|EditInlinePreviewCard|SourceReferenceChips|StreamRenderer)/);
  });

  it.each([
    "./model/preview.ts",
    "./model/comment-reference.ts",
    "./model/pinned-reference-model.ts",
    "./model/proposal-presentation-model.ts",
    "./application/proposal-action-model.ts",
    "./application/run-request-model.ts",
  ])("keeps the canonical AI model %s independent from editor components", (relativePath) => {
    const source = readSource(relativePath);

    expect(source).not.toMatch(/from\s+["']@\/components\//);
    expect(source).not.toContain('from "@/types/sigma-doc"');
  });

  it("uses canonical document comment types in AI models", () => {
    const commentReference = readSource("./model/comment-reference.ts");
    const pinnedReference = readSource("./model/pinned-reference-model.ts");
    const runRequest = readSource("./application/run-request-model.ts");

    expect(namedImportSource(commentReference, "SigmaCommentAnchor")).toBe("@/features/document");
    expect(namedImportSource(pinnedReference, "SigmaTextRangeCommentAnchor")).toBe("@/features/document");
    expect(namedImportSource(runRequest, "SigmaCommentAnchor")).toBe("@/features/document");
    expect(namedImportSource(runRequest, "InlineNode")).toBe("@/features/document");
  });

  it("keeps pinned-reference React state in the AI application layer", () => {
    const source = readSource("./application/use-ai-pinned-references.ts");
    const model = readSource("./model/pinned-reference-model.ts");

    expect(source).not.toMatch(/from\s+["']@\/components\//);
    expect(source).not.toContain('from "@/types/sigma-doc"');
    expect(source).toContain("useRef<AiEditReference[]>([])");
    expect(source).toContain("planAiPinnedReferenceAddition(referencesRef.current, reference)");
    expect(model).not.toMatch(/from\s+["']react["']/);
    expect(model).not.toContain("useState");
    expect(model).not.toContain("useEffect");
  });

  it("keeps proposal presentation and decision derivation pure", () => {
    const presentation = readSource("./model/proposal-presentation-model.ts");
    const decisions = readSource("./application/proposal-action-model.ts");

    expect(presentation).not.toMatch(/from\s+["']react["']/);
    expect(presentation).not.toContain("useMemo");
    expect(presentation).not.toContain("setStatusMessage");
    expect(decisions).not.toMatch(/from\s+["']react["']/);
    expect(decisions).not.toContain("getDesktopBridge");
    expect(decisions).not.toContain("submitRejectionFeedback");
    expect(decisions).not.toContain("setStatusMessage");
  });

  it("keeps run request planning pure and IPC-free", () => {
    const source = readSource("./application/run-request-model.ts");

    expect(source).not.toMatch(/from\s+["']react["']/);
    expect(source).not.toContain("getDesktopBridge");
    expect(source).not.toContain("runAiEditViaDesktopRuntime");
    expect(source).not.toContain("setSelectedId");
    expect(source).not.toContain("openAiInline");
    expect(source).not.toContain("setStatusMessage");
  });

  it("routes source-reference navigation to the AI feature public entrypoint", () => {
    const source = readSource("../../lib/ai/ai-source-reference-navigation.ts");

    expect(namedImportSource(source, "resolveOverlayShapeAnchorBlockId")).toBe("@/features/ai-edit");
    expect(source).not.toContain("@/components/editor/ai-edit-preview-types");
    expect(source).not.toMatch(/from\s+["']@\/features\/ai-edit\//);
  });
});
