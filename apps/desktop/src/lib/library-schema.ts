import type { Translate } from "@/lib/i18n/translator";

export const LIBRARY_VERSION = 4;
export const LIBRARY_SCHEMA_SOURCE_PATH = "apps/desktop/src/lib/library-schema.ts";

/**
 * スキーマ違反 1 件。
 *
 * **文言ではなく「何が起きたか」を持つ。** この 1 件は 2 か所へ流れる:
 * 画面 (`LedgerSchemaFailurePanel`, 表示言語) と、AI へ貼る修復プロンプト
 * (`ledger-schema-failure.ts`, 常に既定ロケール)。ここで訳文に確定すると、
 * 英語 UI で作った違反が日本語のプロンプトに英語で混ざる。読み手ごとに解決する。
 */
export type LedgerSchemaViolationReason =
  | { kind: "versionMismatch" }
  | { kind: "forbiddenField"; field: string };

export interface LedgerSchemaViolation {
  path: string;
  reason: LedgerSchemaViolationReason;
  /** 実測値。JSON 由来の機械値なので言語に依らない。 */
  received: string;
  /** 期待値。`null` は「フィールドが存在しないこと」= 読み手側で文言にする。 */
  expected: string | null;
}

/** 違反 1 件を読み手の言語で文にする。 */
export function describeLedgerSchemaViolation(
  violation: LedgerSchemaViolation,
  t: Translate<"workspace">,
): { message: string; expected: string } {
  // **ここで throw すると、台帳が壊れたときに開く復旧画面そのものが落ちる。**
  // 版ズレ (古い main.cjs が旧形式の payload を送る) で `reason` を欠く可能性が
  // あるので、素性の分からない違反は「不明」として描き切る。
  const reason = violation.reason as LedgerSchemaViolationReason | undefined;
  return {
    message: reason?.kind === "versionMismatch"
      ? t("ledger.versionMismatch")
      : reason?.kind === "forbiddenField"
        ? t("ledger.forbiddenField", { replace: { field: reason.field } })
        : t("ledger.unknownViolation"),
    expected: violation.expected ?? t("ledger.absentField"),
  };
}

export interface LedgerSchemaFailure {
  libraryPath: string;
  expectedVersion: number;
  actualVersion: unknown;
  violations: LedgerSchemaViolation[];
}

const FORBIDDEN_WORKSPACE_FIELDS = ["kind", "role", "remoteId", "memberCount"] as const;
const FORBIDDEN_FILE_FIELDS = ["kind", "cloudState", "remoteRevision"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 壊れた台帳の値は任意長。プロンプトや画面を膨らませないよう上限を設ける。 */
const MAX_DESCRIBED_VALUE_LENGTH = 200;

function describeValue(value: unknown): string {
  try {
    return truncateDescribedValue(JSON.stringify(value) ?? String(value));
  } catch {
    return truncateDescribedValue(String(value));
  }
}

function truncateDescribedValue(text: string): string {
  return text.length > MAX_DESCRIBED_VALUE_LENGTH
    ? `${text.slice(0, MAX_DESCRIBED_VALUE_LENGTH)}…`
    : text;
}

export function describeLedgerSchemaFailure(
  failure: LedgerSchemaFailure,
  t: Translate<"workspace">,
): string {
  const violations = failure.violations
    .map((violation) => t("ledger.violation", {
      replace: {
        path: violation.path,
        expected: describeLedgerSchemaViolation(violation, t).expected,
        received: violation.received,
      },
    }))
    .join(", ");
  return t("ledger.summary", {
    replace: {
      path: failure.libraryPath,
      expected: failure.expectedVersion,
      actual: describeValue(failure.actualVersion),
      count: failure.violations.length,
      violations,
    },
  });
}

export function findLedgerSchemaViolations(
  value: Record<string, unknown>,
): LedgerSchemaViolation[] {
  const violations: LedgerSchemaViolation[] = [];

  if (value.version !== LIBRARY_VERSION) {
    violations.push({
      path: "version",
      reason: { kind: "versionMismatch" },
      expected: String(LIBRARY_VERSION),
      received: describeValue(value.version),
    });
  }

  function collectForbiddenFields(
    table: "workspaces" | "files",
    rows: unknown,
    fields: readonly string[],
  ): void {
    if (!Array.isArray(rows)) {
      return;
    }
    rows.forEach((row, index) => {
      if (!isRecord(row)) {
        return;
      }
      for (const field of fields) {
        if (field in row) {
          violations.push({
            path: `${table}[${index}].${field}`,
            reason: { kind: "forbiddenField", field },
            expected: null,
            received: describeValue(row[field]),
          });
        }
      }
    });
  }

  collectForbiddenFields("workspaces", value.workspaces, FORBIDDEN_WORKSPACE_FIELDS);
  collectForbiddenFields("files", value.files, FORBIDDEN_FILE_FIELDS);

  return violations;
}
