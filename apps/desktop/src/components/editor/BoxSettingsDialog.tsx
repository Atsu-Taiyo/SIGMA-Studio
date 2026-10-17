"use client";

import { useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AlignCenter, AlignLeft, AlignRight, ChevronDown, Minus, Plus, RotateCcw } from "lucide-react";

import { BoxSettingsPreview, type BoxPreviewPaper } from "@/components/editor/BoxSettingsPreview";
import { BoxTitleEditor } from "@/components/editor/BoxTitleEditor";
import { ColorPalette } from "@/components/editor/ColorPalette";
import { ToolbarPopover } from "@/components/editor/ToolbarPopover";
import { Grid, Inline, Stack } from "@/components/ui/layout";
import { Select } from "@/components/ui/Select";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import type {
  BoxBlockChildBlock,
  BoxBlockNode,
  BoxFrameSpec,
  BoxSpacingPx,
  CustomFrame,
  InlineNode,
  MathFractionSizing,
} from "@/features/document";
import {
  resolveBoxStyles,
  boxFrameClassName,
  boxFrameHasSubtitle,
  boxFrameDecorationAttributes,
  boxFrameStyleVars,
  CUSTOM_BOX_STYLE_ID,
  getBoxCustomFrame,
  resolveBoxFrame,
} from "@/lib/box-blocks";
import { findFrameLibraryEntry, useFrameLibrary, type FrameLibraryEntry } from "@/lib/frame-library";
import { CustomFrameEditor } from "./CustomFrameEditor";
import { joinBoxColor, splitBoxColor } from "@/lib/box-color";
import { fillOpacityToPercent } from "@/lib/fill-opacity";
import { boxFrameFields, type BoxFrameField, type BoxFrameFieldGroup } from "@/lib/box-frame-fields";
import styles from "./BoxSettingsDialog.module.css";
import type { Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";

type BoxSettingsBlock = Pick<BoxBlockNode, "id" | "styleId" | "frame">;

interface BoxSettingsDialogProps {
  boxBlock: BoxSettingsBlock;
  title: InlineNode[];
  /** 2 欄の見出しを持つ箱だけが渡す。 */
  subtitle?: InlineNode[];
  /** 箱の本文 (開いた時点のもの)。プレビューを紙面と同じ中身で描く。 */
  body?: BoxBlockChildBlock[];
  /** 紙面での箱の幅と本文の字の大きさ。プレビューを紙面と同じ組版幅で組む。 */
  paper?: BoxPreviewPaper;
  mathFractionSizing?: MathFractionSizing | null;
  /** ⋯メニューの「タイトルを編集…」から開いたときだけタイトル入力へキャレットを置く。 */
  autoFocusTitle?: boolean;
  onStyleChange: (styleId: string) => void;
  onFrameChange: (patch: Partial<BoxFrameSpec>) => void;
  /**
   * Frames the box with the user's own drawing (`styleId: "custom"`). The updater receives the
   * box's drawing at the moment of writing; returning undefined leaves the box as it is. Without it
   * the dialog offers only the built-in styles.
   */
  onCustomFrameChange?: (updater: (previous: CustomFrame | undefined) => CustomFrame | undefined) => void;
  onTitleChange: (title: InlineNode[]) => void;
  onSubtitleChange?: (subtitle: InlineNode[]) => void;
  /** このスタイルで覚えている見た目を捨て、組み込みの既定へ戻す。 */
  onResetStyle: () => void;
  onClose: () => void;
}

type PaddingMode = "all" | "sides";

const DEFAULT_PADDING: BoxSpacingPx = {
  top: 12,
  right: 14,
  bottom: 12,
  left: 14,
};

/**
 * boxBlockのタイトルと見た目の設定を集約する。
 * タイトルは枠の中に直接書ける (紙面上の細い placeholder) が、そこは狙って当てにくい入力なので、
 * 「タイトルを付ける」ための確実な入口はここに置く。数式も本文と同じノードで入れられる。
 */
export function BoxSettingsDialog({
  boxBlock,
  title,
  subtitle,
  body,
  paper,
  mathFractionSizing,
  autoFocusTitle = false,
  onStyleChange,
  onFrameChange,
  onCustomFrameChange,
  onTitleChange,
  onSubtitleChange,
  onResetStyle,
  onClose,
}: BoxSettingsDialogProps) {
  const t = useT("settings");
  // 箱スタイルの説明は本文編集面の語彙なので `editor` namespace が持つ。
  const tEditor = useT("editor");
  const resolvedFrame = resolveBoxFrame(boxBlock);
  const [stylesOpen, setStylesOpen] = useState(false);
  const galleryId = useId();
  const boxStyles = resolveBoxStyles(tEditor);
  const selectedStyle = boxStyles.find((style) => style.id === boxBlock.styleId);
  const library = useFrameLibrary();
  const customFrame = getBoxCustomFrame(boxBlock);
  const isCustom = resolvedFrame.custom !== undefined;
  // 自作の枠を使っている間は、作る道具を開いたままにする (問題の設定と同じ)。
  const [customEditorOpen, setCustomEditorOpen] = useState(isCustom);
  // 棚のどの枠を直しているか。よそから来た枠の箱は、棚に無い状態から始まる。
  const [activeId, setActiveId] = useState<string | null>(() => findFrameLibraryEntry(customFrame)?.id ?? null);
  const [startingNew, setStartingNew] = useState(false);
  // 棚の枠を選び直す・新しく作り始めるたびに進める。枠エディタはこれで下書きを入れ替える。
  const [framePick, setFramePick] = useState(0);
  const activeEntry = isCustom ? library.find((entry) => entry.id === activeId) : undefined;
  const selectedStyleName = isCustom ? activeEntry?.name ?? t("box.customFrame") : selectedStyle?.displayName;
  const selectedStyleDescription = isCustom ? t("box.customFrameHint") : selectedStyle?.description;
  const selectBuiltInStyle = (styleId: string) => {
    setCustomEditorOpen(false);
    setStartingNew(false);
    onStyleChange(styleId);
  };
  const selectShelfFrame = (entry: FrameLibraryEntry) => {
    setActiveId(entry.id);
    setStartingNew(false);
    setCustomEditorOpen(true);
    setFramePick((pick) => pick + 1);
    onCustomFrameChange?.(() => entry.custom);
  };
  const hasNotchedCorners = boxBlock.styleId === "cornerbox" &&
    resolvedFrame.decorations?.some((decoration) => decoration.type === "titleDoubleRule");
  const padding = resolvedFrame.paddingPx ?? DEFAULT_PADDING;
  const [paddingMode, setPaddingMode] = useState<PaddingMode>(() => (
    hasUniformPadding(padding) ? "all" : "sides"
  ));
  const uniformPadding = hasUniformPadding(padding) ? padding.top : "";
  const hasSubtitle = boxFrameHasSubtitle(resolvedFrame);
  // 自作の枠では罫・地色・装飾は絵が決めるので、文字の色と太さだけを出す。
  const fields = boxFrameFields(resolvedFrame)
    .filter((field) => !isCustom || ((field.group === "title" || field.group === "body") && field.id !== "titleBackgroundColor"));
  const decorationFields = fields.filter((field) => field.group === "decoration");

  const patchPadding = (side: keyof BoxSpacingPx, value: number) => {
    onFrameChange({
      paddingPx: {
        ...padding,
        [side]: value,
      },
    });
  };

  return (
    <ModalFrame
      open
      onDismiss={onClose}
      size="xl"
      layer="nested"
      ariaLabel={t("box.title")}
      surfaceClassName={styles.dialog}
    >
      <ModalHeader
        title={t("box.title")}
        description={t("box.description")}
        onClose={onClose}
      />
      <ModalBody padding="xl">
        <div className={styles.workbench}>
          {/* 紙面と同じ描画・同じ組版幅で、その箱の中身をそのまま描く。設定を下へたどっても見えるよう上に留める。 */}
          <section className={styles.previewPanel} aria-label={t("box.preview")}>
            <div className={styles.previewHeader}>
              <span className={styles.previewHeading}>{t("box.preview")}</span>
              <strong className={styles.currentStyleName}>{selectedStyleName}</strong>
              <span className={styles.previewDescription}>{selectedStyleDescription}</span>
            </div>
            <div className={styles.livePreview} data-testid="box-live-preview">
              <BoxSettingsPreview
                box={boxBlock}
                title={title}
                subtitle={hasSubtitle ? subtitle ?? [] : undefined}
                body={body}
                paper={paper}
                mathFractionSizing={mathFractionSizing}
              />
            </div>
          </section>
          <Stack gap="xl" className={styles.controls}>
            <Stack as="section" gap="sm" aria-labelledby="box-settings-title-heading">
              <SectionHeading id="box-settings-title-heading" title={t("box.titleSection")} />
              <BoxTitleEditor
                value={title}
                mathFractionSizing={mathFractionSizing}
                autoFocus={autoFocusTitle}
                onChange={onTitleChange}
              />
              {hasSubtitle ? (
                <>
                  <SectionHeading id="box-settings-subtitle-heading" title={t("box.subtitleSection")} />
                  <BoxTitleEditor
                    value={subtitle ?? []}
                    mathFractionSizing={mathFractionSizing}
                    ariaLabel={t("box.subtitleSection")}
                    onChange={(next) => onSubtitleChange?.(next)}
                  />
                </>
              ) : null}
              <p className={styles.fieldHint}>{t("box.titleHint")}</p>
            </Stack>

            <Stack as="section" gap="md" aria-labelledby="box-settings-style-heading">
              <button
                type="button"
                className={styles.stylePicker}
                data-testid="box-style-picker"
                aria-expanded={stylesOpen}
                aria-controls={galleryId}
                onClick={() => setStylesOpen(open => !open)}
              >
                <span id="box-settings-style-heading">{t("box.style")}</span>
                <strong>{selectedStyleName}</strong>
                <ChevronDown size={16} aria-hidden="true" />
              </button>
              <Grid id={galleryId} columns={3} gap="sm" className={styles.styleGrid} hidden={!stylesOpen}>
                {boxStyles.map((style) => {
                  const selected = boxBlock.styleId === style.id;
                  return (
                    <button
                      key={style.id}
                      type="button"
                      className={styles.styleButton}
                      data-selected={selected}
                      aria-pressed={selected}
                      title={`/${style.commandName}`}
                      data-testid={`box-style-${style.id}`}
                      onClick={() => selectBuiltInStyle(style.id)}
                    >
                      <BoxStylePreview styleId={style.id} frame={style.frame} />
                      <span className={styles.styleLabel}>{style.displayName}</span>
                      <span className={styles.styleDescription}>{style.description}</span>
                    </button>
                  );
                })}
                {onCustomFrameChange ? (
                  <>
                    <span className={styles.styleGroupLabel}>{t("box.myFrames")}</span>
                    {library.map((entry) => {
                      const selected = isCustom && !startingNew && activeId === entry.id;
                      return (
                        <button
                          key={entry.id}
                          type="button"
                          className={styles.styleButton}
                          data-selected={selected}
                          aria-pressed={selected}
                          data-testid={`box-frame-library-${entry.id}`}
                          onClick={() => selectShelfFrame(entry)}
                        >
                          <BoxStylePreview
                            styleId={CUSTOM_BOX_STYLE_ID}
                            frame={resolveBoxFrame({ styleId: CUSTOM_BOX_STYLE_ID, frame: { ...boxBlock.frame, custom: entry.custom } })}
                          />
                          <span className={styles.styleLabel}>{entry.name}</span>
                          <span className={styles.styleDescription}>{t("box.myFrameDescription")}</span>
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      className={styles.styleButton}
                      data-selected={customEditorOpen && startingNew}
                      aria-pressed={customEditorOpen && startingNew}
                      data-testid="box-frame-new"
                      onClick={() => {
                        setActiveId(null);
                        setStartingNew(true);
                        setCustomEditorOpen(true);
                        setFramePick((pick) => pick + 1);
                      }}
                    >
                      <span className={styles.addFramePreview} aria-hidden="true"><Plus size={16} /></span>
                      <span className={styles.styleLabel}>{t("box.addFrame")}</span>
                      <span className={styles.styleDescription}>{t("box.addFrameDescription")}</span>
                    </button>
                  </>
                ) : null}
              </Grid>
            </Stack>

            {onCustomFrameChange && customEditorOpen ? (
              <Stack as="section" gap="md" aria-labelledby="box-settings-custom-frame-heading">
                <SectionHeading id="box-settings-custom-frame-heading" title={t("box.customFrame")} />
                <CustomFrameEditor
                  target={{ kind: "box", id: boxBlock.id }}
                  custom={customFrame}
                  onCustomChange={onCustomFrameChange}
                  activeId={activeId}
                  onActiveChange={setActiveId}
                  fresh={startingNew}
                  onFreshChange={setStartingNew}
                  pick={framePick}
                />
              </Stack>
            ) : null}

            <Grid columns={2} gap="xl" className={styles.settingsGrid}>
              <Stack as="section" gap="md" aria-labelledby="box-settings-frame-heading">
                <SectionHeading id="box-settings-frame-heading" title={t("box.frame")} />
                {isCustom ? (
                  <p className={styles.fieldHint}>{t("box.customFrameHint")}</p>
                ) : (
                  <>
                    <Grid columns={2} gap="md">
                      <NumberField
                        label={t("box.borderWidth")}
                        value={resolvedFrame.borderWidthPx ?? 1}
                        min={0}
                        max={5}
                        step={0.1}
                        onChange={(borderWidthPx) => onFrameChange({ borderWidthPx })}
                      />
                      {renderFields(fields, "border", onFrameChange, t)}
                    </Grid>

                    {hasNotchedCorners ? (
                      <p className={styles.fieldHint}>{t("box.notchedCorners")}</p>
                    ) : (
                      <>
                        <ControlGroup label={t("box.corner")}>
                          <SegmentedButton
                            selected={(resolvedFrame.cornerStyle ?? "sharp") === "sharp"}
                            onClick={() => onFrameChange({ cornerStyle: "sharp" })}
                          >
                            <span className={styles.cornerIcon} aria-hidden="true" />
                            {t("box.cornerSharp")}
                          </SegmentedButton>
                          <SegmentedButton
                            selected={resolvedFrame.cornerStyle === "round"}
                            onClick={() => onFrameChange({
                              cornerStyle: "round",
                              ...(!resolvedFrame.radiusPx ? { radiusPx: 4 } : {}),
                            })}
                          >
                            <span className={styles.cornerIcon} data-rounded="true" aria-hidden="true" />
                            {t("box.cornerRounded")}
                          </SegmentedButton>
                        </ControlGroup>

                        {resolvedFrame.cornerStyle === "round" ? (
                          <NumberField
                            label={t("box.cornerRadius")}
                            slider
                            value={resolvedFrame.radiusPx ?? 4}
                            min={0}
                            max={32}
                            step={1}
                            onChange={(radiusPx) => onFrameChange({ radiusPx })}
                          />
                        ) : null}
                      </>
                    )}
                  </>
                )}
                <ControlGroup label={t("box.titlePosition")}>
                  {([
                    ["l", t("box.titleLeft"), AlignLeft],
                    ["c", t("box.titleCenter"), AlignCenter],
                    ["r", t("box.titleRight"), AlignRight],
                  ] as const).map(([value, label, Icon]) => (
                    <SegmentedButton
                      key={value}
                      selected={(resolvedFrame.titlePosition ?? "l") === value}
                      onClick={() => onFrameChange({ titlePosition: value })}
                    >
                      <Icon size={15} aria-hidden="true" />
                      {label}
                    </SegmentedButton>
                  ))}
                </ControlGroup>
              </Stack>

              <Stack as="section" gap="md" aria-labelledby="box-settings-colors-heading">
                <SectionHeading id="box-settings-colors-heading" title={t("box.colors")} />
                <Grid columns={2} gap="md">
                  {renderFields(fields, "surface", onFrameChange, t)}
                  {renderFields(fields, "title", onFrameChange, t)}
                  {renderFields(fields, "body", onFrameChange, t)}
                </Grid>
              </Stack>

              {decorationFields.length > 0 ? (
                <Stack as="section" gap="md" aria-labelledby="box-settings-decoration-heading">
                  <SectionHeading id="box-settings-decoration-heading" title={t("box.decoration")} />
                  <Grid columns={2} gap="md">
                    {renderFields(fields, "decoration", onFrameChange, t)}
                  </Grid>
                </Stack>
              ) : null}

              {isCustom ? null : (
                <Stack as="section" gap="md" aria-labelledby="box-settings-padding-heading">
                  <Inline justify="between" align="center">
                    <SectionHeading id="box-settings-padding-heading" title={t("box.padding")} />
                    <div className={styles.modeSwitch} role="group" aria-label={t("box.paddingModeAria")}>
                      <SegmentedButton selected={paddingMode === "all"} onClick={() => setPaddingMode("all")}>
                        {t("box.paddingAll")}
                      </SegmentedButton>
                      <SegmentedButton selected={paddingMode === "sides"} onClick={() => setPaddingMode("sides")}>
                        {t("box.paddingEach")}
                      </SegmentedButton>
                    </div>
                  </Inline>

                  {paddingMode === "all" ? (
                    <NumberField
                      label={t("box.paddingAllValue")}
                      value={uniformPadding}
                      placeholder={t("box.paddingMixed")}
                      min={0}
                      max={200}
                      step={1}
                      onChange={(value) => onFrameChange({
                        paddingPx: {
                          top: value,
                          right: value,
                          bottom: value,
                          left: value,
                        },
                      })}
                    />
                  ) : (
                    <Grid columns={2} gap="md">
                      <NumberField
                        label={t("box.paddingTop")}
                        value={padding.top}
                        min={0}
                        max={200}
                        step={1}
                        onChange={(value) => patchPadding("top", value)}
                      />
                      <NumberField
                        label={t("box.paddingRight")}
                        value={padding.right}
                        min={0}
                        max={200}
                        step={1}
                        onChange={(value) => patchPadding("right", value)}
                      />
                      <NumberField
                        label={t("box.paddingBottom")}
                        value={padding.bottom}
                        min={0}
                        max={200}
                        step={1}
                        onChange={(value) => patchPadding("bottom", value)}
                      />
                      <NumberField
                        label={t("box.paddingLeft")}
                        value={padding.left}
                        min={0}
                        max={200}
                        step={1}
                        onChange={(value) => patchPadding("left", value)}
                      />
                    </Grid>
                  )}
                </Stack>
              )}
            </Grid>

            <Inline justify="between" align="center" className={styles.footer}>
              <p className={styles.fieldHint}>{t("box.rememberHint")}</p>
              <button type="button" className={styles.resetButton} onClick={onResetStyle}>
                <RotateCcw size={14} aria-hidden="true" />
                {t("box.resetStyle")}
              </button>
            </Inline>
          </Stack>
        </div>
      </ModalBody>
    </ModalFrame>
  );
}

/**
 * 決められる項目を 1 グループぶん描く。中身は {@link boxFrameFields} が持つので、ここは
 * 種類ごとの入力部品を選ぶだけ。装飾を足しても画面側の変更は要らない。
 */
function renderFields(
  fields: BoxFrameField[],
  group: BoxFrameFieldGroup,
  onFrameChange: (patch: Partial<BoxFrameSpec>) => void,
  t: Translate<"settings">,
): ReactNode {
  return fields
    .filter((field) => field.group === group)
    .map((field) => {
      const label = t(`box.field.${field.id}` as never) as string;
      if (field.kind === "color") {
        return (
          <ColorField
            key={field.id}
            fieldId={field.id}
            label={label}
            value={field.value}
            onChange={(color) => onFrameChange(field.patch(color))}
          />
        );
      }
      if (field.kind === "length") {
        return (
          <NumberField
            key={field.id}
            label={label}
            testId={`box-field-${field.id}`}
            value={field.value}
            min={field.min}
            max={field.max}
            step={field.step}
            onChange={(value) => onFrameChange(field.patch(value))}
          />
        );
      }
      // `Select` はボタンなので `label` で包んでも結び付かない。名前は id 参照で渡す。
      return (
        <div key={field.id} className={styles.field}>
          <span id={`box-settings-${field.id}-label`}>{label}</span>
          <Select
            className={styles.selectField}
            value={field.value}
            data-testid={`box-field-${field.id}`}
            aria-labelledby={`box-settings-${field.id}-label`}
            options={field.options.map((option) => ({
              value: option,
              label: t(`box.fieldOption.${option}` as never) as string,
              content: (
                <span className={styles.choiceOption}>
                  {field.id === "borderStyle" ? (
                    <span className={styles.lineSample} style={{ borderTopStyle: option as CSSProperties["borderTopStyle"] }} aria-hidden="true" />
                  ) : field.id === "titleFontWeight" ? (
                    <span aria-hidden="true" style={{ fontWeight: option === "bold" ? 700 : 400 }}>Aa</span>
                  ) : null}
                  {t(`box.fieldOption.${option}` as never) as string}
                </span>
              ),
            }))}
            onChange={(value) => onFrameChange(field.patch(value))}
          />
        </div>
      );
    });
}

/**
 * 色 1 つ。ダイアログの上に開くので、パレットの重なり順はモーダルの入れ子レイヤーへ乗せる。
 */
function ColorField({
  fieldId,
  label,
  value,
  onChange,
}: {
  fieldId: string;
  label: string;
  value: string;
  onChange: (color: string) => void;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const labelId = `box-settings-${fieldId.replace(/\./g, "-")}-label`;
  // 色と不透明度は 8 桁 16 進 1 つに載っている。パレットへは「色 + 不透明度」に分けて渡す。
  const parts = splitBoxColor(value);
  const paletteColor = parts?.color ?? "#000000";
  const paletteOpacity = parts?.opacity ?? 1;
  const opacityPercent = fillOpacityToPercent(paletteOpacity);
  return (
    <div className={styles.field}>
      <span id={labelId}>{label}</span>
      <button
        ref={buttonRef}
        type="button"
        className={styles.colorField}
        data-testid={`box-field-${fieldId}`}
        aria-labelledby={labelId}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span
          // 16 進で書かれていない値 (`transparent` など) は塗らずに「色なし」として見せる。
          // 黒で塗ると、枠線を消しているスタイルが「黒い枠線」に見える。
          // 透けている色は、市松模様の上に重ねて見せる (パレットの色チップと同じ見せ方)。
          className={`${styles.colorSwatch} color-palette-fill-chip`}
          data-empty={parts ? undefined : "true"}
          style={parts ? { ["--fill-chip-color" as string]: value } : undefined}
          aria-hidden="true"
        />
        <output>{parts && opacityPercent < 100 ? `${parts.color} · ${opacityPercent}%` : value}</output>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <ToolbarPopover
        open={open}
        anchorRef={buttonRef}
        onClose={() => setOpen(false)}
        className="color-popover"
        ariaLabel={label}
        zIndex="var(--z-modal-nested)"
      >
        <ColorPalette
          value={paletteColor}
          opacity={paletteOpacity}
          onChange={(color, nextOpacity) => {
            if (color) {
              // スウォッチは色だけを返す。いまの不透明度は持ち越す。
              onChange(joinBoxColor(color, nextOpacity ?? paletteOpacity));
            }
            setOpen(false);
          }}
          onOpacityChange={(nextOpacity) => onChange(joinBoxColor(paletteColor, nextOpacity))}
        />
      </ToolbarPopover>
    </div>
  );
}

function SectionHeading({ id, title }: { id: string; title: string }) {
  return <h3 className={styles.sectionHeading} id={id}>{title}</h3>;
}

function NumberField({
  label, value, min, max, step, placeholder, testId, slider = false, onChange,
}: {
  label: string;
  value: number | "";
  min: number;
  max: number;
  step: number;
  placeholder?: string;
  testId?: string;
  slider?: boolean;
  onChange: (value: number) => void;
}) {
  const t = useT("settings");
  const inputId = useId();
  // Keep an empty/partial decimal editable without saving an invalid frame.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);
  const clamp = (next: number) => Math.min(max, Math.max(min, Number(next.toFixed(4))));
  const commit = (next: number) => {
    const valid = clamp(next);
    setDraft(null);
    onChange(valid);
  };
  const changeBy = (direction: number) => {
    const current = shown !== "" && Number.isFinite(Number(shown)) ? Number(shown) : Number(value) || min;
    commit(current + direction * step);
  };
  return (
    <div className={styles.field}>
      <label htmlFor={inputId}>{label}</label>
      <div className={styles.numberControl}>
        <button
          type="button"
          className={styles.stepButton}
          aria-label={t("box.decrease", { label })}
          disabled={value !== "" && value <= min}
          onClick={() => changeBy(-1)}
        >
          <Minus size={14} aria-hidden="true" />
        </button>
        <input
          id={inputId}
          type="number"
          inputMode="decimal"
          data-testid={testId}
          value={shown}
          min={min}
          max={max}
          step={step}
          placeholder={placeholder}
          onChange={(event) => {
            const raw = event.target.value;
            setDraft(raw);
            const next = Number(raw);
            if (raw !== "" && Number.isFinite(next) && next >= min && next <= max) onChange(next);
          }}
          onBlur={() => {
            if (shown !== "" && Number.isFinite(Number(shown))) commit(Number(shown));
            else setDraft(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              changeBy(event.key === "ArrowUp" ? 1 : -1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
        <button
          type="button"
          className={styles.stepButton}
          aria-label={t("box.increase", { label })}
          disabled={value !== "" && value >= max}
          onClick={() => changeBy(1)}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      </div>
      {slider ? (
        <input
          className={styles.radiusSlider}
          type="range"
          aria-label={t("box.cornerRadiusSlider")}
          min={min}
          max={max}
          step={step}
          value={value === "" ? min : value}
          style={{ "--slider-fill": `${(Number(value) - min) / (max - min) * 100}%` } as CSSProperties}
          onChange={(event) => commit(Number(event.target.value))}
        />
      ) : null}
    </div>
  );
}

function ControlGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.controlGroup}>
      <span>{label}</span>
      <div className={styles.segmentedControl} role="group" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

function SegmentedButton({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={styles.segmentedButton}
      data-selected={selected}
      aria-pressed={selected}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/**
 * スタイル一覧の縮小見本。決まった見出しと本文の線で、そのスタイルの枠を半分の大きさで見せる。
 * 設定中の箱そのものは {@link BoxSettingsPreview} が紙面と同じ描画で見せる。
 */
function BoxStylePreview({ styleId, frame }: {
  styleId: string;
  frame: BoxFrameSpec;
}) {
  const t = useT("settings");
  const className = boxFrameClassName(`${styles.stylePreview} sigma-doc-box-block`, frame, styleId);
  return (
    <span className={styles.stylePreviewViewport} aria-hidden="true">
      <span
        className={className}
        data-box-style={styleId}
        style={boxFrameStyleVars(frame, "closed") as CSSProperties}
        {...boxFrameDecorationAttributes(frame)}
        aria-hidden="true"
      >
        <span className="sigma-doc-box-corner top-left" />
        <span className="sigma-doc-box-corner top-right" />
        <span className="sigma-doc-box-corner bottom-left" />
        <span className="sigma-doc-box-corner bottom-right" />
        <span className="sigma-doc-box-title">{t("box.previewTitle")}</span>
        <span className="sigma-doc-box-body">
          <span className={styles.previewLine} />
          <span className={styles.previewLine} />
        </span>
      </span>
    </span>
  );
}

function hasUniformPadding(padding: BoxSpacingPx): boolean {
  return padding.top === padding.right &&
    padding.top === padding.bottom &&
    padding.top === padding.left;
}
