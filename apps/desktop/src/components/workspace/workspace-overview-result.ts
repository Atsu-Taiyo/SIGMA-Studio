import type { LedgerSchemaFailure } from "@/lib/library-schema";
import type { WorkspaceOverviewResult } from "@/lib/workspace-repository";

export type LedgerSchemaErrorResult = Extract<
  WorkspaceOverviewResult,
  { state: "ledger-schema-error" }
>;

export function enterLedgerSchemaFailure(
  result: WorkspaceOverviewResult,
  setFailure: (failure: LedgerSchemaFailure) => void,
): result is LedgerSchemaErrorResult {
  if (result.state !== "ledger-schema-error") {
    return false;
  }

  setFailure(result.failure);
  return true;
}
