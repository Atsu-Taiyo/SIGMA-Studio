"use client";

import { AlertTriangle, Check, ClipboardCopy, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import {
  buildDocumentRepairPrompt,
  describeDocumentOpenFailureCause,
  type DocumentOpenFailure,
} from "@/components/editor/editor-shell/document-open-failure";
import { writeTextToClipboard } from "@/lib/clipboard-text";
import { useT } from "@/lib/i18n/react";

import styles from "./DocumentOpenFailurePanel.module.css";

interface DocumentOpenFailurePanelProps {
  failure: DocumentOpenFailure;
  reloading?: boolean;
  onReload: () => void;
}

/**
 * スキーマ違反や壊れたJSONで本文を組み立てられなかった教材の代わりに、
 * 「なぜ開けなかったのか」を編集キャンバスの中央へ出す画面。
 * 教材の内容は一切書き換えず、原因の提示とAIへ渡すプロンプトの受け渡しだけを担う。
 */
export function DocumentOpenFailurePanel({ failure, reloading = false, onReload }: DocumentOpenFailurePanelProps) {
  const t = useT("error");
  const prompt = useMemo(() => buildDocumentRepairPrompt(failure, t), [failure, t]);
  // コピー結果はプロンプト本文に紐付けて持つ。別の教材へ切り替わってプロンプトが
  // 変わった時点で、効果を無効化するためのeffectを挟まずに自然に idle へ戻る。
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
    <div className={styles.root} role="alert" aria-live="polite" data-testid="document-open-failure">
      <div className={styles.card}>
        <header className={styles.header}>
          <span className={styles.headerIcon} aria-hidden="true">
            <AlertTriangle size={20} />
          </span>
          <div className={styles.headerText}>
            <h2 className={styles.title}>{t("documentOpen.title")}</h2>
            <p className={styles.subtitle}>
              <span className={styles.documentName}>{failure.title}</span>
              {`${t("documentOpen.causeSeparator")}${describeDocumentOpenFailureCause(failure, t)}${t("documentOpen.unchangedSuffix")}`}
            </p>
          </div>
        </header>

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t("documentOpen.errorHeading")}</h3>
          <p className={styles.errorMessage}>{failure.error}</p>
          {failure.documentPath && (
            <p className={styles.pathRow}>
              <span>{t("documentOpen.documentJson")}</span>
              <span className={styles.pathValue}>{failure.documentPath}</span>
            </p>
          )}
        </section>

        {failure.failures.length > 0 && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>{t("documentOpen.violationsTitle", { replace: { count: failure.failures.length } })}</h3>
            <ul className={styles.failureList}>
              {failure.failures.map((item, index) => (
                <li key={`${item.path}:${index}`} className={styles.failureItem}>
                  <span className={styles.failurePath}>{item.path}</span>
                  <span className={styles.failureMessage}>{item.message}</span>
                  {(item.expected || item.received !== undefined) && (
                    <div className={styles.failureValues}>
                      {item.expected && (
                        <span className={styles.failureValueRow}>
                          <span className={styles.failureValueLabel}>{t("documentOpen.expected")}</span>
                          <span className={styles.failureValue}>{item.expected}</span>
                        </span>
                      )}
                      {item.received !== undefined && (
                        <span className={styles.failureValueRow}>
                          <span className={styles.failureValueLabel}>{t("documentOpen.actual")}</span>
                          <span className={styles.failureValue}>{item.received}</span>
                        </span>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className={styles.promptWidget}>
          <div className={styles.promptHeader}>
            <div className={styles.promptHeaderText}>
              <span className={styles.promptTitle}>{t("documentOpen.promptTitle")}</span>
              <span className={styles.promptHint}>{t("documentOpen.promptHint")}</span>
            </div>
            <Button
              tone="primary"
              onClick={() => {
                void copyPrompt();
              }}
            >
              {copyState === "copied" ? <Check size={15} /> : <ClipboardCopy size={15} />}
              {copyState === "copied" ? t("documentOpen.copied") : t("documentOpen.copyPrompt")}
            </Button>
          </div>
          <textarea
            className={styles.prompt}
            value={prompt}
            readOnly
            spellCheck={false}
            aria-label={t("documentOpen.promptAria")}
            onFocus={(event) => event.currentTarget.select()}
          />
          {copyState === "failed" && (
            <p className={styles.copyFailed}>{t("documentOpen.copyFailed")}</p>
          )}
        </section>

        <div className={styles.actions}>
          <Button onClick={onReload} disabled={reloading}>
            <RotateCcw size={15} />
            {reloading ? t("documentOpen.reloading") : t("documentOpen.reload")}
          </Button>
        </div>
      </div>
    </div>
  );
}
