import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getModuleSpecifiers as importSpecifiers } from "../../../../tests/helpers/source-dependencies";

function source(fileName: string): string {
  return readFileSync(new URL(fileName, import.meta.url), "utf8");
}

describe("text-flow module boundaries", () => {
  it("keeps continuation ownership and measurement acknowledgement below editor controllers", () => {
    for (const fileName of ["./fragment-edit-session.ts", "./measurement-revision.ts"]) {
      expect(importSpecifiers(source(fileName)).filter((specifier) => (
        specifier === "react" || specifier.startsWith("@tiptap/")
        || specifier.includes("/features/ai-edit")
        || /(?:TextFlowEditor|PageCanvasEditor|EditorShell)/.test(specifier)
      ))).toEqual([]);
    }
  });
  it("keeps slash command behavior below the React controller and popover view", () => {
    for (const fileName of ["./slash-command-model.ts", "./slash-command-controller.ts"]) {
      expect(importSpecifiers(source(fileName)).filter((specifier) => (
        specifier === "react"
        || specifier.startsWith("react/")
        || specifier.includes("/features/ai-edit")
        || specifier.includes("/lib/ai/")
        || specifier.includes("command-popovers")
        || /(?:TextFlowEditor|PageCanvasEditor|OverlayCanvasEditorClient|EditorShell)/.test(specifier)
      ))).toEqual([]);
    }
    expect(importSpecifiers(source("./slash-command-model.ts")).filter((specifier) => (
      specifier.startsWith("@tiptap/") || specifier.includes("slash-command-controller")
    ))).toEqual([]);
    const controller = source("../TextFlowEditor.tsx");
    expect(controller).toContain('from "./text-flow/slash-command-controller"');
    expect(controller).toContain('from "./text-flow/slash-command-model"');
    expect(controller).not.toMatch(/\bfunction (?:getActiveSlashCommandQuery|insertSlashCommandFromQuery|filterSlashCommandCandidates)\b/);
    const popovers = source("./command-popovers.tsx");
    expect(popovers).toContain('export { getSlashCommandCandidateName } from "./slash-command-model"');
    expect(popovers).toContain('export type { ActiveSlashCommandQuery, SlashCommandCandidate } from "./slash-command-model"');
  });

  it("keeps clipboard state and manual-break transactions outside the React controller", () => {
    for (const fileName of ["./clipboard-transactions.ts", "./manual-break-transactions.ts"]) {
      expect(importSpecifiers(source(fileName)).filter((specifier) => (
        specifier === "react"
        || specifier.startsWith("react/")
        || specifier.includes("/features/ai-edit")
        || specifier.includes("/lib/ai/")
        || /(?:TextFlowEditor|PageCanvasEditor|OverlayCanvasEditorClient|EditorShell)/.test(specifier)
      ))).toEqual([]);
    }
    const controller = source("../TextFlowEditor.tsx");
    expect(controller).toContain('from "./text-flow/clipboard-transactions"');
    expect(controller).toContain('from "./text-flow/manual-break-transactions"');
    expect(controller).not.toMatch(/\bfunction (?:resolveManualBreakPasteContent|replaceManualBreakSpanningSelection|pasteTextAndShapesFromClipboard)\b/);
    expect(controller).not.toMatch(/\b(?:literalPasteInProgressRef|forcedClipboardHistoryGroupRef)\b/);
    expect(controller).toContain("clipboardSession.resetHistory()");
    expect(controller).toContain("clipboardSession.historyGroupFor(");
    // Large SigmaDoc commits and caret restoration remain the controller's application boundary.
    expect(controller).toContain("commitLargeTextPastePlan(");
    expect(controller).toContain("crossEditorSyncRef.current = { selection: plan.selection ?? null }");
  });

  it("keeps legacy pure-module paths as logic-free feature facades", () => {
    const facades = [
      "./block-model.ts",
      "./block-sync.ts",
      "./manual-page-break.ts",
      "./normalization.ts",
    ];

    for (const fileName of facades) {
      const code = source(fileName);
      expect(importSpecifiers(code)).toEqual(["@/features/text-editing"]);
      expect(code).not.toMatch(/\bfunction\b|\bconst\b|\bclass\b/);
    }
  });

  it("keeps the Tiptap adapter independent from React and editor controllers", () => {
    const imports = importSpecifiers(source("./tiptap-document-adapter.ts"));

    expect(imports.filter((specifier) => (
      specifier === "react"
      || specifier.startsWith("react/")
      || specifier.includes("/features/ai-edit")
      || specifier.includes("/lib/ai/")
      || specifier.includes("TextFlowEditor")
    ))).toEqual([]);
  });
});
