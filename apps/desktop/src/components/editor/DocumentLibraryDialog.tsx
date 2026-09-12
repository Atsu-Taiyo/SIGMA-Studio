"use client";

import { Copy, FilePlus, FileText, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import { Button, IconButton } from "@/components/ui/Button";
import { DocumentTitleText } from "@/features/rendering/adapters/react";
import { Inline, Stack } from "@/components/ui/layout";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import type { DocumentMetadata } from "@/lib/storage";
import { useAppLocale, useT } from "@/lib/i18n/react";
import type { AppLocale } from "@/lib/i18n";
import type { Translate } from "@/lib/i18n/translator";

interface DocumentLibraryDialogProps {
  open: boolean;
  documents: DocumentMetadata[];
  activeFileId: string;
  activeDocumentTitle: string;
  openFileIds: string[];
  onClose: () => void;
  onCreate: () => void | Promise<void>;
  onOpen: (fileId: string) => void | Promise<void>;
  onDuplicate: (fileId: string) => void | Promise<void>;
  onDelete: (fileId: string) => void | Promise<void>;
}

/**
 * 保存済み教材の選択と管理操作を、共通モーダル上のコンパクトな一覧にまとめる。
 * 教材の保存・切り替え・削除そのものは所有せず、EditorShellの処理へ委ねる。
 */
export function DocumentLibraryDialog({
  open,
  documents,
  activeFileId,
  activeDocumentTitle,
  openFileIds,
  onClose,
  onCreate,
  onOpen,
  onDuplicate,
  onDelete,
}: DocumentLibraryDialogProps) {
  const t = useT("workspace");
  const locale = useAppLocale();

  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const deleteTarget = useMemo(
    () => documents.find((document) => document.fileId === deleteTargetId) ?? null,
    [deleteTargetId, documents],
  );

  const closeDialog = () => {
    setDeleteTargetId(null);
    onClose();
  };

  const confirmDelete = async () => {
    if (!deleteTarget) {
      return;
    }
    const fileId = deleteTarget.fileId;
    setDeleteTargetId(null);
    await onDelete(fileId);
  };

  return (
    <>
      <ModalFrame
        open={open}
        onDismiss={closeDialog}
        size="lg"
      >
        <ModalHeader
          title={t("library.title")}
          description={t("library.description")}
          onClose={closeDialog}
          actions={(
            <Button tone="primary" size="sm" onClick={() => void onCreate()}>
              <FilePlus size={15} aria-hidden="true" />
              {t("action.newMaterial")}
            </Button>
          )}
        />
        <ModalBody className="document-library-list" padding="lg">
          <Stack gap="xs" role="list">
            {documents.map((metadata) => {
              const isOpen = openFileIds.includes(metadata.fileId);
              const isActive = metadata.fileId === activeFileId;
              const title = isActive ? activeDocumentTitle : metadata.title || t("untitledMaterial");
              return (
                <article
                  className={`document-library-item ${isActive ? "active" : ""}`}
                  key={metadata.fileId}
                  role="listitem"
                >
                  <button
                    type="button"
                    className="document-library-item-main"
                    aria-label={t("library.open", { replace: { title } })}
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => void onOpen(metadata.fileId)}
                  >
                    <span className="document-library-item-icon" aria-hidden="true">
                      <FileText size={17} />
                    </span>
                    <Stack className="document-library-item-copy" gap="xs">
                      <Inline gap="sm" align="center">
                        <h3><DocumentTitleText title={title} /></h3>
                        {isActive ? (
                          <span className="document-library-status">{t("label.editing")}</span>
                        ) : isOpen ? (
                          <span className="document-library-status">{t("label.openInTab")}</span>
                        ) : null}
                      </Inline>
                      <p>{formatDocumentUpdatedAt(metadata.updatedAt, locale, t)}</p>
                    </Stack>
                  </button>
                  <Inline className="document-library-actions" gap="xs" role="group" aria-label={t("library.itemActions", { replace: { title } })}>
                    <IconButton
                      label={t("action.duplicate")}
                      tone="ghost"
                      size="sm"
                      onClick={() => void onDuplicate(metadata.fileId)}
                    >
                      <Copy size={15} aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      label={t("action.deleteShort")}
                      tone="danger"
                      size="sm"
                      disabled={documents.length <= 1}
                      onClick={() => setDeleteTargetId(metadata.fileId)}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </IconButton>
                  </Inline>
                </article>
              );
            })}
          </Stack>
        </ModalBody>
      </ModalFrame>

      <ModalFrame
        open={deleteTarget !== null}
        onDismiss={() => setDeleteTargetId(null)}
        size="sm"
        layer="nested"
      >
        <ModalHeader title={t("action.deleteMaterial")} onClose={() => setDeleteTargetId(null)} />
        <ModalBody padding="xl">
          <Stack gap="xl">
            <p className="document-library-delete-copy">
              {t("confirm.deleteMaterial", { replace: { title: deleteTarget?.title || t("untitledMaterial") } })}
            </p>
            <Inline gap="sm" justify="end">
              <Button tone="secondary" onClick={() => setDeleteTargetId(null)}>
                {t("action.cancelLong")}
              </Button>
              <Button tone="danger" onClick={() => void confirmDelete()}>
                {t("action.deleteShort")}
              </Button>
            </Inline>
          </Stack>
        </ModalBody>
      </ModalFrame>
    </>
  );
}

/**
 * 更新日時。**日付・時刻の組み立ても UI 言語で行う** — `"ja-JP"` 決め打ちだと
 * 英語 UI に日本式の並び (2026/8/27) が残る。語順も言語で変わるので、
 * 「日付 時刻 更新」を連結せず 1 つのキーに埋める。
 */
function formatDocumentUpdatedAt(
  value: string,
  locale: AppLocale,
  t: Translate<"workspace">,
): string {
  if (!value) {
    return t("library.noUpdatedAt");
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return t("library.noUpdatedAt");
  }

  return t("library.updatedAt", {
    replace: {
      date: date.toLocaleDateString(locale),
      time: date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }),
    },
  });
}
