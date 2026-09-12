import type { LedgerSchemaFailure } from "@/lib/library-schema";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const te = createCurrentLocaleTranslator("error");

const LEDGER_SCHEMA_ERROR_BRAND = "sigma-studio.ledger-schema-error";

export class LedgerSchemaError extends Error {
  readonly ledgerSchemaErrorBrand = LEDGER_SCHEMA_ERROR_BRAND;
  readonly failure: LedgerSchemaFailure;

  constructor(failure: LedgerSchemaFailure) {
    super(te("electron.ledger.schemaMismatch"));
    this.name = "LedgerSchemaError";
    this.failure = failure;
  }
}

export function toLedgerSchemaFailure(error: unknown): LedgerSchemaFailure | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const candidate = error as {
    ledgerSchemaErrorBrand?: unknown;
    failure?: unknown;
  };
  return candidate.ledgerSchemaErrorBrand === LEDGER_SCHEMA_ERROR_BRAND
    && typeof candidate.failure === "object"
    && candidate.failure !== null
    ? candidate.failure as LedgerSchemaFailure
    : null;
}
