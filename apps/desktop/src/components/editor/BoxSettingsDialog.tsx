"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AlignCenter, AlignLeft, AlignRight, ChevronDown, Minus, Plus, RotateCcw } from "lucide-react";
import { InlineContent } from "@/features/rendering/adapters/react";

import { BoxTitleEditor } from "@/components/editor/BoxTitleEditor";
import { ColorPalette } from "@/components/editor/ColorPalette";
import { ToolbarPopover } from "@/components/editor/ToolbarPopover";
import { Grid, Inline, Stack } from "@/components/ui/layout";
import { Select } from "@/components/ui/Select";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import type {
  BoxBlockNode,
  BoxFrameSpec,
  BoxSpacingPx,
  InlineNode,
  MathFractionSizing,
} from "@/features/document";
import {
  resolveBoxStyles,
  boxFrameClassName,
  boxFrameDecorationAttributes,
  boxFrameStyleVars,
  resolveBoxFrame,
} from "@/lib/box-blocks";
import { boxFrameFields, type BoxFrameField, type BoxFrameFieldGroup } from "@/lib/box-frame-fields";
import styles from "./BoxSettingsDialog.module.css";
import type { Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";

type BoxSettingsBlock = Pick<BoxBlockNode, "id" | "styleId" | "frame">;

interface BoxSettingsDialogProps {
  boxBlock: BoxSettingsBlock;
  title: InlineNode[];
  mathFractionSizing?: MathFractionSizing | null;
  /** ⋯メニューの「タイトルを編集…」から開いたときだけタイトル入力へキャレットを置く。 */
  autoFocusTitle?: boolean;
  onStyleChange: (styleId: string) => void;
  onFrameChange: (patch: Partial<BoxFrameSpec>) => void;
  onTitleChange: (title: InlineNode[]) => void;
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
  mathFractionSizing,
  autoFocusTitle = false,
  onStyleChange,
  onFrameChange,
  onTitleChange,
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
  const hasNotchedCorners = boxBlock.styleId === "cornerbox" &&
    resolvedFrame.decorations?.some((decoration) => decoration.type === "titleDoubleRule");
  const padding = resolvedFrame.paddingPx ?? DEFAULT_PADDING;
  const [paddingMode, setPaddingMode] = useState<PaddingMode>(() => (
    hasUniformPadding(padding) ? "all" : "sides"
  ));
  const uniformPadding = hasUniformPadding(padding) ? padding.top : "";
  const fields = boxFrameFields(resolvedFrame);
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
          <aside className={styles.previewPanel} aria-label={t("box.preview")}>
            <span className={styles.previewHeading}>{t("box.preview")}</span>
            <div className={styles.livePreview} data-testid="box-live-preview">
              <BoxStylePreview
                styleId={boxBlock.styleId}
                frame={resolvedFrame}
                title={title}
                mathFractionSizing={mathFractionSizing}
              />
            </div>
            <strong className={styles.currentStyleName}>{selectedStyle?.displayName}</strong>
            <p className={styles.fieldHint}>{selectedStyle?.description}</p>
          </aside>
          <Stack gap="xl" className={styles.controls}>
            <Stack as="section" gap="sm" aria-labelledby="box-settings-title-heading">
              <SectionHeading id="box-settings-title-heading" title={t("box.titleSection")} />
              <BoxTitleEditor
                value={title}
                mathFractionSizing={mathFractionSizing}
                autoFocus={autoFocusTitle}
                onChange={onTitleChange}
              />
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
                <strong>{selectedStyle?.displayName}</strong>
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
                      onClick={() => onStyleChange(style.id)}
                    >
                      <BoxStylePreview styleId={style.id} frame={style.frame} />
                      <span className={styles.styleLabel}>{style.displayName}</span>
                      <span className={styles.styleDescription}>{style.description}</span>
                    </button>
                  );
                })}
              </Grid>
            </Stack>

            <Grid columns={2} gap="xl" className={styles.settingsGrid}>
              <Stack as="section" gap="md" aria-labelledby="box-settings-frame-heading">
                <SectionHeading id="box-settings-frame-heading" title={t("box.frame")} />
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
                  ) : (
                    <span aria-hidden="true" style={{ fontWeight: option === "bold" ? 700 : 400 }}>Aa</span>
                  )}
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
          className={styles.colorSwatch}
          // 16 進で書かれていない値 (`transparent` など) は塗らずに「色なし」として見せる。
          // 黒で塗ると、枠線を消しているスタイルが「黒い枠線」に見える。
          data-empty={isHtmlColor(value) ? undefined : "true"}
          style={isHtmlColor(value) ? { backgroundColor: value } : undefined}
          aria-hidden="true"
        />
        <output>{value}</output>
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
          value={htmlColorValue(value)}
          onChange={(color) => {
            if (color) {
              onChange(color);
            }
            setOpen(false);
          }}
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

function BoxStylePreview({ styleId, frame, title, mathFractionSizing }: {
  styleId: string;
  frame: BoxFrameSpec;
  title?: InlineNode[];
  mathFractionSizing?: MathFractionSizing | null;
}) {
  const t = useT("settings");
  const frameRef = useRef<HTMLSpanElement>(null);
  const [previewHeight, setPreviewHeight] = useState<number>();
  const live = title !== undefined;
  useEffect(() => {
    const element = frameRef.current;
    if (!live || !element) return;
    // The frame is scaled to half size. Reserve its actual painted height so
    // long titles and larger padding do not cover the style description.
    const observer = new ResizeObserver(() => setPreviewHeight(element.offsetHeight / 2 + 14));
    observer.observe(element);
    return () => observer.disconnect();
  }, [live]);
  const className = boxFrameClassName(`${styles.stylePreview} sigma-doc-box-block`, frame, styleId);
  return (
    <span className={styles.stylePreviewViewport} style={live ? { height: previewHeight } : undefined} aria-hidden="true">
      <span
        ref={frameRef}
        className={className}
        data-box-style={styleId}
        style={boxFrameStyleVars(frame) as CSSProperties}
        {...boxFrameDecorationAttributes(frame)}
        aria-hidden="true"
      >
        <span className="sigma-doc-box-corner top-left" />
        <span className="sigma-doc-box-corner top-right" />
        <span className="sigma-doc-box-corner bottom-left" />
        <span className="sigma-doc-box-corner bottom-right" />
        <span className="sigma-doc-box-title">{title?.length ? <InlineContent nodes={title} mathFractionSizing={mathFractionSizing} /> : t("box.previewTitle")}</span>
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

function isHtmlColor(color: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(color);
}

function htmlColorValue(color: string): string {
  return isHtmlColor(color) ? color : "#000000";
}
