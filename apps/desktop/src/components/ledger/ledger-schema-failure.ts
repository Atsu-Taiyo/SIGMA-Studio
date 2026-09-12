import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";
import {
  describeLedgerSchemaViolation,
  LIBRARY_SCHEMA_SOURCE_PATH,
  LIBRARY_VERSION,
  type LedgerSchemaFailure,
} from "@/lib/library-schema";

const DEFAULT_ERROR_TRANSLATE = createCurrentLocaleTranslator("error");
const DEFAULT_WORKSPACE_TRANSLATE = createCurrentLocaleTranslator("workspace");

function translate(t: Translate<"error">, key: string, replace?: Record<string, unknown>): string {
  return (t as unknown as (key: string, options?: { replace: Record<string, unknown> }) => string)(
    key,
    replace ? { replace } : undefined,
  );
}

function formatSchemaFailureLines(
  failure: LedgerSchemaFailure,
  tError: Translate<"error">,
  tWorkspace: Translate<"workspace">,
): string {
  return failure.violations
    .map((violation, index) => {
      const described = describeLedgerSchemaViolation(violation, tWorkspace);
      return [
        `${index + 1}. ${violation.path}`,
        translate(tError, "ledgerRepair.prompt.message", { message: described.message }),
        translate(tError, "ledgerRepair.prompt.expected", { value: described.expected }),
        translate(tError, "ledgerRepair.prompt.actual", { value: violation.received }),
      ].join("\n");
    })
    .join("\n");
}

/** そのままAIへ貼れば、台帳データだけの修復に入れる自己完結プロンプト。 */
export function buildLedgerRepairPrompt(
  failure: LedgerSchemaFailure,
  tError: Translate<"error"> = DEFAULT_ERROR_TRANSLATE,
  tWorkspace: Translate<"workspace"> = DEFAULT_WORKSPACE_TRANSLATE,
): string {
  const sections = [
    [
      translate(tError, "ledgerRepair.prompt.intro"),
      "",
      translate(tError, "ledgerRepair.prompt.targetHeading"),
      translate(tError, "ledgerRepair.prompt.ledgerJson", { path: failure.libraryPath }),
      translate(tError, "ledgerRepair.prompt.schemaSource", { path: LIBRARY_SCHEMA_SOURCE_PATH }),
    ].join("\n"),
    [
      translate(tError, "ledgerRepair.prompt.violationsHeading", { count: failure.violations.length }),
      formatSchemaFailureLines(failure, tError, tWorkspace),
    ].join("\n"),
    [
      translate(tError, "ledgerRepair.prompt.tasksHeading"),
      translate(tError, "ledgerRepair.prompt.task1"),
      translate(tError, "ledgerRepair.prompt.task2", { version: LIBRARY_VERSION }),
      translate(tError, "ledgerRepair.prompt.task3"),
      translate(tError, "ledgerRepair.prompt.task4"),
      translate(tError, "ledgerRepair.prompt.task5"),
      "",
      translate(tError, "ledgerRepair.prompt.dataOnly"),
    ].join("\n"),
    [
      translate(tError, "ledgerRepair.prompt.verifyHeading"),
      translate(tError, "ledgerRepair.prompt.verify"),
    ].join("\n"),
  ];

  return `${sections.join("\n\n")}\n`;
}
