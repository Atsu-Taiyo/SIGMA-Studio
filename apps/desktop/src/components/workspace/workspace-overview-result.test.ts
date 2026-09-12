import { describe, expect, it, vi } from "vitest";

import type { LedgerSchemaFailure } from "@/lib/library-schema";
import type { WorkspaceOverviewResult } from "@/lib/workspace-repository";

import { enterLedgerSchemaFailure } from "./workspace-overview-result";

describe("enterLedgerSchemaFailure", () => {
  it("enters the dedicated failure state when an operation detects a schema error after a successful load", () => {
    const failure: LedgerSchemaFailure = {
      libraryPath: "/tmp/data/library.json",
      expectedVersion: 4,
      actualVersion: 3,
      violations: [{
        path: "version",
        reason: { kind: "versionMismatch" as const },
        expected: "4",
        received: "3",
      }],
    };
    const initialLoad: WorkspaceOverviewResult = {
      state: "ready",
      overview: {
        activeWorkspaceId: "workspace_1",
        workspaces: [],
        folders: [],
        files: [],
      },
    };
    const operationResult: WorkspaceOverviewResult = {
      state: "ledger-schema-error",
      failure,
    };
    const setFailure = vi.fn<(failure: LedgerSchemaFailure) => void>();

    expect(enterLedgerSchemaFailure(initialLoad, setFailure)).toBe(false);
    expect(setFailure).not.toHaveBeenCalled();

    expect(enterLedgerSchemaFailure(operationResult, setFailure)).toBe(true);
    expect(setFailure).toHaveBeenCalledOnce();
    expect(setFailure).toHaveBeenCalledWith(failure);
  });
});
