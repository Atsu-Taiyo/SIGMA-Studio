"use client";

import { Check, Copy, Search, SearchX, SquareFunction } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { MathPreview } from "@/features/rendering/adapters/react";
import { IconButton } from "@/components/ui/Button";
import { Grid, Inline, Inset, Stack } from "@/components/ui/layout";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { writeTextToClipboard } from "@/lib/clipboard-text";
import { useT } from "@/lib/i18n/react";
import { filterTexCommandReferences } from "@/lib/tex-command-reference";
import type { TexCommandReference } from "@/lib/tex-command-reference";

import styles from "./TexCommandReferenceDialog.module.css";

interface TexCommandReferenceDialogProps {
  onClose: () => void;
}

interface CopyState {
  id: string;
  result: "copied" | "failed";
}

/**
 * 教材作成でよく使うTeXコマンドを、入力例と実表示の対応で探せる参照画面。
 * 数式の編集やコマンド仕様の判定は担わず、既存のMathPreviewで結果だけを表示する。
 */
export function TexCommandReferenceDialog({ onClose }: TexCommandReferenceDialogProps) {
  const t = useT("tex");
  const [query, setQuery] = useState("");
  const [copyState, setCopyState] = useState<CopyState | null>(null);
  const references = useMemo(() => filterTexCommandReferences(query, t), [query, t]);
  let copyAnnouncement = "";
  if (copyState?.result === "copied") {
    copyAnnouncement = t("dialog.copySuccess");
  } else if (copyState?.result === "failed") {
    copyAnnouncement = t("dialog.copyFailed");
  }

  useEffect(() => {
    if (!copyState) {
      return;
    }
    const timeout = window.setTimeout(() => setCopyState(null), 1600);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const copyCommand = async (reference: TexCommandReference) => {
    const copied = await writeTextToClipboard(reference.command);
    setCopyState({ id: reference.id, result: copied ? "copied" : "failed" });
  };

  return (
    <ModalFrame
      open
      onDismiss={onClose}
      size="xl"
      ariaLabel={t("dialog.title")}
    >
      <ModalHeader
        title={(
          <span className={styles.title}>
            <SquareFunction size={18} aria-hidden="true" />
            <span>{t("dialog.title")}</span>
          </span>
        )}
        description={t("dialog.description")}
        onClose={onClose}
      />

      <ModalBody className={styles.body} padding="none" scroll="hidden">
        <span className="visually-hidden" role="status" aria-live="polite">
          {copyAnnouncement}
        </span>
        <Inset className={styles.toolbar} space="lg">
          <Inline className={styles.searchRow} gap="md" justify="between" wrap>
            <label className={styles.search}>
              <Search size={16} aria-hidden="true" />
              <input
                data-modal-initial-focus
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("dialog.searchPlaceholder")}
                aria-label={t("dialog.searchAria")}
              />
            </label>
            <span className={styles.resultCount} role="status" aria-live="polite">
              {t("dialog.resultCount", { count: references.length })}
            </span>
          </Inline>
        </Inset>

        <Inset className={styles.results} space="xl">
          {references.length > 0 ? (
            <Grid className={styles.grid} columns={4} gap="sm" role="list" aria-label={t("dialog.listAria")}>
              {references.map((reference) => (
                <Inset className={styles.card} space="md" role="listitem" key={reference.id}>
                  <Stack gap="sm">
                    <strong className={styles.cardLabel}>{reference.label}</strong>
                    <div className={styles.preview} role="img" aria-label={t("dialog.previewAria", { label: reference.label })}>
                      <MathPreview tex={reference.previewTex} />
                    </div>
                    <Inline className={styles.commandRow} gap="xs" align="start" justify="between">
                      <code className={styles.command} title={reference.command}>{reference.command}</code>
                      <IconButton
                        className={styles.copyButton}
                        label={copyState?.id === reference.id && copyState.result === "copied"
                          ? t("dialog.copiedAria", { label: reference.label })
                          : t("dialog.copyAria", { label: reference.label })}
                        tone="ghost"
                        size="sm"
                        data-copy-state={copyState?.id === reference.id ? copyState.result : undefined}
                        onClick={() => void copyCommand(reference)}
                      >
                        {copyState?.id === reference.id && copyState.result === "copied"
                          ? <Check size={15} aria-hidden="true" />
                          : <Copy size={15} aria-hidden="true" />}
                      </IconButton>
                    </Inline>
                    {reference.aliases?.length ? (
                      <span className={styles.aliases}>{t("dialog.aliases", { aliases: reference.aliases.join(" / ") })}</span>
                    ) : null}
                  </Stack>
                </Inset>
              ))}
            </Grid>
          ) : (
            <Stack className={styles.empty} gap="sm" align="center" justify="center" role="status">
              <SearchX size={24} aria-hidden="true" />
              <strong>{t("dialog.emptyTitle")}</strong>
              <span>{t("dialog.emptyBody")}</span>
            </Stack>
          )}
        </Inset>
      </ModalBody>
    </ModalFrame>
  );
}
