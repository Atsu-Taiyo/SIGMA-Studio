"use client";

import { AlertTriangle, Check, ClipboardCopy, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { describeLedgerSchemaViolation, type LedgerSchemaFailure } from "@/lib/library-schema";
import { writeTextToClipboard } from "@/lib/clipboard-text";

import { buildLedgerRepairPrompt } from "./ledger-schema-failure";
import styles from "./LedgerSchemaFailurePanel.module.css";
import { useT } from "@/lib/i18n/react";

interface LedgerSchemaFailurePanelProps {
  failure: LedgerSchemaFailure;
  reloading?: boolean;
  onReload: () => void;
}

function describeActualVersion(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** 台帳を変更せず、スキーマ違反とAI修復プロンプトだけを提示する画面。 */
export function LedgerSchemaFailurePanel({ failure, reloading = false, onReload }: LedgerSchemaFailurePanelProps) {
  const t = useT("workspace");
  const tError = useT("error");

  const prompt = useMemo(() => buildLedgerRepairPrompt(failure, tError, t), [failure, tError, t]);
  const [copyResult, setCopyResult] = useState<{ prompt: string; result: "copied" | "failed" } | null>(null);
  const copyState = copyResult?.prompt === prompt ? copyResult.result : "idle";

  useEffect(() => {
    if (copyState !== "copied") {
      return;
    }
    const timeoutId = window.setTimeout(() => setCopyResult(null), 2400);
    return () => window.clearTimeout(timeoutId);
  }, [copyState]);

  const copyPrompt = async () => {
    setCopyResult({ prompt, result: await writeTextToClipboard(prompt) ? "copied" : "failed" });
  };

  return (
    <main className={styles.root} role="alert" aria-live="polite" data-testid="ledger-schema-failure">
      <div className={styles.card}>
        <header className={styles.header}>
          <span className={styles.headerIcon} aria-hidden="true">
            <AlertTriangle size={20} />
          </span>
          <div className={styles.headerText}>
            <h2 className={styles.title}>{t("ledger.title")}</h2>
            <p className={styles.subtitle}>{t("ledger.subtitle")}</p>
          </div>
        </header>

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t("ledger.infoHeading")}</h3>
          <p className={styles.pathRow}>
            <span>{t("ledger.ledgerJson")}</span>
            <span className={styles.pathValue}>{failure.libraryPath}</span>
          </p>
          <p className={styles.errorMessage}>
            {t("ledger.versionLine", { replace: { expected: failure.expectedVersion, actual: describeActualVersion(failure.actualVersion) } })}
          </p>
        </section>

        {failure.violations.length > 0 && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>{t("ledger.violationsTitle", { replace: { count: failure.violations.length } })}</h3>
            <ul className={styles.failureList}>
              {failure.violations.map((item, index) => {
                const described = describeLedgerSchemaViolation(item, t);
                return (
                <li key={`${item.path}:${index}`} className={styles.failureItem}>
                  <span className={styles.failurePath}>{item.path}</span>
                  <span className={styles.failureMessage}>{described.message}</span>
                  <div className={styles.failureValues}>
                    <span className={styles.failureValueRow}>
                      <span className={styles.failureValueLabel}>{t("ledger.expected")}</span>
                      <span className={styles.failureValue}>{described.expected}</span>
                    </span>
                    <span className={styles.failureValueRow}>
                      <span className={styles.failureValueLabel}>{t("ledger.received")}</span>
                      <span className={styles.failureValue}>{item.received}</span>
                    </span>
                  </div>
                </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className={styles.promptWidget}>
          <div className={styles.promptHeader}>
            <div className={styles.promptHeaderText}>
              <span className={styles.promptTitle}>{t("ledger.promptTitle")}</span>
              <span className={styles.promptHint}>{t("ledger.promptHint")}</span>
            </div>
            <Button tone="primary" onClick={() => void copyPrompt()}>
              {copyState === "copied" ? <Check size={15} /> : <ClipboardCopy size={15} />}
              {copyState === "copied" ? t("ledger.copied") : t("ledger.copyPrompt")}
            </Button>
          </div>
          <textarea
            className={styles.prompt}
            value={prompt}
            readOnly
            spellCheck={false}
            aria-label={t("ledger.promptAria")}
            onFocus={(event) => event.currentTarget.select()}
          />
          {copyState === "failed" && (
            <p className={styles.copyFailed}>{t("ledger.copyFailed")}</p>
          )}
        </section>

        <div className={styles.actions}>
          <Button onClick={onReload} disabled={reloading}>
            <RotateCcw size={15} />
            {reloading ? t("ledger.reloading") : t("action.reloadShort")}
          </Button>
        </div>
      </div>
    </main>
  );
}
