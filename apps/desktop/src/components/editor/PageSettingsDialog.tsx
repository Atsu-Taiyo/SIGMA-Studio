"use client";

import {
  Columns2,
  Columns3,
  Columns4,
  FileCog,
  FileMinus,
  FileText,
  Files,
  Minus,
  Plus,
  RectangleHorizontal,
  RectangleVertical,
  Square,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { ColumnRuleControls } from "./ColumnRuleControls";
import { PageSetupPreview, type PageSetupPreviewPart } from "./PageSetupPreview";
import { Button } from "@/components/ui/Button";
import { ChoiceGroup } from "@/components/ui/ChoiceGroup";
import { Inline, Stack } from "@/components/ui/layout";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { SettingsField, SettingsRow, SettingsSection, Switch } from "@/components/ui/settings";
import {
  applyPageMarginPreset,
  expandMarginsForRunningRegions,
  getActivePageMarginPreset,
  getPageLayoutIssues,
  MIN_PAGE_BODY_HEIGHT_MM,
  getPageSizeForPreset,
  DEFAULT_PAGE_NUMBER_START,
  isWhiteboardPageLayout,
  MAX_PAGE_NUMBER_START,
  normalizePageLayout,
  PAGE_MARGIN_PRESETS_MM,
  setPageMarginMm,
  getRunningRegionPageRange,
  setRunningRegionEnabled,
  setRunningRegionGeometryMm,
  setRunningRegionPageRange,
  type PageLayout,
  type PageMarginPresetId,
  type PageMarginSide,
  type PageOrientation,
  type PageRunningRegion,
  type PageSizePreset,
  type RunningRegionPageRange,
  type HeadingNumberingConfig,
  type HeadingNumberingStyle,
} from "@/features/document";
import { useT } from "@/lib/i18n/react";

import styles from "./PageSettingsDialog.module.css";
import { useSettingsEntryFocus } from "./settings-entry-focus";
import { formatSigmaValidationCode } from "@/lib/validation-text";

interface PageSettingsDialogProps {
  layout?: PageLayout;
  headingNumbering?: HeadingNumberingConfig;
  hasContent?: boolean;
  onClose: () => void;
  onChange: (
    layout: PageLayout,
    headingNumbering: HeadingNumberingConfig,
  ) => void;
  /** 設定パレットから開いたときに見せたい項目 (`settings-catalog.ts` の id)。 */
  focusEntryId?: string;
}

// 用紙名 (A4/A3/…) は国際共通の規格名なので訳さない。`custom` だけが翻訳対象。
const PAGE_PRESET_OPTIONS: Array<{ value: PageSizePreset; label?: string }> = [
  { value: "A4", label: "A4" },
  { value: "A3", label: "A3" },
  { value: "B5", label: "B5" },
  { value: "B4", label: "B4" },
  { value: "custom" },
  { value: "whiteboard" },
];

const COLUMN_ICONS = { 1: Square, 2: Columns2, 3: Columns3, 4: Columns4 } as const;
const MARGIN_PRESETS: PageMarginPresetId[] = ["standard", "narrow", "wide"];
const MARGIN_PRESET_LABEL_KEYS = {
  standard: "page.marginPresetStandard",
  narrow: "page.marginPresetNarrow",
  wide: "page.marginPresetWide",
} as const;

/**
 * 用紙・余白・段組み・ヘッダー/フッター・見出し番号。左に紙面の縮小図を置き、触っている欄の
 * 部分をそこで光らせる。下書きは `PageLayout` そのもので持ち、1 つの値を変えるたびに
 * 関係する値 (ヘッダーと上余白など) も合わせる (`page-setup-edit.ts`)。見えている値がそのまま
 * 適用され、「適用」で黙って押し戻されることはない。
 */
export function PageSettingsDialog({
  layout,
  headingNumbering,
  onClose,
  onChange,
  focusEntryId,
  hasContent,
}: PageSettingsDialogProps) {
  const t = useT("settings");
  const tShape = useT("shape");
  const tCommon = useT("common");
  useSettingsEntryFocus(focusEntryId);
  const normalizedLayout = useMemo(() => normalizePageLayout(layout), [layout]);
  const [draft, setDraft] = useState<PageLayout>(normalizedLayout);
  const [numbering, setNumbering] = useState<Required<HeadingNumberingConfig>>(() => ({
    enabled: headingNumbering?.enabled ?? false,
    style: headingNumbering?.style ?? "decimal",
    depth: headingNumbering?.depth ?? 3,
  }));
  const [highlight, setHighlight] = useState<PageSetupPreviewPart | null>(null);
  const [showWhiteboardConfirm, setShowWhiteboardConfirm] = useState(false);
  const presetOptions = isWhiteboardPageLayout(normalizedLayout)
    ? PAGE_PRESET_OPTIONS.filter((option) => option.value === "whiteboard")
    : PAGE_PRESET_OPTIONS;

  const nextLayout = useMemo(
    () => expandMarginsForRunningRegions(normalizePageLayout(draft)),
    [draft],
  );
  const issues = useMemo(() => getPageLayoutIssues(nextLayout), [nextLayout]);
  const canApply = issues.length === 0;
  const isWhiteboard = draft.preset === "whiteboard";
  const activeMarginPreset = getActivePageMarginPreset(draft);

  const update = (change: (current: PageLayout) => PageLayout) => setDraft((current) => change(current));
  const focusProps = (part: PageSetupPreviewPart) => ({
    onFocus: () => setHighlight(part),
    onMouseEnter: () => setHighlight(part),
  });

  const updatePreset = (preset: PageSizePreset) => {
    if (!isWhiteboardPageLayout(normalizedLayout) && preset === "whiteboard" && hasContent) {
      setShowWhiteboardConfirm(true);
      return;
    }
    update((current) => ({
      ...current,
      preset,
      pageSize: preset === "custom" || preset === "whiteboard"
        ? current.pageSize
        : getPageSizeForPreset(preset, current.orientation),
    }));
  };

  const updateOrientation = (orientation: PageOrientation) => {
    update((current) => ({
      ...current,
      orientation,
      pageSize: getPageSizeForPreset(current.preset, orientation, current.pageSize),
    }));
  };

  const confirmWhiteboardSwitch = () => {
    setShowWhiteboardConfirm(false);
    onChange(normalizePageLayout({ ...draft, preset: "whiteboard" }), numbering);
    onClose();
  };

  const apply = () => {
    if (!canApply) {
      return;
    }
    onChange(nextLayout, numbering);
    onClose();
  };

  const summary = t("page.previewSummary", {
    paper: draft.preset === "custom" ? t("page.custom") : draft.preset,
    orientation: t(nextLayout.orientation === "landscape" ? "page.landscape" : "page.portrait"),
    width: formatMm(nextLayout.pageSize.widthMm),
    height: formatMm(nextLayout.pageSize.heightMm),
  });

  return (
    <ModalFrame
      open
      onDismiss={onClose}
      size="lg"
      className="page-settings-backdrop"
      surfaceClassName={`page-settings-dialog ${styles.dialog}`}
      ariaLabel={t("page.title")}
    >
      <ModalHeader
        title={(
          <span className={styles.title}>
            <FileCog size={18} aria-hidden="true" />
            <span>{t("page.title")}</span>
          </span>
        )}
        onClose={onClose}
      />

      <ModalBody padding="none" scroll="hidden" className={styles.body}>
        <div className={styles.workbench} data-whiteboard={isWhiteboard || undefined}>
          {!isWhiteboard ? (
            <aside className={styles.previewPane} aria-label={t("page.preview")}>
              <div className={styles.previewStage}>
                <PageSetupPreview layout={nextLayout} highlight={highlight}
                  onColumnRuleChange={columnRule => update(current => ({
                    ...current, flow: { ...current.flow, columnRule, pageColumnRules: undefined },
                  }))} />
              </div>
              <p className={styles.previewSummary}>{summary}</p>
            </aside>
          ) : null}

          <div className={styles.form} onMouseLeave={() => setHighlight(null)}>
            <Stack gap="xl">
              <FormSection id="page-settings-paper" title={t("page.paper")} {...focusProps("paper")}>
                <div className={styles.paperRow}>
                  <SettingsField label={t("page.paperSize")} htmlFor="page-size-preset">
                    <Select
                      id="page-size-preset"
                      className={styles.select}
                      value={draft.preset}
                      options={presetOptions.map((option) => ({
                        value: option.value,
                        label: option.label ?? t(option.value === "whiteboard" ? "page.whiteboard" : "page.custom"),
                      }))}
                      onChange={(preset) => updatePreset(preset as PageSizePreset)}
                    />
                  </SettingsField>
                  {!isWhiteboard ? (
                    <SettingsField label={t("page.orientation")}>
                      <ChoiceGroup<PageOrientation>
                        aria-label={t("page.orientation")}
                        columns={2}
                        value={draft.orientation}
                        options={[
                          { value: "portrait", label: t("page.portrait"), icon: RectangleVertical },
                          { value: "landscape", label: t("page.landscape"), icon: RectangleHorizontal },
                        ]}
                        onChange={updateOrientation}
                      />
                    </SettingsField>
                  ) : null}
                </div>
                {draft.preset === "custom" ? (
                  <div className={styles.fieldGrid} data-columns="2">
                    <MmField
                      id="page-custom-width"
                      label={t("page.widthMm")}
                      value={draft.pageSize.widthMm}
                      min={1}
                      onChange={(value) => update((current) => ({ ...current, pageSize: { ...current.pageSize, widthMm: value } }))}
                    />
                    <MmField
                      id="page-custom-height"
                      label={t("page.heightMm")}
                      value={draft.pageSize.heightMm}
                      min={1}
                      onChange={(value) => update((current) => ({ ...current, pageSize: { ...current.pageSize, heightMm: value } }))}
                    />
                  </div>
                ) : null}
                {isWhiteboard ? (
                  <div className={styles.whiteboardDescription}>
                    <strong>{t("page.whiteboardDescriptionTitle")}</strong>
                    <p>{t("page.whiteboardDescriptionBody")}</p>
                  </div>
                ) : null}
              </FormSection>

              {!isWhiteboard ? (
                <>
                  <FormSection
                    id="page-settings-margins"
                    title={t("page.margins")}
                    actions={(
                      <div className={styles.segmented} role="group" aria-label={t("page.marginPresets")}>
                        {MARGIN_PRESETS.map((preset) => (
                          <button
                            key={preset}
                            type="button"
                            className={styles.segment}
                            aria-pressed={activeMarginPreset === preset}
                            title={formatMarginPreset(PAGE_MARGIN_PRESETS_MM[preset])}
                            onClick={() => update((current) => applyPageMarginPreset(current, preset))}
                          >
                            {t(MARGIN_PRESET_LABEL_KEYS[preset])}
                          </button>
                        ))}
                      </div>
                    )}
                  >
                    <div className={styles.fieldGrid} data-columns="4">
                      {(["top", "bottom", "left", "right"] as const).map((side) => (
                        <MmField
                          key={side}
                          id={`margin-${side}`}
                          label={t(MARGIN_LABEL_KEYS[side])}
                          value={draft.marginsMm[side]}
                          onChange={(value) => update((current) => setPageMarginMm(current, side, value))}
                          {...focusProps(MARGIN_PREVIEW_PARTS[side])}
                        />
                      ))}
                    </div>
                  </FormSection>

                  <FormSection id="page-settings-columns" title={t("page.columns")} {...focusProps("columns")}>
                    <ChoiceGroup<"1" | "2" | "3" | "4">
                      aria-label={t("page.columnCount")}
                      columns={4}
                      value={String(draft.flow.columnCount) as "1" | "2" | "3" | "4"}
                      options={([1, 2, 3, 4] as const).map((count) => ({
                        value: String(count) as "1" | "2" | "3" | "4",
                        label: t("page.columnOption", { count }),
                        icon: COLUMN_ICONS[count],
                      }))}
                      onChange={(count) => update((current) => ({ ...current, flow: { ...current.flow, columnCount: Number(count) } }))}
                    />
                    {draft.flow.columnCount > 1 ? (
                      <>
                        <div className={styles.fieldGrid} data-columns="2">
                          <MmField
                            id="page-column-gap"
                            label={t("page.columnGapMm")}
                            value={draft.flow.columnGapMm}
                            onChange={(value) => update((current) => ({ ...current, flow: { ...current.flow, columnGapMm: value } }))}
                          />
                        </div>
                        <Stack gap="sm">
                          <h4 className={styles.subheading}>{t("columnRule.title")}</h4>
                          <p className={styles.hint}>{t("columnRule.pageScope")}</p>
                          <ColumnRuleControls
                            showPreview={false}
                            value={draft.flow.columnRule}
                            columnCount={draft.flow.columnCount}
                            onChange={(columnRule) => update((current) => ({
                              ...current,
                              flow: { ...current.flow, columnRule, pageColumnRules: undefined },
                            }))}
                          />
                        </Stack>
                      </>
                    ) : null}
                  </FormSection>

                  <RunningRegionSection
                    sectionId="page-settings-header"
                    kind="header"
                    region={draft.header}
                    onEnabledChange={(enabled) => update((current) => setRunningRegionEnabled(current, "header", enabled))}
                    onGeometryChange={(patch) => update((current) => setRunningRegionGeometryMm(current, "header", patch))}
                    onPageRangeChange={(range) => update((current) => setRunningRegionPageRange(current, "header", range))}
                    focusProps={focusProps("header")}
                  />

                  <RunningRegionSection
                    sectionId="page-settings-footer"
                    kind="footer"
                    region={draft.footer}
                    onEnabledChange={(enabled) => update((current) => setRunningRegionEnabled(current, "footer", enabled))}
                    onGeometryChange={(patch) => update((current) => setRunningRegionGeometryMm(current, "footer", patch))}
                    onPageRangeChange={(range) => update((current) => setRunningRegionPageRange(current, "footer", range))}
                    focusProps={focusProps("footer")}
                  />

                  <FormSection id="page-settings-numbering" title={t("page.pageNumbering")}>
                    <div className={styles.fieldGrid} data-columns="2">
                      <NumberField
                        id="page-number-start"
                        label={t("page.pageNumberStart")}
                        value={draft.pageNumberStart ?? DEFAULT_PAGE_NUMBER_START}
                        min={0}
                        max={MAX_PAGE_NUMBER_START}
                        integer
                        onChange={(pageNumberStart) => update((current) => ({ ...current, pageNumberStart }))}
                      />
                    </div>
                    <p className={styles.hint}>{t("page.pageNumberStartHint")}</p>
                  </FormSection>
                </>
              ) : null}

              <SettingsSection
                id="page-settings-heading-numbering"
                title={t("page.headingNumbers")}
                description={t("page.headingNumbersDescription")}
                className={styles.section}
              >
                <SettingsRow
                  label={t("page.headingNumbersShow")}
                  control={(
                    <Switch
                      checked={numbering.enabled}
                      label={t("page.headingNumbersShow")}
                      onCheckedChange={(enabled) => setNumbering((current) => ({ ...current, enabled }))}
                    />
                  )}
                />
                {numbering.enabled ? (
                  <div className={styles.fieldGrid} data-columns="2">
                    <SettingsField label={t("page.headingNumbersStyle")} htmlFor="page-heading-numbering-style">
                      <Select
                        id="page-heading-numbering-style"
                        className={styles.select}
                        value={numbering.style}
                        options={[
                          { value: "decimal", label: "1.1.3" },
                          { value: "sectionSign", label: "§1.1.3" },
                          { value: "chapterJa", label: t("page.headingNumbersStyleChapter") },
                        ]}
                        onChange={(style) => setNumbering((current) => ({ ...current, style: style as HeadingNumberingStyle }))}
                      />
                    </SettingsField>
                    <SettingsField label={t("page.headingNumbersDepth")} htmlFor="page-heading-numbering-depth">
                      <Select
                        id="page-heading-numbering-depth"
                        className={styles.select}
                        value={String(numbering.depth)}
                        options={([1, 2, 3] as const).map((depth) => ({
                          value: String(depth),
                          label: t(`page.headingNumbersDepth${depth}`),
                        }))}
                        onChange={(depth) => setNumbering((current) => ({ ...current, depth: Number(depth) as 1 | 2 | 3 }))}
                      />
                    </SettingsField>
                  </div>
                ) : null}
              </SettingsSection>

              {issues.length > 0 && (
                <div className={styles.errors} role="alert">
                  {/* `getPageLayoutIssues` はコードを返す。文言は `shape` 辞書が持つ
                      (`features/document` は最下層なので表示文字列を抱えない)。 */}
                  {issues.map((issue) => (
                    <p key={issue}>{formatSigmaValidationCode(issue, { min: MIN_PAGE_BODY_HEIGHT_MM }, tShape)}</p>
                  ))}
                </div>
              )}
            </Stack>
          </div>
        </div>
      </ModalBody>

      <footer className={styles.footer}>
        <Button tone="secondary" onClick={onClose}>
          {tCommon("actions.cancel")}
        </Button>
        <Button tone="primary" onClick={apply} disabled={!canApply}>
          {t("page.apply")}
        </Button>
      </footer>

      <ModalFrame
        open={showWhiteboardConfirm}
        onDismiss={() => setShowWhiteboardConfirm(false)}
        layer="nested"
        size="sm"
        ariaLabel={t("page.whiteboardConfirmTitle")}
      >
        <ModalHeader title={t("page.whiteboardConfirmTitle")} onClose={() => setShowWhiteboardConfirm(false)} />
        <ModalBody padding="xl">
          <Stack gap="xl">
            <p className={styles.confirmBody}>{t("page.whiteboardConfirmBody")}</p>
            <Inline gap="sm" justify="end">
              <Button tone="secondary" onClick={() => setShowWhiteboardConfirm(false)}>
                {tCommon("actions.cancel")}
              </Button>
              <Button tone="danger" onClick={confirmWhiteboardSwitch}>
                {t("page.whiteboardConfirmAction")}
              </Button>
            </Inline>
          </Stack>
        </ModalBody>
      </ModalFrame>
    </ModalFrame>
  );
}

const MARGIN_LABEL_KEYS = {
  top: "page.marginTop",
  bottom: "page.marginBottom",
  left: "page.marginLeft",
  right: "page.marginRight",
} as const;

const MARGIN_PREVIEW_PARTS: Record<PageMarginSide, PageSetupPreviewPart> = {
  top: "marginTop",
  bottom: "marginBottom",
  left: "marginLeft",
  right: "marginRight",
};

function FormSection({
  id,
  title,
  actions,
  children,
  onFocus,
  onMouseEnter,
}: {
  id: string;
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  onFocus?: () => void;
  onMouseEnter?: () => void;
}) {
  return (
    <SettingsSection
      id={id}
      title={title}
      actions={actions}
      className={styles.section}
      onFocus={onFocus}
      onMouseEnter={onMouseEnter}
    >
      {children}
    </SettingsSection>
  );
}

/**
 * ヘッダー/フッター 1 つ分。表示を入れたときだけ位置と高さを出す (切っている間の値は見せない)。
 * ヘッダーは用紙の上端から、フッターは下端から測る。
 */
function RunningRegionSection({
  sectionId,
  kind,
  region,
  onEnabledChange,
  onGeometryChange,
  onPageRangeChange,
  focusProps,
}: {
  /** 設定パレットのスクロール先 (`settings-catalog.ts` の anchorId)。 */
  sectionId: string;
  kind: "header" | "footer";
  region: PageRunningRegion | undefined;
  onEnabledChange: (enabled: boolean) => void;
  onGeometryChange: (patch: { offsetMm?: number; heightMm?: number }) => void;
  onPageRangeChange: (range: RunningRegionPageRange) => void;
  focusProps: { onFocus: () => void; onMouseEnter: () => void };
}) {
  const t = useT("settings");
  const title = t(kind === "header" ? "page.header" : "page.footer");
  const enabled = region?.enabled ?? false;
  const idPrefix = kind === "header" ? "page-header" : "page-footer";
  return (
    <FormSection
      id={sectionId}
      title={title}
      actions={(
        <Switch
          checked={enabled}
          label={t("page.regionShow", { region: title })}
          onCheckedChange={onEnabledChange}
        />
      )}
      {...focusProps}
    >
      {enabled && region ? (
        <>
          <div className={styles.fieldGrid} data-columns="2">
            <MmField
              id={`${idPrefix}-offset`}
              label={t(kind === "header" ? "page.regionOffsetMm" : "page.regionOffsetFromBottomMm")}
              value={region.offsetMm}
              onChange={(offsetMm) => onGeometryChange({ offsetMm })}
            />
            <MmField
              id={`${idPrefix}-height`}
              label={t("page.regionHeightMm")}
              value={region.heightMm}
              onChange={(heightMm) => onGeometryChange({ heightMm })}
            />
          </div>
          <SettingsField label={t("page.regionPages")}>
            <ChoiceGroup<RunningRegionPageRange | "custom">
              aria-label={t("page.regionPages")}
              columns={3}
              // ページごとの例外があるときは、どれも選ばれない (下の説明が、その状態を知らせる)。
              value={getRunningRegionPageRange(region) ?? "custom"}
              options={[
                { value: "all", label: t("page.regionPagesAll"), icon: Files },
                { value: "firstOnly", label: t("page.regionPagesFirstOnly"), icon: FileText },
                { value: "exceptFirst", label: t("page.regionPagesExceptFirst"), icon: FileMinus },
              ]}
              onChange={(range) => {
                if (range !== "custom") {
                  onPageRangeChange(range);
                }
              }}
            />
          </SettingsField>
          {getRunningRegionPageRange(region) === null ? (
            <p className={styles.hint}>{t("page.regionPagesCustom")}</p>
          ) : null}
          <p className={styles.hint}>{t(kind === "header" ? "page.regionHint" : "page.footerHint")}</p>
        </>
      ) : null}
    </FormSection>
  );
}

/**
 * mm の数値欄 (0.5 刻みで動かし、0.1mm に丸める)。中身は `NumberField`。
 */
function MmField({
  min = 0,
  ...props
}: {
  id: string;
  label: string;
  value: number;
  min?: number;
  onChange: (value: number) => void;
  onFocus?: () => void;
  onMouseEnter?: () => void;
}) {
  const t = useT("settings");
  return <NumberField {...props} min={min} unit={t("page.mmUnit")} />;
}

/**
 * 数値欄。−/＋ で 1 ずつ、矢印キーでも動かせる。入力途中の空欄や「1.」は
 * そのまま打てるよう下書きの文字列で持ち、確かな数になったときだけ反映する。
 * `integer` は整数だけ (ページ番号など)。範囲を超えた入力は確定 (離れる・Enter) のときに範囲内へ寄せる。
 * 単位が無い欄は `unit` を省く。
 */
function NumberField({
  id,
  label,
  value,
  min = 0,
  max,
  integer = false,
  unit,
  onChange,
  onFocus,
  onMouseEnter,
}: {
  id: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  integer?: boolean;
  unit?: string;
  onChange: (value: number) => void;
  onFocus?: () => void;
  onMouseEnter?: () => void;
}) {
  const t = useT("settings");
  const unitId = useId();
  const [text, setText] = useState<string | null>(null);
  const formatValue = integer ? String : formatMm;
  const shown = text ?? formatValue(value);
  const inRange = (next: number) => next >= min && (max === undefined || next <= max);
  const commit = (next: number) => {
    setText(null);
    const rounded = integer ? Math.round(next) : roundTenth(next);
    onChange(Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min, rounded)));
  };
  const stepBy = (direction: 1 | -1) => {
    const current = Number(shown);
    commit((Number.isFinite(current) ? current : value) + direction);
  };
  return (
    <div className={styles.mmField} onMouseEnter={onMouseEnter}>
      <label className={styles.mmLabel} htmlFor={id}>{label}</label>
      <div className={styles.mmControl} data-unitless={unit ? undefined : true}>
        <button
          type="button"
          className={styles.stepButton}
          aria-label={t("page.decrease", { label })}
          disabled={value <= min}
          onClick={() => stepBy(-1)}
          onFocus={onFocus}
        >
          <Minus size={13} aria-hidden="true" />
        </button>
        <input
          id={id}
          type="number"
          inputMode={integer ? "numeric" : "decimal"}
          min={min}
          max={max}
          step={integer ? 1 : 0.5}
          value={shown}
          aria-describedby={unit ? unitId : undefined}
          onFocus={(event) => {
            event.currentTarget.select();
            onFocus?.();
          }}
          onChange={(event) => {
            const raw = event.target.value;
            setText(raw);
            const next = Number(raw);
            if (raw.trim() !== "" && Number.isFinite(next) && inRange(next) && (!integer || Number.isInteger(next))) {
              onChange(next);
            }
          }}
          onBlur={() => {
            const next = Number(shown);
            if (shown.trim() !== "" && Number.isFinite(next)) {
              commit(next);
            } else {
              setText(null);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              stepBy(event.key === "ArrowUp" ? 1 : -1);
            } else if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
        />
        {unit ? <span className={styles.mmUnit} id={unitId}>{unit}</span> : null}
        <button
          type="button"
          className={styles.stepButton}
          aria-label={t("page.increase", { label })}
          disabled={max !== undefined && value >= max}
          onClick={() => stepBy(1)}
          onFocus={onFocus}
        >
          <Plus size={13} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

function formatMarginPreset(margins: Record<PageMarginSide, number>): string {
  const values = [margins.top, margins.right, margins.bottom, margins.left];
  return values.every((value) => value === values[0])
    ? `${formatMm(values[0])} mm`
    : `${formatMm(margins.top)} / ${formatMm(margins.right)} / ${formatMm(margins.bottom)} / ${formatMm(margins.left)} mm`;
}

function formatMm(value: number): string {
  return Number.isInteger(value) ? String(value) : String(roundTenth(value));
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}
