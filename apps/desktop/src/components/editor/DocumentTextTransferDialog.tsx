"use client";

import { Check, ClipboardCopy, ClipboardPaste, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Stack } from "@/components/ui/layout";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { writeTextToClipboard } from "@/lib/clipboard-text";
import {
  classifyPastedDocumentText,
  pastedDocumentFile,
} from "@/lib/document-text-transfer";
import { useT } from "@/lib/i18n/react";
import { recoverSigmaDocument } from "@/lib/sigma-doc-schema";

import styles from "./DocumentTextTransferDialog.module.css";

/**
 * 教材をテキストで受け渡す 2 つのダイアログ。
 *
 * 書き出しは押した瞬間にクリップボードへ入るのが最短なので、コピー面は
 * **クリップボードが拒否されたときだけ**開く逃げ道として持つ (テキストが読めなければ
 * 手で選ぶこともできず行き止まりになる)。取り込み面は貼り付けた中身をその場で
 * 検証してから `onImport` へ渡し、形式の誤りはステータスバーではなく入力欄の
 * すぐ下で返す。
 */

interface DocumentTextCopyDialogProps {
  /** 書き出したテキスト。 */
  text: string;
  onClose: () => void;
}

/** クリップボードへ書けなかったときに、手で選んでコピーするための面。 */
export function DocumentTextCopyDialog({ text, onClose }: DocumentTextCopyDialogProps) {
  const t = useT("editor");
  const [copied, setCopied] = useState(false);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    // 開いた時点で全選択しておけば、ボタンを押せなくても ⌘C だけで持ち出せる。
    textAreaRef.current?.select();
  }, []);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timeoutId = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  const copy = async () => {
    if (await writeTextToClipboard(text)) {
      setCopied(true);
      return;
    }
    textAreaRef.current?.select();
  };

  return (
    <ModalFrame open onDismiss={onClose} size="lg" ariaLabel={t("textTransfer.copyTitle")}>
      <ModalHeader
        title={(
          <span className={styles.title}>
            <ClipboardCopy size={18} aria-hidden="true" />
            <span>{t("textTransfer.copyTitle")}</span>
          </span>
        )}
        description={t("textTransfer.copyDescription")}
        onClose={onClose}
      />
      <ModalBody padding="xl">
        <Stack gap="md">
          <textarea
            ref={textAreaRef}
            className={styles.textArea}
            data-modal-initial-focus
            readOnly
            spellCheck={false}
            value={text}
            aria-label={t("textTransfer.copyTextAria")}
          />
          <div className={styles.actions}>
            <span className={styles.status} role="status" aria-live="polite">
              {copied ? t("textTransfer.copied") : ""}
            </span>
            <Button tone="primary" onClick={() => void copy()}>
              {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
              {t("textTransfer.copyButton")}
            </Button>
          </div>
        </Stack>
      </ModalBody>
    </ModalFrame>
  );
}

interface DocumentTextImportDialogProps {
  /** 検証済みのテキストをファイルとして取り込み経路へ渡す。 */
  onImport: (file: File) => Promise<void>;
  onClose: () => void;
}

/** SigmaDoc JSON / TeX ソースを貼り付けて教材として開く面。 */
export function DocumentTextImportDialog({ onImport, onClose }: DocumentTextImportDialogProps) {
  const t = useT("editor");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const submit = async () => {
    if (importing) {
      return;
    }
    const pasted = classifyPastedDocumentText(value);
    if (pasted.kind === "empty") {
      setError(t("textTransfer.emptyError"));
      return;
    }
    if (pasted.kind === "invalidJson") {
      setError(t("textTransfer.invalidJsonError"));
      return;
    }
    if (pasted.kind === "sigmadoc") {
      // スキーマ違反はステータスバーへ流さず、貼り直せるこの場で理由を出す。
      const recovered = recoverSigmaDocument(pasted.value);
      if (!recovered.ok) {
        setError(recovered.error);
        return;
      }
    }
    setImporting(true);
    try {
      await onImport(pastedDocumentFile(pasted, t("textTransfer.pastedTitle")));
    } finally {
      setImporting(false);
    }
    onClose();
  };

  return (
    <ModalFrame open onDismiss={onClose} size="lg" ariaLabel={t("textTransfer.importTitle")}>
      <ModalHeader
        title={(
          <span className={styles.title}>
            <ClipboardPaste size={18} aria-hidden="true" />
            <span>{t("textTransfer.importTitle")}</span>
          </span>
        )}
        description={t("textTransfer.importDescription")}
        onClose={onClose}
      />
      <ModalBody padding="xl">
        <Stack gap="md">
          <textarea
            className={styles.textArea}
            data-modal-initial-focus
            spellCheck={false}
            disabled={importing}
            placeholder={t("textTransfer.importPlaceholder")}
            aria-label={t("textTransfer.importTextAria")}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
          />
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <div className={styles.actions}>
            <span className={styles.status} />
            <Button onClick={onClose} disabled={importing}>{t("common.cancel")}</Button>
            <Button tone="primary" disabled={importing} onClick={() => void submit()}>
              {importing ? t("textTransfer.importing") : t("textTransfer.importButton")}
            </Button>
          </div>
        </Stack>
      </ModalBody>
    </ModalFrame>
  );
}
