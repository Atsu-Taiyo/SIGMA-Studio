import { readFileSync, readdirSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import * as legacyStore from "../local-sigma-doc-proposal-store";
import * as contracts from "./contracts";
import * as freshness from "./freshness";
import * as replay from "./replay";
import { buildSelectiveRevertDocument } from "./selective-revert";

const allowedSiblingImports: Record<string, readonly string[]> = {
  "contracts.ts": [],
  "freshness.ts": ["./contracts"],
  "replay.ts": ["./contracts"],
  "selective-revert.ts": ["./contracts", "./replay"],
};

function moduleImports(source: string): string[] {
  const file = ts.createSourceFile("proposal.ts", source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const specifier = node.arguments[0];
      if (specifier && ts.isStringLiteral(specifier)) imports.push(specifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return imports;
}

describe("proposal domain boundaries", () => {
  it("keeps document transformations independent of persistence and provider adapters", () => {
    const violations: string[] = [];
    const directory = new URL("./", import.meta.url);
    for (const name of readdirSync(directory).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))) {
      const source = readFileSync(new URL(name, directory), "utf8");
      const allowedSiblings = allowedSiblingImports[name];
      if (!allowedSiblings) violations.push(`${name}: declare its domain dependencies`);
      for (const specifier of moduleImports(source)) {
        const isDomainImport = specifier.startsWith("@/features/document")
          || (specifier.startsWith("@/lib/") && !/^@\/lib\/(?:storage|runtime)(?:\/|$)/.test(specifier));
        if (specifier !== "node:util" && !isDomainImport && !allowedSiblings?.includes(specifier)) {
          violations.push(`${name} -> ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("preserves every existing runtime export for Electron and MCP consumers", () => {
    const publicApi = {
      LocalMcpEditProposalStore: legacyStore.LocalMcpEditProposalStore,
      MAX_MCP_PROPOSAL_FILE_BYTES: 16 * 1024 * 1024,
      MAX_PROPOSAL_SOURCE_REFERENCES: contracts.MAX_PROPOSAL_SOURCE_REFERENCES,
      parseMcpProposalProvider: contracts.parseMcpProposalProvider,
      isAiSourceReference: contracts.isAiSourceReference,
      isAiSourceReferenceArray: contracts.isAiSourceReferenceArray,
      parseAiSourceReferences: contracts.parseAiSourceReferences,
      resolveProposalAttribution: contracts.resolveProposalAttribution,
      canForceApplyProposalConflict: freshness.canForceApplyProposalConflict,
      shouldAutoApplyProposal: freshness.shouldAutoApplyProposal,
      collectTouchedBlockIds: freshness.collectTouchedBlockIds,
      collectConflictSensitiveBlockIds: freshness.collectConflictSensitiveBlockIds,
      findConflictingBlockIds: freshness.findConflictingBlockIds,
      findRequestSelectionConflictIds: freshness.findRequestSelectionConflictIds,
      findProposalFreshnessConflictIds: freshness.findProposalFreshnessConflictIds,
      findProposalFreshnessConflict: freshness.findProposalFreshnessConflict,
      classifyProposalReplayFailure: freshness.classifyProposalReplayFailure,
      mergeProposalDraftsIntoDocument: replay.mergeProposalDraftsIntoDocument,
      replayProposalDraft: replay.replayProposalDraft,
      assertAppliedProposalHasRealChanges: replay.assertAppliedProposalHasRealChanges,
      buildSelectiveRevertDocument,
    };
    expect(Object.keys(legacyStore).sort()).toEqual(Object.keys(publicApi).sort());
    for (const [name, value] of Object.entries(publicApi)) {
      expect(legacyStore[name as keyof typeof legacyStore], name).toBe(value);
    }
  });
});
