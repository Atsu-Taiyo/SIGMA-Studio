import type { SigmaDocumentRecoveryIssue } from "@/lib/sigma-doc-schema";
import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";

const DEFAULT_EDITOR_TRANSLATE = createCurrentLocaleTranslator("editor");

export function formatDocumentRecoveryStatus(
  issues: SigmaDocumentRecoveryIssue[],
  hasRecoveryBackup: boolean,
  t: Translate<"editor"> = DEFAULT_EDITOR_TRANSLATE,
): string | null {
  if (issues.length === 0) {
    return null;
  }
  const calloutCount = issues.filter((issue) => (
    issue.kind === "overlayShape" && issue.type === "callout"
  )).length;
  const otherCount = issues.length - calloutCount;
  const details = [
    calloutCount > 0 ? t("runtimeStatus.recoveryCallouts", { count: calloutCount }) : null,
    otherCount > 0 ? t("runtimeStatus.recoveryOther", { count: otherCount }) : null,
  ].filter((value): value is string => Boolean(value)).join(t("runtimeStatus.recoveryDetailSeparator"));
  const protectionMessage = hasRecoveryBackup
    ? t("runtimeStatus.recoveryBackupProtected")
    : t("runtimeStatus.recoverySourceUnchanged");
  return t("runtimeStatus.recoveryLoadedPartially", { details, protection: protectionMessage });
}
