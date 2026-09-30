"use client";

import { Plus, Tag, X } from "lucide-react";
import { useId, useRef, useState, type ChangeEvent } from "react";

import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import type { ProblemNode } from "@/features/document";
import {
  CUSTOM_FRAME_STYLE_ID,
  getProblemFrameStyleId,
  PROBLEM_FRAME_STYLE_OPTIONS,
  problemFrameClassName,
  setProblemCustomFrame,
  setProblemFrameEnabled,
  setProblemFrameStyle,
} from "@/lib/problem-frame";
import { findProblemFrameLibraryEntry, useProblemFrameLibrary } from "@/lib/problem-frame-library";
import { ProblemCustomFrameEditor, svgDataUrl } from "./ProblemCustomFrameEditor";
import styles from "./ProblemSettingsDialog.module.css";
import { useT } from "@/lib/i18n/react";

const PROBLEM_TAG_SEPARATOR_PATTERN = /[,、\n]/;

interface ProblemSettingsDialogProps {
  problem: ProblemNode;
  onChange: (updater: (problem: ProblemNode) => ProblemNode) => void;
  onClose: () => void;
}

export function ProblemSettingsDialog({ problem, onChange, onClose }: ProblemSettingsDialogProps) {
  const t = useT("settings");
  const frameEnabled = problem.frame?.enabled === true;
  const selectedFrameStyleId = frameEnabled ? getProblemFrameStyleId(problem) : "none";
  const library = useProblemFrameLibrary();
  // The drawing tools stay open while a custom frame is in use, and can be opened to start a new one.
  const [customEditorOpen, setCustomEditorOpen] = useState(selectedFrameStyleId === CUSTOM_FRAME_STYLE_ID);
  // Which shelf entry is being edited. A problem opened with a frame from elsewhere starts unsaved.
  const [activeId, setActiveId] = useState<string | null>(
    () => (selectedFrameStyleId === CUSTOM_FRAME_STYLE_ID ? findProblemFrameLibraryEntry(problem.frame?.custom)?.id : null) ?? null,
  );
  const [startingNew, setStartingNew] = useState(false);
  const customSelected = frameEnabled && selectedFrameStyleId === CUSTOM_FRAME_STYLE_ID && !startingNew;

  return (
    <ModalFrame
      open
      onDismiss={onClose}
      size="md"
      ariaLabel={t("problem.title")}
      surfaceClassName={styles.dialog}
    >
      <ModalHeader
        title={t("problem.title")}
        description={t("problem.description")}
        onClose={onClose}
      />
      <ModalBody padding="xl">
        <div className={styles.content}>
          <section className={styles.section} aria-labelledby="problem-numbering-heading">
            <h3 className={styles.sectionTitle} id="problem-numbering-heading">{t("problem.numbering")}</h3>
            <label className={styles.checkboxField}>
              <input
                type="checkbox"
                checked={problem.numbering?.enabled !== false}
                onChange={(event) => onChange((current) => setProblemNumberingEnabled(current, event.target.checked))}
              />
              <span>{t("problem.showNumber")}</span>
            </label>
            <div className={styles.numberingGrid}>
              <label className={styles.field}>
                <span>{t("problem.fixedNumber")}</span>
                <input
                  data-testid="problem-number-value"
                  type="number"
                  min={1}
                  step={1}
                  placeholder={t("problem.autoPlaceholder")}
                  value={problem.numbering?.value ?? ""}
                  onChange={(event) => {
                    const rawValue = event.target.value;
                    const value = rawValue === "" ? undefined : Number(rawValue);
                    onChange((current) => setProblemNumberValue(current, value));
                  }}
                />
              </label>
              <label className={styles.field}>
                <span>{t("problem.numberSize")}</span>
                <input
                  data-testid="problem-number-font-size"
                  type="number"
                  min={8}
                  max={48}
                  value={problem.numbering?.fontSize ?? 16}
                  onChange={(event) => onChange((current) => setProblemNumberFontSize(current, Number(event.target.value)))}
                />
              </label>
            </div>
          </section>

          <section className={styles.section} aria-labelledby="problem-frame-heading">
            <h3 className={styles.sectionTitle} id="problem-frame-heading">{t("problem.frame")}</h3>
            <div className={styles.frameGrid} role="group" aria-label={t("problem.frameOptionsAria")}>
              <FrameStyleButton
                id="none"
                label={t("problem.frameNone")}
                description={t("problem.frameNoneDescription")}
                selected={!frameEnabled}
                onClick={() => {
                  setCustomEditorOpen(false);
                  setStartingNew(false);
                  onChange((current) => setProblemFrameEnabled(current, false));
                }}
              />
              {PROBLEM_FRAME_STYLE_OPTIONS.map((option) => (
                <FrameStyleButton
                  key={option.id}
                  id={option.id}
                  label={t(option.labelKey)}
                  description={t(option.descriptionKey)}
                  selected={frameEnabled && selectedFrameStyleId === option.id}
                  title={`/${option.commandName}`}
                  onClick={() => {
                    setCustomEditorOpen(false);
                    setStartingNew(false);
                    onChange((current) => setProblemFrameStyle(current, option.id));
                  }}
                />
              ))}
              {library.map((entry) => (
                <FrameStyleButton
                  key={entry.id}
                  id={`library-${entry.id}`}
                  testId={`problem-frame-library-${entry.id}`}
                  label={entry.name}
                  description={t("problem.frameStyle.custom.libraryDescription")}
                  selected={customSelected && activeId === entry.id}
                  previewSvg={entry.custom.svg}
                  onClick={() => {
                    setActiveId(entry.id);
                    setStartingNew(false);
                    setCustomEditorOpen(true);
                    onChange((current) => setProblemCustomFrame(current, entry.custom));
                  }}
                />
              ))}
              <FrameStyleButton
                id={CUSTOM_FRAME_STYLE_ID}
                testId="problem-frame-new"
                label={t("problem.frameStyle.custom.addLabel")}
                description={t("problem.frameStyle.custom.addDescription")}
                selected={customEditorOpen && startingNew}
                onClick={() => {
                  setActiveId(null);
                  setStartingNew(true);
                  setCustomEditorOpen(true);
                }}
              />
            </div>
            {customEditorOpen && (
              <ProblemCustomFrameEditor
                problem={problem}
                onChange={onChange}
                activeId={activeId}
                onActiveChange={setActiveId}
                fresh={startingNew}
                onFreshChange={setStartingNew}
              />
            )}
          </section>

          <section className={styles.section} aria-labelledby="problem-tags-heading">
            <h3 className={styles.sectionTitle} id="problem-tags-heading">{t("problem.tags")}</h3>
            <ProblemTagsInput problem={problem} onChange={onChange} />
          </section>
        </div>
      </ModalBody>
    </ModalFrame>
  );
}

function FrameStyleButton({
  id,
  label,
  description,
  selected,
  title,
  previewSvg,
  testId,
  onClick,
}: {
  id: string;
  testId?: string;
  label: string;
  description: string;
  selected: boolean;
  title?: string;
  /** The user's own drawing, shown in the tile of the custom frame. */
  previewSvg?: string;
  onClick: () => void;
}) {
  const isCustomTile = id === CUSTOM_FRAME_STYLE_ID || id.startsWith("library-");
  const previewClassName = id === "none" || isCustomTile
    ? "problem-frame-style-preview"
    : problemFrameClassName("problem-frame-style-preview", id);

  return (
    <button
      type="button"
      className={`problem-frame-style-button ${selected ? "selected" : ""}`}
      aria-pressed={selected}
      title={title}
      data-testid={testId ?? `problem-frame-style-${id}`}
      onClick={onClick}
    >
      <span className={previewClassName} data-problem-frame-style={isCustomTile ? CUSTOM_FRAME_STYLE_ID : id} aria-hidden="true">
        {isCustomTile
          ? previewSvg
            // The drawing is previewed as an image, where it cannot run anything.
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={svgDataUrl(previewSvg)} alt="" />
            : <Plus size={14} />
          : <span />}
      </span>
      <span className="problem-frame-style-label">{label}</span>
      <span className="problem-frame-style-description">{description}</span>
    </button>
  );
}

function ProblemTagsInput({
  problem,
  onChange,
}: {
  problem: ProblemNode;
  onChange: ProblemSettingsDialogProps["onChange"];
}) {
  const t = useT("settings");
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState("");

  const updateTags = (updater: (tags: string[]) => string[]) => {
    onChange((current) => ({ ...current, tags: updater(current.tags) }));
  };

  const appendTags = (rawTags: string[]) => {
    const additions = rawTags.map(normalizeProblemTag).filter(Boolean);
    if (additions.length === 0) {
      return false;
    }
    updateTags((tags) => [...tags, ...additions]);
    return true;
  };

  const commitDraft = () => {
    if (appendTags([draft])) {
      setDraft("");
    }
  };

  const handleDraftChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextValue = event.target.value;
    if (!PROBLEM_TAG_SEPARATOR_PATTERN.test(nextValue)) {
      setDraft(nextValue);
      return;
    }
    const parts = nextValue.split(PROBLEM_TAG_SEPARATOR_PATTERN);
    const nextDraft = parts.pop() ?? "";
    appendTags(parts);
    setDraft(nextDraft);
  };

  return (
    <div
      className="problem-tag-input-shell"
      onMouseDown={(event) => {
        const target = event.target;
        if (target instanceof HTMLElement && target.closest("button")) {
          return;
        }
        inputRef.current?.focus();
      }}
    >
      {problem.tags.map((tag, index) => (
        <span className="problem-tag-tip" key={`${tag}-${index}`}>
          <Tag size={12} aria-hidden="true" />
          <span className="problem-tag-tip-label">{tag}</span>
          <button
            type="button"
            className="problem-tag-tip-remove"
            title={t("problem.tagDelete")}
            aria-label={t("problem.tagDeleteNamed", { tag })}
            onClick={() => updateTags((tags) => tags.filter((_, tagIndex) => tagIndex !== index))}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        id={inputId}
        className={styles.tagInput}
        value={draft}
        placeholder={problem.tags.length === 0 ? t("problem.tagPlaceholder") : ""}
        onChange={handleDraftChange}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitDraft();
          } else if (event.key === "Backspace" && draft === "" && problem.tags.length > 0) {
            event.preventDefault();
            updateTags((tags) => tags.slice(0, -1));
          }
        }}
        onBlur={commitDraft}
      />
    </div>
  );
}

function normalizeProblemTag(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function setProblemNumberingEnabled(problem: ProblemNode, enabled: boolean): ProblemNode {
  if (!enabled) {
    return { ...problem, numbering: { ...(problem.numbering ?? {}), enabled: false } };
  }
  const numbering = { ...(problem.numbering ?? {}) };
  delete numbering.enabled;
  return { ...problem, numbering: Object.keys(numbering).length > 0 ? numbering : undefined };
}

function setProblemNumberFontSize(problem: ProblemNode, fontSize: number): ProblemNode {
  if (!Number.isFinite(fontSize) || fontSize <= 0) {
    return problem;
  }
  return { ...problem, numbering: { ...(problem.numbering ?? {}), fontSize } };
}

function setProblemNumberValue(problem: ProblemNode, value: number | undefined): ProblemNode {
  const numbering = { ...(problem.numbering ?? {}) };
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    numbering.value = value;
  } else {
    delete numbering.value;
  }
  return { ...problem, numbering: Object.keys(numbering).length > 0 ? numbering : undefined };
}
