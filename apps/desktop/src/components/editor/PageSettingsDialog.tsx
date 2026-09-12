"use client";

import { FileCog, X } from "lucide-react";
import { useMemo, useState } from "react";

import { ColumnRuleControls } from "./ColumnRuleControls";
import type { ColumnRule } from "@/features/document";
import { Select } from "@/components/ui/Select";
import { SettingsField, SettingsRow, SettingsSection, Switch } from "@/components/ui/settings";
import {
  expandMarginsForRunningRegions,
  getPageLayoutIssues,
  MIN_PAGE_BODY_HEIGHT_MM,
  getPageSizeForPreset,
  isWhiteboardPageLayout,
  normalizePageLayout,
  type PageLayout,
  type PageOrientation,
  type PageSizePreset,
  type HeadingNumberingConfig,
  type HeadingNumberingStyle,
} from "@/features/document";
import { useT } from "@/lib/i18n/react";

import { useSettingsEntryFocus } from "./settings-entry-focus";
import { formatSigmaValidationCode } from "@/lib/validation-text";

interface PageSettingsDialogProps {
  layout?: PageLayout;
  mathFractionSizing?: "uniform" | "texDefault";
  headingNumbering?: HeadingNumberingConfig;
  hasContent?: boolean;
  onClose: () => void;
  onChange: (
    layout: PageLayout,
    mathFractionSizing: "uniform" | "texDefault",
    headingNumbering: HeadingNumberingConfig,
  ) => void;
  /** 設定パレットから開いたときに見せたい項目 (`settings-catalog.ts` の id)。 */
  focusEntryId?: string;
}

interface PageSettingsDraft {
  preset: PageSizePreset;
  orientation: PageOrientation;
  widthMm: number;
  heightMm: number;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
  columnCount: number;
  columnGapMm: number;
  columnRule?: ColumnRule;
  headerEnabled: boolean;
  headerHeightMm: number;
  headerOffsetMm: number;
  headerShowOnFirstPage: boolean;
  footerEnabled: boolean;
  footerHeightMm: number;
  footerOffsetMm: number;
  footerShowOnFirstPage: boolean;
  mathFractionSizing: "uniform" | "texDefault";
  headingNumberingEnabled: boolean;
  headingNumberingStyle: HeadingNumberingStyle;
  headingNumberingDepth: 1 | 2 | 3;
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

const COLUMN_COUNT_OPTIONS = [1, 2, 3, 4] as const;

export function PageSettingsDialog({
  layout,
  mathFractionSizing,
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
  const [draft, setDraft] = useState<PageSettingsDraft>(() =>
    layoutToDraft(normalizedLayout, mathFractionSizing, headingNumbering),
  );
  const [showWhiteboardConfirm, setShowWhiteboardConfirm] = useState(false);
  const presetOptions = isWhiteboardPageLayout(normalizedLayout)
    ? PAGE_PRESET_OPTIONS.filter((option) => option.value === "whiteboard")
    : PAGE_PRESET_OPTIONS;

  const nextLayout = useMemo<PageLayout>(() => {
    const pageSize = draft.preset === "custom" || draft.preset === "whiteboard"
      ? { widthMm: draft.widthMm, heightMm: draft.heightMm }
      : getPageSizeForPreset(draft.preset, draft.orientation);

    return {
      preset: draft.preset,
      orientation: draft.orientation,
      pageSize,
      marginsMm: {
        top: draft.marginTop,
        right: draft.marginRight,
        bottom: draft.marginBottom,
        left: draft.marginLeft,
      },
      flow: {
        type: "columns",
        columnCount: draft.columnCount,
        columnGapMm: draft.columnGapMm,
        ...(draft.columnRule ? { columnRule: draft.columnRule } : {}),
      },
      header: {
        enabled: draft.headerEnabled,
        heightMm: draft.headerHeightMm,
        offsetMm: draft.headerOffsetMm,
        showOnFirstPage: draft.headerShowOnFirstPage,
        blocks: normalizedLayout.header?.blocks ?? [],
        overlay: normalizedLayout.header?.overlay,
      },
      footer: {
        enabled: draft.footerEnabled,
        heightMm: draft.footerHeightMm,
        offsetMm: draft.footerOffsetMm,
        showOnFirstPage: draft.footerShowOnFirstPage,
        blocks: normalizedLayout.footer?.blocks ?? [],
        overlay: normalizedLayout.footer?.overlay,
      },
      overlay: normalizedLayout.overlay,
      // ドラフトには載せない (ダイアログでは編集しない) が、ここで拾わないと
      // 「適用」を押した瞬間に浮遊コントロールで選んだ背景が既定へ戻る。
      background: normalizedLayout.background,
    };
  }, [
    draft,
    normalizedLayout.background,
    normalizedLayout.footer?.blocks,
    normalizedLayout.footer?.overlay,
    normalizedLayout.header?.blocks,
    normalizedLayout.header?.overlay,
    normalizedLayout.overlay,
  ]);

  const normalizedNextLayout = useMemo(
    () => expandMarginsForRunningRegions(normalizePageLayout(nextLayout)),
    [nextLayout],
  );
  const issues = useMemo(() => getPageLayoutIssues(normalizedNextLayout), [normalizedNextLayout]);
  const canApply = issues.length === 0;

  const updateDraft = <Key extends keyof PageSettingsDraft>(key: Key, value: PageSettingsDraft[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const updatePreset = (preset: PageSizePreset) => {
    const isCurrentWhiteboard = isWhiteboardPageLayout(normalizedLayout);
    const isNextWhiteboard = preset === "whiteboard";

    if (!isCurrentWhiteboard && isNextWhiteboard && hasContent) {
      setShowWhiteboardConfirm(true);
      return;
    }

    setDraft((current) => {
      const currentSize = current.preset === "custom" || current.preset === "whiteboard"
        ? { widthMm: current.widthMm, heightMm: current.heightMm }
        : getPageSizeForPreset(current.preset, current.orientation);
      const pageSize = preset === "custom" || preset === "whiteboard"
        ? currentSize
        : getPageSizeForPreset(preset, current.orientation);

      return {
        ...current,
        preset,
        widthMm: pageSize.widthMm,
        heightMm: pageSize.heightMm,
      };
    });
  };

  const confirmWhiteboardSwitch = () => {
    setShowWhiteboardConfirm(false);
    onChange(normalizePageLayout({
      ...nextLayout,
      preset: "whiteboard",
      pageSize: { widthMm: draft.widthMm, heightMm: draft.heightMm },
    }), draft.mathFractionSizing, {
      enabled: draft.headingNumberingEnabled,
      style: draft.headingNumberingStyle,
      depth: draft.headingNumberingDepth,
    });
    onClose();
  };

  const updateOrientation = (orientation: PageOrientation) => {
    setDraft((current) => {
      const pageSize = getPageSizeForPreset(
        current.preset,
        orientation,
        { widthMm: current.widthMm, heightMm: current.heightMm },
      );
      return {
        ...current,
        orientation,
        widthMm: pageSize.widthMm,
        heightMm: pageSize.heightMm,
      };
    });
  };

  const apply = () => {
    if (!canApply) {
      return;
    }
    onChange(normalizedNextLayout, draft.mathFractionSizing, {
      enabled: draft.headingNumberingEnabled,
      style: draft.headingNumberingStyle,
      depth: draft.headingNumberingDepth,
    });
    onClose();
  };

  const isWhiteboard = draft.preset === "whiteboard";

  return (
    <div className="page-settings-backdrop" data-modal-backdrop="" role="presentation" onPointerDown={onClose}>
      <section
        className="page-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="page-settings-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="page-settings-header">
          <div className="page-settings-title">
            <FileCog size={18} />
            <h2 id="page-settings-title">{t("page.title")}</h2>
          </div>
          <button type="button" className="icon-button" aria-label={tCommon("actions.close")} title={tCommon("actions.close")} onClick={onClose}>
            <X size={17} />
          </button>
        </header>

        <div className="page-settings-body">
          <div id="page-settings-paper" className="page-settings-grid">
            <label className="field-label" htmlFor="page-size-preset">{t("page.paperSize")}</label>
            <Select
              id="page-size-preset"
              value={draft.preset}
              options={presetOptions.map((option) => ({
                value: option.value,
                label: option.label ?? t(option.value === "whiteboard" ? "page.whiteboard" : "page.custom"),
              }))}
              onChange={(preset) => updatePreset(preset as PageSizePreset)}
            />

            {!isWhiteboard && (
              <>
                <label className="field-label" htmlFor="page-orientation">{t("page.orientation")}</label>
                <Select
                  id="page-orientation"
                  value={draft.orientation}
                  options={[
                    { value: "portrait", label: t("page.portrait") },
                    { value: "landscape", label: t("page.landscape") },
                  ]}
                  onChange={(orientation) => updateOrientation(orientation as PageOrientation)}
                />
              </>
            )}
          </div>

          {isWhiteboard && (
            <div className="page-settings-whiteboard-description">
              <strong>{t("page.whiteboardDescriptionTitle")}</strong>
              <p>{t("page.whiteboardDescriptionBody")}</p>
            </div>
          )}

          {draft.preset === "custom" ? (
            <div className="page-settings-grid two-columns">
              <NumberField
                id="page-custom-width"
                label={t("page.widthMm")}
                value={draft.widthMm}
                onChange={(value) => updateDraft("widthMm", value)}
              />
              <NumberField
                id="page-custom-height"
                label={t("page.heightMm")}
                value={draft.heightMm}
                onChange={(value) => updateDraft("heightMm", value)}
              />
            </div>
          ) : !isWhiteboard ? (
            <p className="page-settings-summary">
              {draft.preset} {getPageSizeForPreset(draft.preset, draft.orientation).widthMm}×{getPageSizeForPreset(draft.preset, draft.orientation).heightMm}mm
            </p>
          ) : null}

          {!isWhiteboard && (
            <>
              <section id="page-settings-margins" className="page-settings-section" aria-label={t("page.margins")}>
                <h3>{t("page.margins")}</h3>
                <div className="page-settings-grid four-columns">
                  <NumberField id="margin-top" label={t("page.marginTop")} value={draft.marginTop} onChange={(value) => updateDraft("marginTop", value)} />
                  <NumberField id="margin-right" label={t("page.marginRight")} value={draft.marginRight} onChange={(value) => updateDraft("marginRight", value)} />
                  <NumberField id="margin-bottom" label={t("page.marginBottom")} value={draft.marginBottom} onChange={(value) => updateDraft("marginBottom", value)} />
                  <NumberField id="margin-left" label={t("page.marginLeft")} value={draft.marginLeft} onChange={(value) => updateDraft("marginLeft", value)} />
                </div>
              </section>

              <section id="page-settings-columns" className="page-settings-section" aria-label={t("page.columns")}>
                <h3>{t("page.columns")}</h3>
                <div className="page-settings-grid two-columns">
                  <label className="field-label" htmlFor="page-column-count">{t("page.columnCount")}</label>
                  <Select
                    id="page-column-count"
                    value={String(draft.columnCount)}
                    options={COLUMN_COUNT_OPTIONS.map((count) => ({ value: String(count), label: String(count) }))}
                    onChange={(count) => updateDraft("columnCount", Number(count))}
                  />
                  <NumberField
                    id="page-column-gap"
                    label={t("page.columnGapMm")}
                    value={draft.columnGapMm}
                    onChange={(value) => updateDraft("columnGapMm", value)}
                  />
                </div>
                {draft.columnCount > 1 && <>
                  <h4 className="column-rule-heading">{t("columnRule.title")}</h4>
                  <p className="field-label">{t("columnRule.pageScope")}</p>
                  <ColumnRuleControls value={draft.columnRule} onChange={value => updateDraft("columnRule", value)} columnCount={draft.columnCount} />
                </>}
              </section>

              <RunningRegionFields
                sectionId="page-settings-header"
                idPrefix="page-header"
                title={t("page.header")}
                enabled={draft.headerEnabled}
                heightMm={draft.headerHeightMm}
                offsetMm={draft.headerOffsetMm}
                showOnFirstPage={draft.headerShowOnFirstPage}
                onEnabledChange={(value) => updateDraft("headerEnabled", value)}
                onHeightChange={(value) => updateDraft("headerHeightMm", value)}
                onOffsetChange={(value) => updateDraft("headerOffsetMm", value)}
                onShowOnFirstPageChange={(value) => updateDraft("headerShowOnFirstPage", value)}
              />

              <RunningRegionFields
                sectionId="page-settings-footer"
                idPrefix="page-footer"
                title={t("page.footer")}
                enabled={draft.footerEnabled}
                heightMm={draft.footerHeightMm}
                offsetMm={draft.footerOffsetMm}
                showOnFirstPage={draft.footerShowOnFirstPage}
                onEnabledChange={(value) => updateDraft("footerEnabled", value)}
                onHeightChange={(value) => updateDraft("footerHeightMm", value)}
                onOffsetChange={(value) => updateDraft("footerOffsetMm", value)}
                onShowOnFirstPageChange={(value) => updateDraft("footerShowOnFirstPage", value)}
              />
            </>
          )}

          <section id="page-settings-math" className="page-settings-section" aria-label={t("page.math")}>
            <h3>{t("page.math")}</h3>
            <label className="page-settings-checkbox">
              <input
                type="checkbox"
                checked={draft.mathFractionSizing !== "texDefault"}
                onChange={(event) =>
                  updateDraft("mathFractionSizing", event.target.checked ? "uniform" : "texDefault")
                }
              />
              <span>{t("page.fractionSameSize")}</span>
            </label>
          </section>

          <SettingsSection
            id="page-settings-heading-numbering"
            title={t("page.headingNumbers")}
            description={t("page.headingNumbersDescription")}
          >
            <SettingsRow
              label={t("page.headingNumbersShow")}
              control={(
                <Switch
                  checked={draft.headingNumberingEnabled}
                  label={t("page.headingNumbersShow")}
                  onCheckedChange={(enabled) => updateDraft("headingNumberingEnabled", enabled)}
                />
              )}
            />
            <SettingsField label={t("page.headingNumbersStyle")} htmlFor="page-heading-numbering-style">
              <Select
                id="page-heading-numbering-style"
                value={draft.headingNumberingStyle}
                disabled={!draft.headingNumberingEnabled}
                options={[
                  { value: "decimal", label: "1.1.3" },
                  { value: "sectionSign", label: "§1.1.3" },
                  { value: "chapterJa", label: t("page.headingNumbersStyleChapter") },
                ]}
                onChange={(style) => updateDraft("headingNumberingStyle", style as HeadingNumberingStyle)}
              />
            </SettingsField>
            <SettingsField label={t("page.headingNumbersDepth")} htmlFor="page-heading-numbering-depth">
              <Select
                id="page-heading-numbering-depth"
                value={String(draft.headingNumberingDepth)}
                disabled={!draft.headingNumberingEnabled}
                options={([1, 2, 3] as const).map((depth) => ({
                  value: String(depth),
                  label: t(`page.headingNumbersDepth${depth}`),
                }))}
                onChange={(depth) => updateDraft("headingNumberingDepth", Number(depth) as 1 | 2 | 3)}
              />
            </SettingsField>
          </SettingsSection>

          {issues.length > 0 && (
            <div className="page-settings-errors" role="alert">
              {/* `getPageLayoutIssues` はコードを返す。文言は `shape` 辞書が持つ
                  (`features/document` は最下層なので表示文字列を抱えない)。 */}
              {issues.map((issue) => (
                <p key={issue}>{formatSigmaValidationCode(issue, { min: MIN_PAGE_BODY_HEIGHT_MM }, tShape)}</p>
              ))}
            </div>
          )}
        </div>

        <footer className="page-settings-footer">
          <button type="button" className="button secondary" onClick={onClose}>
            {tCommon("actions.cancel")}
          </button>
          <button type="button" className="button primary" onClick={apply} disabled={!canApply}>
            {t("page.apply")}
          </button>
        </footer>

        {showWhiteboardConfirm && (
          <div className="page-settings-confirm-backdrop" role="presentation" onMouseDown={() => setShowWhiteboardConfirm(false)}>
            <div className="page-settings-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="whiteboard-confirm-title" onMouseDown={(event) => event.stopPropagation()}>
              <h3 id="whiteboard-confirm-title">{t("page.whiteboardConfirmTitle")}</h3>
              <p>{t("page.whiteboardConfirmBody")}</p>
              <div className="page-settings-confirm-actions">
                <button type="button" className="button secondary" onClick={() => setShowWhiteboardConfirm(false)}>
                  {tCommon("actions.cancel")}
                </button>
                <button type="button" className="button primary" onClick={confirmWhiteboardSwitch}>
                  {t("page.whiteboardConfirmAction")}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function RunningRegionFields({
  sectionId,
  idPrefix,
  title,
  enabled,
  heightMm,
  offsetMm,
  showOnFirstPage,
  onEnabledChange,
  onHeightChange,
  onOffsetChange,
  onShowOnFirstPageChange,
}: {
  /** 設定パレットのスクロール先 (`settings-catalog.ts` の anchorId)。 */
  sectionId: string;
  idPrefix: string;
  title: string;
  enabled: boolean;
  heightMm: number;
  offsetMm: number;
  showOnFirstPage: boolean;
  onEnabledChange: (value: boolean) => void;
  onHeightChange: (value: number) => void;
  onOffsetChange: (value: number) => void;
  onShowOnFirstPageChange: (value: boolean) => void;
}) {
  const t = useT("settings");
  return (
    <section id={sectionId} className="page-settings-section" aria-label={title}>
      <div className="page-settings-section-title">
        <h3>{title}</h3>
        <label className="page-settings-checkbox">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => onEnabledChange(event.target.checked)}
          />
          <span>{t("page.regionShow")}</span>
        </label>
      </div>
      <div className="page-settings-grid three-columns">
        <NumberField id={`${idPrefix}-height`} label={t("page.regionHeightMm")} value={heightMm} onChange={onHeightChange} />
        <NumberField id={`${idPrefix}-offset`} label={t("page.regionOffsetMm")} value={offsetMm} onChange={onOffsetChange} />
        <label className="page-settings-checkbox inline">
          <input
            type="checkbox"
            checked={showOnFirstPage}
            onChange={(event) => onShowOnFirstPageChange(event.target.checked)}
          />
          <span>{t("page.regionFirstPage")}</span>
        </label>
      </div>
      <p className="page-settings-hint">{t("page.regionHint")}</p>
    </section>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="page-settings-number-field" htmlFor={id}>
      <span className="field-label">{label}</span>
      <input
        id={id}
        type="number"
        min={0}
        step={0.5}
        value={Number.isFinite(value) ? value : 0}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function layoutToDraft(
  layout: PageLayout,
  mathFractionSizing?: "uniform" | "texDefault",
  headingNumbering?: HeadingNumberingConfig,
): PageSettingsDraft {
  return {
    preset: layout.preset,
    orientation: layout.orientation,
    widthMm: layout.pageSize.widthMm,
    heightMm: layout.pageSize.heightMm,
    marginTop: layout.marginsMm.top,
    marginRight: layout.marginsMm.right,
    marginBottom: layout.marginsMm.bottom,
    marginLeft: layout.marginsMm.left,
    columnCount: Math.min(4, Math.max(1, layout.flow.columnCount)),
    columnGapMm: layout.flow.columnGapMm,
    columnRule: layout.flow.columnRule,
    headerEnabled: layout.header?.enabled ?? false,
    headerHeightMm: layout.header?.heightMm ?? 8,
    headerOffsetMm: layout.header?.offsetMm ?? 5,
    headerShowOnFirstPage: layout.header?.showOnFirstPage ?? true,
    footerEnabled: layout.footer?.enabled ?? false,
    footerHeightMm: layout.footer?.heightMm ?? 8,
    footerOffsetMm: layout.footer?.offsetMm ?? 5,
    footerShowOnFirstPage: layout.footer?.showOnFirstPage ?? true,
    mathFractionSizing: mathFractionSizing ?? "uniform",
    headingNumberingEnabled: headingNumbering?.enabled ?? false,
    headingNumberingStyle: headingNumbering?.style ?? "decimal",
    headingNumberingDepth: headingNumbering?.depth ?? 3,
  };
}
