"use client";

import { AlertTriangle, Check, ClipboardCopy, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/Button";
import { buildAppCrashPrompt, type AppCrashReport } from "@/components/app-crash-report";
import { writeTextToClipboard } from "@/lib/clipboard-text";
import { useT } from "@/lib/i18n/react";

import styles from "@/components/editor/DocumentOpenFailurePanel.module.css";

interface AppCrashScreenProps {
  report: AppCrashReport;
  onReload: () => void;
}

/**
 * 画面が真っ白になる代わりに出す全画面のエラー表示。教材を開けなかった時の
 * 失敗画面 (DocumentOpenFailurePanel) と同じ見た目・同じ「AIに貼るプロンプト」
 * の作法に揃える — ユーザーから見ればどちらも「開けなかった理由を見て直す」画面。
 */
export function AppCrashScreen({ report, onReload }: AppCrashScreenProps) {
  const t = useT("error");
  const prompt = useMemo(() => buildAppCrashPrompt(report, t), [report, t]);
  const [copyResult, setCopyResult] = useState<{ prompt: string; result: "copied" | "failed" } | null>(null);
  const copyState = copyResult?.prompt === prompt ? copyResult.result : "idle";

  useEffect(() => {
    if (copyState !== "copied") {
      return;
    }
    const timeoutId = window.setTimeout(() => setCopyResult(null), 2400);
    return () => window.clearTimeout(timeoutId);
  }, [copyState]);

  return (
    <div className={styles.root} role="alert" data-testid="app-crash-screen">
      <div className={styles.card}>
        <header className={styles.header}>
          <span className={styles.headerIcon} aria-hidden="true">
            <AlertTriangle size={20} />
          </span>
          <div className={styles.headerText}>
            <h2 className={styles.title}>{t("crash.title")}</h2>
            <p className={styles.subtitle}>{t("crash.subtitle")}</p>
          </div>
        </header>

        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>{t("crash.errorHeading")}</h3>
          <p className={styles.errorMessage}>{report.message}</p>
        </section>

        {report.stack && (
          <section className={styles.section}>
            <h3 className={styles.sectionTitle}>{t("crash.locationHeading")}</h3>
            <textarea
              className={styles.prompt}
              value={report.stack.split("\n").slice(0, 12).join("\n")}
              readOnly
              spellCheck={false}
              aria-label={t("crash.locationAria")}
            />
          </section>
        )}

        <section className={styles.promptWidget}>
          <div className={styles.promptHeader}>
            <div className={styles.promptHeaderText}>
              <span className={styles.promptTitle}>{t("crash.promptTitle")}</span>
              <span className={styles.promptHint}>{t("crash.promptHint")}</span>
            </div>
            <Button
              tone="primary"
              onClick={() => {
                void writeTextToClipboard(prompt).then((ok) => {
                  setCopyResult({ prompt, result: ok ? "copied" : "failed" });
                });
              }}
            >
              {copyState === "copied" ? <Check size={15} /> : <ClipboardCopy size={15} />}
              {copyState === "copied" ? t("crash.copied") : t("crash.copyPrompt")}
            </Button>
          </div>
          <textarea
            className={styles.prompt}
            value={prompt}
            readOnly
            spellCheck={false}
            aria-label={t("crash.promptAria")}
            onFocus={(event) => event.currentTarget.select()}
          />
          {copyState === "failed" && (
            <p className={styles.copyFailed}>{t("crash.copyFailed")}</p>
          )}
        </section>

        <div className={styles.actions}>
          <Button onClick={onReload}>
            <RotateCcw size={15} />
            {t("crash.reload")}
          </Button>
        </div>
      </div>
    </div>
  );
}
