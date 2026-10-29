"use client";

import { Plus, SquarePen, Tag, X } from "lucide-react";
import { useId, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";

import { Disclosure } from "@/components/ui/Disclosure";
import { Stack } from "@/components/ui/layout";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Select, type SelectItem, type SelectOptionGroup } from "@/components/ui/Select";
import { SettingsField, SettingsSection, Switch } from "@/components/ui/settings";
import type { ProblemAreaKind, ProblemNode, ProblemNumbering } from "@/features/document";
import { isSafeCssFontFamily } from "@/features/document/css-safety";
import { isProblemLeadBlank, isProblemLeadFolded } from "@/features/rendering/core";
import { getProblemNumberFontSize } from "@/features/text-editing";
import { localFontMenuGroups } from "@/lib/local-font-menu";
import { useCustomFonts } from "@/lib/use-custom-fonts";
import {
  CUSTOM_FRAME_STYLE_ID,
  getProblemFrameStyleId,
  PROBLEM_FRAME_STYLE_OPTIONS,
  problemFrameClassName,
  setProblemCustomFrame,
  setProblemFrameEnabled,
  setProblemFrameStyle,
} from "@/lib/problem-frame";
import { customFrameImageSrc, getCustomFrameStyle } from "@/lib/custom-frame";
import { findFrameLibraryEntry, useFrameLibrary } from "@/lib/frame-library";
import { CustomFrameEditor } from "./CustomFrameEditor";
import { ProblemNumberLayoutSettings, ProblemAreaLayoutSettings, ProblemBorderLayoutSettings } from "./ProblemLayoutSettings";
import { filterFontFamilyGroups } from "./editor-shell/constants";
import { setProblemLeadShown } from "./page-canvas/problem-area-model";
import { ProblemSettingsPreview, type ProblemSettingsPreviewPart } from "./ProblemSettingsPreview";
import { SettingsNumberField } from "./SettingsNumberField";
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
  const library = useFrameLibrary();
  const fontItems = useProblemFontItems();
  // The drawing tools stay open while a custom frame is in use, and can be opened to start a new one.
  const [customEditorOpen, setCustomEditorOpen] = useState(selectedFrameStyleId === CUSTOM_FRAME_STYLE_ID);
  // Which shelf entry is being edited. A problem opened with a frame from elsewhere starts unsaved.
  const [activeId, setActiveId] = useState<string | null>(
    () => (selectedFrameStyleId === CUSTOM_FRAME_STYLE_ID ? findFrameLibraryEntry(problem.frame?.custom)?.id : null) ?? null,
  );
  const [startingNew, setStartingNew] = useState(false);
  // Bumped whenever the user picks another frame of their own, so the frame editor swaps its drafts.
  const [framePick, setFramePick] = useState(0);
  const customSelected = frameEnabled && selectedFrameStyleId === CUSTOM_FRAME_STYLE_ID && !startingNew;
  const [highlight, setHighlight] = useState<ProblemSettingsPreviewPart | null>(null);
  const [layoutArea, setLayoutArea] = useState<ProblemAreaKind>("prompt");
  const numberShown = problem.numbering?.enabled !== false;
  const leadShown = !isProblemLeadFolded(problem);
  const focusProps = (part: ProblemSettingsPreviewPart) => ({
    onFocus: () => setHighlight(part),
    onMouseEnter: () => setHighlight(part),
  });
  const fontLabel = (value: string | undefined) => (value ? findFontLabel(fontItems, value) : undefined) ?? t("problem.documentFont");

  return (
    <ModalFrame
      open
      onDismiss={onClose}
      size="lg"
      ariaLabel={t("problem.title")}
      surfaceClassName={styles.dialog}
    >
      <ModalHeader
        title={(
          <span className={styles.title}>
            <SquarePen size={18} aria-hidden="true" />
            <span>{t("problem.title")}</span>
          </span>
        )}
        onClose={onClose}
      />
      <ModalBody padding="none" scroll="hidden" className={styles.body}>
        <div className={styles.workbench}>
          <aside className={styles.previewPane} aria-label={t("problem.preview")}>
            <div className={styles.previewStage}>
              <ProblemSettingsPreview problem={problem} highlight={highlight} />
            </div>
            <p className={styles.previewSummary}>{t("problem.previewFont", { font: fontLabel(problem.fontFamily) })}</p>
          </aside>

          <div className={styles.form} onMouseLeave={() => setHighlight(null)}>
            <Stack gap="xl">
              <SettingsSection
                id="problem-settings-typography"
                title={t("problem.typography")}
                className={styles.section}
                {...focusProps("font")}
              >
                <div className={styles.fieldGrid} data-columns="2">
                  <SettingsField label={t("problem.textFont")} htmlFor="problem-font-family">
                    <FontFamilySelect
                      id="problem-font-family"
                      testId="problem-font-family"
                      items={fontItems}
                      value={problem.fontFamily}
                      emptyLabel={t("problem.documentFont")}
                      onChange={(fontFamily) => onChange((current) => setProblemFontFamily(current, fontFamily))}
                    />
                  </SettingsField>
                  <SettingsField label={t("problem.numberFont")} htmlFor="problem-number-font-family" {...focusProps("number")}>
                    <FontFamilySelect
                      id="problem-number-font-family"
                      testId="problem-number-font-family"
                      items={fontItems}
                      value={problem.numbering?.fontFamily}
                      emptyLabel={t("problem.sameAsText")}
                      onChange={(fontFamily) => onChange((current) => setProblemNumberFontFamily(current, fontFamily))}
                    />
                  </SettingsField>
                </div>
                <p className={styles.hint}>{t("problem.textFontHint")}</p>
              </SettingsSection>

              <SettingsSection
                id="problem-settings-numbering"
                title={t("problem.numbering")}
                className={styles.section}
                actions={(
                  <Switch
                    data-testid="problem-number-shown"
                    checked={numberShown}
                    label={t("problem.showNumber")}
                    onCheckedChange={(checked) => onChange((current) => setProblemNumberingEnabled(current, checked))}
                  />
                )}
                {...focusProps("number")}
              >
                {numberShown ? (
                  <>
                    <div className={styles.fieldGrid} data-columns="3">
                      <SettingsNumberField
                        optional
                        id="problem-number-value"
                        testId="problem-number-value"
                        label={t("problem.fixedNumber")}
                        integer
                        min={1}
                        emptyValue={1}
                        placeholder={t("problem.autoPlaceholder")}
                        value={problem.numbering?.value}
                        onChange={(value) => onChange((current) => setProblemNumberValue(current, value))}
                      />
                      <SettingsNumberField
                        id="problem-number-font-size"
                        testId="problem-number-font-size"
                        label={t("problem.numberSize")}
                        min={1}
                        max={128}
                        unit="pt"
                        value={getProblemNumberFontSize(problem)}
                        onChange={(value) => onChange((current) => setProblemNumberFontSize(current, value))}
                      />
                      <SettingsField label={t("problem.numberFormat")} htmlFor="problem-number-format">
                        <Select
                          id="problem-number-format"
                          data-testid="problem-number-format"
                          className={styles.select}
                          value={problem.numbering?.format ?? "decimal"}
                          options={[
                            { value: "decimal", label: "1, 2, 3" },
                            { value: "fullwidth", label: "１, ２, ３" },
                          ]}
                          onChange={(format) => onChange((current) => ({
                            ...current,
                            numbering: { ...current.numbering, format: format as ProblemNumbering["format"] },
                          }))}
                        />
                      </SettingsField>
                    </div>
                    <Disclosure label={t("problem.numberLayout")} summary={t("problem.numberLayout")}>
                      <ProblemNumberLayoutSettings problem={problem} onChange={onChange} />
                    </Disclosure>
                  </>
                ) : null}
              </SettingsSection>

              <SettingsSection
                id="problem-settings-lead"
                title={t("problem.lead")}
                className={styles.section}
                actions={(
                  <Switch
                    data-testid="problem-lead-shown"
                    checked={leadShown}
                    label={t("problem.showLead")}
                    // オフにすると、導入文の文字は捨てて行ごと畳む。
                    onCheckedChange={(checked) => onChange((current) => setProblemLeadShown(current, checked))}
                  />
                )}
                {...focusProps("lead")}
              >
                <p className={styles.hint}>
                  {isProblemLeadBlank(problem) ? t("problem.showLeadHint") : t("problem.leadFilledHint")}
                </p>
              </SettingsSection>

              <SettingsSection
                id="problem-settings-frame"
                title={t("problem.frame")}
                className={styles.section}
                {...focusProps("frame")}
              >
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
                        setFramePick((pick) => pick + 1);
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
                      setFramePick((pick) => pick + 1);
                    }}
                  />
                </div>
                {frameEnabled && <ProblemBorderLayoutSettings problem={problem} onChange={onChange} />}
                {customEditorOpen && (
                  <CustomFrameEditor
                    target={{ kind: "problem", id: problem.id }}
                    custom={problem.frame?.custom}
                    onCustomChange={(updater) => onChange((current) => {
                      const next = updater(current.frame?.custom);
                      return next ? setProblemCustomFrame(current, next) : current;
                    })}
                    activeId={activeId}
                    onActiveChange={setActiveId}
                    fresh={startingNew}
                    onFreshChange={setStartingNew}
                    pick={framePick}
                    renderPreview={(custom, paperClassName) => (
                      // Same classes and stylesheet as the real problem, so what is shown is what is printed.
                      <div
                        className={`${problemFrameClassName("problem-area-flow-unit with-frame", CUSTOM_FRAME_STYLE_ID)} first-frame-area last-frame-area ${paperClassName}`}
                        style={getCustomFrameStyle(custom, "px") as CSSProperties}
                        data-testid="problem-custom-frame-preview"
                      >
                        {t("problem.custom.previewSample")}
                      </div>
                    )}
                  />
                )}
              </SettingsSection>

              <SettingsSection
                id="problem-settings-layout"
                className={styles.section}
                {...focusProps(layoutArea)}
              >
                <Disclosure label={t("problem.areaLayout")} summary={t("problem.areaLayout")} contentClassName={styles.disclosureStack}>
                  <ProblemAreaLayoutSettings problem={problem} onChange={onChange} area={layoutArea} onAreaChange={(area) => {
                    setLayoutArea(area);
                    setHighlight(area);
                  }} />
                </Disclosure>
              </SettingsSection>

              <SettingsSection id="problem-settings-tags" title={t("problem.tags")} className={styles.section}>
                <ProblemTagsInput problem={problem} onChange={onChange} />
              </SettingsSection>
            </Stack>
          </div>
        </div>
      </ModalBody>
    </ModalFrame>
  );
}

/**
 * ツールバーの書体メニューと同じ並び (追加フォント → この環境にある書体) を、問題設定でも使う。
 */
function useProblemFontItems(): SelectItem[] {
  const tChrome = useT("chrome");
  const { customFonts, systemFonts } = useCustomFonts();
  return useMemo(() => {
    const groups = localFontMenuGroups(filterFontFamilyGroups(""), systemFonts) as ReturnType<typeof filterFontFamilyGroups>;
    const custom = customFonts.map((font) => ({ value: font.cssFamily, label: font.displayName, style: { fontFamily: font.cssFamily } }));
    return [
      ...(custom.length > 0 ? [{ label: tChrome("format.font.customGroup"), options: custom }] : []),
      ...groups.map((group) => ({
        label: tChrome(`format.font.group.${group.id}` as never) as string,
        options: group.options.map((option) => ({ value: option.value, label: option.label, style: { fontFamily: option.value } })),
      })),
    ];
  }, [customFonts, systemFonts, tChrome]);
}

function isOptionGroup(item: SelectItem): item is SelectOptionGroup {
  return Array.isArray((item as SelectOptionGroup).options);
}

function findFontLabel(items: readonly SelectItem[], value: string): string | undefined {
  for (const item of items) {
    const options = isOptionGroup(item) ? item.options : [item];
    const match = options.find((option) => option.value === value);
    if (match) return match.label;
  }
  return undefined;
}

/**
 * 書体の選択欄。先頭の「既定」(空) は書体を指定しないことを表す。一覧に無い書体 (別の端末で
 * 付けた書体など) を持っていたら、それも選べる候補として先頭に足し、黙って消さない。
 */
function FontFamilySelect({
  id,
  testId,
  items,
  value,
  emptyLabel,
  onChange,
}: {
  id: string;
  testId: string;
  items: SelectItem[];
  value: string | undefined;
  emptyLabel: string;
  onChange: (value: string | undefined) => void;
}) {
  const options = useMemo<SelectItem[]>(() => {
    const known = value ? findFontLabel(items, value) !== undefined : true;
    return [
      { value: "", label: emptyLabel },
      ...(known || !value ? [] : [{ value, label: primaryFontName(value), style: { fontFamily: value } }]),
      ...items,
    ];
  }, [emptyLabel, items, value]);
  return (
    <Select
      id={id}
      data-testid={testId}
      className={styles.select}
      value={value ?? ""}
      options={options}
      menuWidth="trigger"
      onChange={(next) => onChange(next || undefined)}
    />
  );
}

function primaryFontName(fontFamily: string): string {
  return fontFamily.split(",")[0]?.trim().replace(/^["']|["']$/gu, "") || fontFamily;
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
            ? <img src={customFrameImageSrc(previewSvg)} alt="" />
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

  const acceptDraft = (nextValue: string) => {
    if (!PROBLEM_TAG_SEPARATOR_PATTERN.test(nextValue)) {
      setDraft(nextValue);
      return;
    }
    const parts = nextValue.split(PROBLEM_TAG_SEPARATOR_PATTERN);
    const nextDraft = parts.pop() ?? "";
    appendTags(parts);
    setDraft(nextDraft);
  };

  const handleDraftChange = (event: ChangeEvent<HTMLInputElement>) => {
    // While the IME is converting, the field holds a reading (びぶん), not the word yet. It is split
    // into chips once the conversion is confirmed (compositionend).
    if ((event.nativeEvent as InputEvent).isComposing) {
      setDraft(event.target.value);
      return;
    }
    acceptDraft(event.target.value);
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
        // The confirmed text is final now: separators typed in it split it as typed ones do.
        onCompositionEnd={(event) => acceptDraft(event.currentTarget.value)}
        onKeyDown={(event) => {
          // Chromium delivers the Enter that confirms a conversion while the text is still composed,
          // and writes the confirmed text into the field after this keydown. Committing here made the
          // chip and then had the same word written back into the emptied field, behind the chip.
          // A Backspace that edits the composition belongs to the IME too, not to the last chip.
          if (event.nativeEvent.isComposing || event.keyCode === 229) {
            return;
          }
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

function setProblemFontFamily(problem: ProblemNode, fontFamily: string | undefined): ProblemNode {
  if (fontFamily && !isSafeCssFontFamily(fontFamily)) return problem;
  const next = { ...problem };
  if (fontFamily) next.fontFamily = fontFamily;
  else delete next.fontFamily;
  return next;
}

function setProblemNumberFontFamily(problem: ProblemNode, fontFamily: string | undefined): ProblemNode {
  if (fontFamily && !isSafeCssFontFamily(fontFamily)) return problem;
  const numbering = { ...(problem.numbering ?? {}) };
  if (fontFamily) numbering.fontFamily = fontFamily;
  else delete numbering.fontFamily;
  return { ...problem, numbering: Object.keys(numbering).length > 0 ? numbering : undefined };
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
