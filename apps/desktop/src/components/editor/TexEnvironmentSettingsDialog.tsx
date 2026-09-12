"use client";

import { Braces } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import {
  MathEnvironmentValueProvider,
  MathPreview,
  useMathEnvironment,
} from "@/features/rendering/adapters/react";
import { Button } from "@/components/ui/Button";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { createMathMacroSet } from "@/lib/math-macros";
import { parseTexPreamble } from "@/lib/tex-preamble";
import { applyTexBracketEditToTextarea, resolveTexBracketEdit } from "@/lib/tex-bracket-pairs";
import {
  resolveExampleTexPreamble,
  resolveTexEnvironmentPreviewExamples,
} from "@/lib/tex-environment-examples";

import styles from "./TexEnvironmentSettingsDialog.module.css";
import { useT } from "@/lib/i18n/react";

interface TexEnvironmentSettingsDialogProps {
  preamble?: string;
  onChange: (preamble: string | undefined) => void;
  onClose: () => void;
}

export function TexEnvironmentSettingsDialog({ preamble, onChange, onClose }: TexEnvironmentSettingsDialogProps) {
  const t = useT("settings");
  const tCommon = useT("common");
  const tTex = useT("tex");
  const examplePreamble = useMemo(() => resolveExampleTexPreamble(tTex), [tTex]);
  const previewExamples = useMemo(() => resolveTexEnvironmentPreviewExamples(tTex), [tTex]);
  const [draft, setDraft] = useState(preamble ?? "");
  const [previewTex, setPreviewTex] = useState(previewExamples[0].tex);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const parsed = useMemo(() => parseTexPreamble(draft, tTex), [draft, tTex]);
  // プレビューは編集中の前文だけを差し替え、**組版スタイルは文書のまま**にする。
  // ここで既定に戻すと `texDefault` の文書でプレビューだけ displaystyle になり、
  // 「プレビューで合わせたのに本文では大きさが違う」を作る。
  const documentEnvironment = useMathEnvironment();
  const previewEnvironment = useMemo(() => ({
    macroSet: createMathMacroSet(draft),
    typesetStyle: documentEnvironment.typesetStyle,
  }), [documentEnvironment.typesetStyle, draft]);
  const macroCount = Object.keys(parsed.macros).length;
  const canSave = parsed.issues.length === 0;

  const save = () => {
    if (!canSave) {
      editorRef.current?.focus();
      return;
    }
    const normalized = draft.trim();
    onChange(normalized || undefined);
    onClose();
  };

  return (
    <ModalFrame open onDismiss={onClose} size="lg" ariaLabel={t("tex.title")}>
      <ModalHeader
        title={(
          <span className={styles.title}>
            <Braces size={18} aria-hidden="true" />
            <span>{t("tex.title")}</span>
          </span>
        )}
        description={t("tex.description")}
        onClose={onClose}
      />

      <ModalBody className={styles.body} padding="xl">
        <section className={styles.editorSection} aria-labelledby="tex-preamble-label">
          <div className={styles.sectionHeading}>
            <div>
              <label id="tex-preamble-label" className={styles.label} htmlFor="tex-preamble-editor">{t("tex.preamble")}</label>
              <p className={styles.hint}>
                <code>\newcommand</code>{t("tex.preambleHelpSeparator")}<code>\renewcommand</code>{t("tex.preambleHelpSeparator")}<code>\providecommand</code>{t("tex.preambleHelpSuffix")}
              </p>
            </div>
            <Button
              size="sm"
              onClick={() => {
                setDraft(examplePreamble);
                setPreviewTex(previewExamples[0].tex);
              }}
            >
              {t("tex.insertExample")}
            </Button>
          </div>
          <textarea
            ref={editorRef}
            id="tex-preamble-editor"
            data-modal-initial-focus
            className={styles.codeEditor}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            // 本文の TeX 入力欄と同じ括弧オートペア。`\newcommand{` の閉じ括弧を手で
            // 打たずに済む。
            onKeyDown={(event) => {
              const textarea = event.currentTarget;
              const bracketEdit = resolveTexBracketEdit(event, {
                selectionEnd: textarea.selectionEnd,
                selectionStart: textarea.selectionStart,
                value: textarea.value,
              });
              if (!bracketEdit) {
                return;
              }
              event.preventDefault();
              setDraft(applyTexBracketEditToTextarea(textarea, bracketEdit));
            }}
            placeholder={examplePreamble}
            spellCheck={false}
            aria-invalid={!canSave}
            aria-describedby="tex-preamble-status"
          />
          <div id="tex-preamble-status" className={styles.status} aria-live="polite">
            {parsed.issues.length > 0 ? (
              <ul className={styles.issueList}>
                {parsed.issues.map((issue, index) => (
                  <li key={`${issue.line}-${index}`}>{t("tex.issue", { line: issue.line, message: issue.message })}</li>
                ))}
              </ul>
            ) : (
              <span>{macroCount > 0 ? t("tex.macroCount", { macros: macroCount }) : t("tex.macroEmpty")}</span>
            )}
          </div>
        </section>

        <section className={styles.previewSection} aria-labelledby="tex-preview-label">
          <label id="tex-preview-label" className={styles.label} htmlFor="tex-environment-preview-input">{t("tex.preview")}</label>
          <input
            id="tex-environment-preview-input"
            className={styles.previewInput}
            value={previewTex}
            onChange={(event) => setPreviewTex(event.target.value)}
            placeholder={previewExamples[0].tex}
            spellCheck={false}
          />
          <div className={styles.exampleList} role="group" aria-label={t("tex.exampleAria")}>
            {previewExamples.map((example) => (
              <button
                key={example.id}
                type="button"
                className={styles.exampleButton}
                data-selected={previewTex === example.tex}
                aria-pressed={previewTex === example.tex}
                title={example.tex}
                onClick={() => {
                  if (!parsed.macros.answerbox) setDraft(examplePreamble);
                  setPreviewTex(example.tex);
                }}
              >
                {example.label}
              </button>
            ))}
          </div>
          <div className={styles.previewCanvas} aria-label={t("tex.previewCanvas")}>
            {canSave && previewTex.trim() ? (
              <MathEnvironmentValueProvider environment={previewEnvironment}>
                <MathPreview tex={previewTex} displayMode />
              </MathEnvironmentValueProvider>
            ) : (
              <span className={styles.previewEmpty}>{t("tex.previewEmpty")}</span>
            )}
          </div>
        </section>

        <footer className={styles.footer}>
          <Button onClick={onClose}>{tCommon("actions.cancel")}</Button>
          <Button tone="primary" onClick={save}>{t("tex.save")}</Button>
        </footer>
      </ModalBody>
    </ModalFrame>
  );
}
