"use client";

import {
  Check,
  ChevronDown,
  Code,
  Highlighter,
  Italic,
  List,
  ListOrdered,
  Minus,
  MoreHorizontal,
  Plus,
  PlusCircle,
  Quote,
  SeparatorHorizontal,
  Square,
  Bold,
  Underline,
} from "lucide-react";
import { useRef, type ReactNode } from "react";

import { EditorToolbarMenuButton } from "@/components/editor/EditorToolbar";
import { FontFamilyMenuContent } from "@/components/editor/editor-shell/FontFamilyMenuContent";
import { BoxedTextIcon, BoxedTextStylePreview } from "@/components/editor/editor-shell/formatting-icons";
import { useT } from "@/lib/i18n/react";

import {
  BOXED_TEXT_ROUNDNESS_STEP,
  BOXED_TEXT_STYLE_OPTIONS,
  MAX_BOXED_TEXT_PADDING_Y,
  MAX_BOXED_TEXT_ROUNDNESS,
  MIN_BOXED_TEXT_PADDING_Y,
  MIN_BOXED_TEXT_ROUNDNESS,
  TEXT_ALIGN_OPTIONS,
} from "../constants";
import type { SelectionToolbarTextBinding } from "./binding";
import {
  ColorPalette,
  ToolColorMenu,
  ToolDivider,
  ToolIconButton,
  ToolMenu,
  TOOLBAR_ICON_SIZE,
  useToolbarMenus,
} from "./controls";
import { FONT_SIZE_PRESETS, formatFontSize, stepFontSize } from "./text-model";

type TextMenuId = "font" | "size" | "boxed" | "color" | "highlight" | "align" | "more";

/**
 * 本文の文字を選んだときの操作。2 段に分け、1 段目に「太字・斜体・下線 → 囲み文字 → 文字色・ハイライト」、
 * 2 段目に「書体 → フォントサイズ → 揃え → その他のブロック」を並べる。選択の近くの縦長のカード
 * (`selection-action-popover--card`) に出す。
 * 段落スタイル (本文・見出し) の切り替えは上部ツールバーに任せ、ここには置かない。
 * 上部ツールバーと同じ状態・同じ要求で動く (`SelectionToolbarTextBinding`)。
 * 図形の中の文字 (`scope="shape"`) ではブロックは出さない。
 */
export function TextSelectionTools({
  text,
  scope = "body",
}: {
  text: SelectionToolbarTextBinding;
  /**
   * `body`: 本文。ブロック (リスト・引用など) も出す。
   * `shape`: 図形の中の文字。ブロックの入れ物を持たないので、文字書式と揃えだけ。
   */
  scope?: "body" | "shape";
}) {
  const t = useT("chrome");
  const menus = useToolbarMenus<TextMenuId>();
  const fontRef = useRef<HTMLButtonElement>(null);
  const sizeRef = useRef<HTMLButtonElement>(null);
  const boxedRef = useRef<HTMLButtonElement>(null);
  const colorRef = useRef<HTMLButtonElement>(null);
  const highlightRef = useRef<HTMLButtonElement>(null);
  const alignRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);

  const disabledReason = text.disabledReason;
  const font = text.fontFamily;
  const structuralReason = disabledReason ?? t("format.disabled.unsupportedBlock");
  const sizeReason = disabledReason ?? (text.fontSize === null ? t("format.disabled.fontSizeUnavailable") : undefined);
  const displayFontSize = text.fontSize === null ? null : formatFontSize(text.fontSize);
  const sizeLabel = text.fontSizeMixed ? "–" : displayFontSize ?? "";
  const activeAlign = TEXT_ALIGN_OPTIONS.find((option) => option.value === text.textAlign) ?? TEXT_ALIGN_OPTIONS[0];
  const ActiveAlignIcon = activeAlign.icon;
  const inBody = scope === "body";
  const openId = menus.openId;
  const onToggle = (id: string) => menus.toggle(id as TextMenuId);
  const onClose = (id: string) => menus.close(id as TextMenuId);

  return (
    <>
      {/* 1 段目: 文字の飾り (太字・斜体・下線・囲み・文字色・ハイライト)。 */}
      <div className="selection-toolbar-row">
        <ToolIconButton
          label={text.bold ? t("format.bold.remove") : t("format.bold.apply")}
          active={text.bold}
          disabledReason={structuralReason}
          disabled={!text.enabled}
          onClick={() => text.toggleInline("bold")}
        >
          <Bold size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
        </ToolIconButton>
        <ToolIconButton
          label={text.italic ? t("format.italic.remove") : t("format.italic.apply")}
          active={text.italic}
          disabledReason={structuralReason}
          disabled={!text.enabled}
          onClick={() => text.toggleInline("italic")}
        >
          <Italic size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
        </ToolIconButton>
        <ToolIconButton
          label={text.underline ? t("format.underline.remove") : t("format.underline.apply")}
          active={text.underline}
          disabledReason={structuralReason}
          disabled={!text.enabled}
          onClick={() => text.toggleInline("underline")}
        >
          <Underline size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
        </ToolIconButton>

        {/* 囲み文字: 押すと囲む/外す、▾ で種類と上下の余白。 */}
        <div className="shape-menu-anchor boxed-text-toolbar-control">
          <ToolIconButton
            label={text.boxed ? t("format.boxedText.removeTooltip") : t("format.boxedText.applyTooltip")}
            active={text.boxed}
            disabledReason={structuralReason}
            disabled={!text.enabled}
            onClick={text.toggleBoxed}
          >
            <BoxedTextIcon />
          </ToolIconButton>
          <EditorToolbarMenuButton
            buttonRef={boxedRef}
            variant="boxedText"
            className="boxed-text-menu-trigger"
            active={openId === "boxed"}
            activeFormat={text.boxed}
            title={t("format.boxedText.settings", { padding: text.boxedPaddingY })}
            aria-label={t("format.boxedText.settings", { padding: text.boxedPaddingY })}
            aria-haspopup="dialog"
            aria-expanded={openId === "boxed"}
            disabledReason={structuralReason}
            disabled={!text.enabled}
            onClick={(event) => {
              event.stopPropagation();
              menus.toggle("boxed");
            }}
          >
            <ChevronDown size={13} />
          </EditorToolbarMenuButton>
          <ToolMenu id="boxed" openId={openId} onClose={onClose} buttonRef={boxedRef} className="shape-menu boxed-text-menu" role="dialog" ariaLabel={t("format.boxedText.menu")}>
            <div className="boxed-text-style-options" role="group" aria-label={t("format.boxedText.styles")}>
              {BOXED_TEXT_STYLE_OPTIONS.map((option) => {
                const selected = text.boxedVariant === option.variant;
                const applied = text.boxed && selected;
                const label = t(`format.boxedText.variant.${option.variant}`);
                return (
                  <button
                    key={option.variant}
                    type="button"
                    className={`boxed-text-style-option ${selected ? "selected" : ""} ${applied ? "applied" : ""}`}
                    aria-pressed={applied}
                    title={label}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => text.selectBoxedVariant(option.variant)}
                  >
                    <BoxedTextStylePreview variant={option.variant} />
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
            <div className="boxed-text-padding-stepper">
              <span className="boxed-text-padding-label">{t("format.boxedText.padding")}</span>
              <button
                type="button"
                title={t("format.boxedText.paddingDecrease")}
                aria-label={t("format.boxedText.paddingDecrease")}
                disabled={text.boxedPaddingY <= MIN_BOXED_TEXT_PADDING_Y}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => text.setBoxedPaddingY(text.boxedPaddingY - 1)}
              >
                <Minus size={14} />
              </button>
              <output aria-live="polite">{text.boxedPaddingY}px</output>
              <button
                type="button"
                title={t("format.boxedText.paddingIncrease")}
                aria-label={t("format.boxedText.paddingIncrease")}
                disabled={text.boxedPaddingY >= MAX_BOXED_TEXT_PADDING_Y}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => text.setBoxedPaddingY(text.boxedPaddingY + 1)}
              >
                <PlusCircle size={14} />
              </button>
            </div>
            {/* 丸め具合は角丸だけが読む。他の種類の角は尖っている。並びは上下余白と同じ。 */}
            {text.boxedVariant === "oval" ? (
              <div className="boxed-text-padding-stepper" data-boxed-text-stepper="roundness">
                <span className="boxed-text-padding-label">{t("format.boxedText.roundness")}</span>
                <button
                  type="button"
                  title={t("format.boxedText.roundnessDecrease", { step: BOXED_TEXT_ROUNDNESS_STEP })}
                  aria-label={t("format.boxedText.roundnessDecrease", { step: BOXED_TEXT_ROUNDNESS_STEP })}
                  disabled={text.boxedRoundness <= MIN_BOXED_TEXT_ROUNDNESS}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => text.setBoxedRoundness(text.boxedRoundness - BOXED_TEXT_ROUNDNESS_STEP)}
                >
                  <Minus size={14} />
                </button>
                <output aria-live="polite">{text.boxedRoundness}%</output>
                <button
                  type="button"
                  title={t("format.boxedText.roundnessIncrease", { step: BOXED_TEXT_ROUNDNESS_STEP })}
                  aria-label={t("format.boxedText.roundnessIncrease", { step: BOXED_TEXT_ROUNDNESS_STEP })}
                  disabled={text.boxedRoundness >= MAX_BOXED_TEXT_ROUNDNESS}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => text.setBoxedRoundness(text.boxedRoundness + BOXED_TEXT_ROUNDNESS_STEP)}
                >
                  <PlusCircle size={14} />
                </button>
              </div>
            ) : null}
          </ToolMenu>
        </div>

        <ToolColorMenu
          id="color"
          openId={openId}
          onToggle={onToggle}
          onClose={onClose}
          buttonRef={colorRef}
          label={t("format.textColor.label")}
          icon={<span aria-hidden="true" className="toolbar-icon-color-glyph">A</span>}
          swatch={text.textColor}
          disabledReason={disabledReason}
          disabled={!text.enabled}
          palette={({ close }) => (
            <ColorPalette
              value={text.textColor}
              onChange={(color) => {
                if (color === null) return;
                text.setTextColor(color);
                close();
              }}
            />
          )}
        />
        <ToolColorMenu
          id="highlight"
          openId={openId}
          onToggle={onToggle}
          onClose={onClose}
          buttonRef={highlightRef}
          label={t("format.backgroundColor.label")}
          icon={<Highlighter size={TOOLBAR_ICON_SIZE} aria-hidden="true" />}
          swatch={text.textBackgroundColor}
          disabledReason={disabledReason}
          disabled={!text.enabled}
          palette={({ close }) => (
            <ColorPalette
              value={text.textBackgroundColor}
              allowTransparent
              transparentLabel={t("format.backgroundColor.transparent")}
              onChange={(color) => {
                text.setTextBackgroundColor(color);
                close();
              }}
            />
          )}
        />
      </div>

      <ToolDivider />

      {/* 2 段目: 書体・大きさ・揃え・その他のブロック。 */}
      <div className="selection-toolbar-row">
        {/* 書体: 上部ツールバーと同じメニュー。 */}
        <div className="shape-menu-anchor" title={disabledReason}>
          <button
            ref={fontRef}
            type="button"
            className="selection-toolbar-font"
            title={disabledReason ?? font.label}
            style={{ fontFamily: font.value }}
            aria-label={font.mixed ? t("format.font.mixed") : t("format.font.current", { name: font.label })}
            aria-haspopup="menu"
            aria-expanded={openId === "font"}
            disabled={!text.enabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              if (openId !== "font") font.setQuery("");
              menus.toggle("font");
            }}
          >
            <span className="selection-toolbar-font-label">{font.mixed ? "–" : font.label}</span>
            <ChevronDown size={13} aria-hidden="true" />
          </button>
          <ToolMenu id="font" openId={openId} onClose={(id) => { onClose(id); font.setQuery(""); }} buttonRef={fontRef} className="shape-menu font-family-menu" ariaLabel={t("format.font.aria")}>
            <FontFamilyMenuContent font={font} onClose={() => menus.close("font")} />
          </ToolMenu>
        </div>
        {/* フォントサイズ: − 12 ＋。数字を押すと候補の一覧。入力欄は置かない (フォーカスが移ると選択が外れる)。 */}
        <div className="selection-toolbar-size" title={sizeReason ?? (text.fontSizeMixed ? t("format.fontSize.mixedHelp") : text.fontSize === null ? t("format.fontSize.aria") : `${displayFontSize}pt`)}>
          <button
            type="button"
            className="selection-toolbar-step"
            aria-label={t("format.fontSize.decrease")}
            title={sizeReason ?? t("format.fontSize.decrease")}
            disabled={!text.enabled || text.fontSize === null}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              if (text.fontSize === null) return;
              text.setFontSize(stepFontSize(text.fontSize, -1));
            }}
          >
            <Minus size={12} aria-hidden="true" />
          </button>
          <button
            ref={sizeRef}
            type="button"
            className="selection-toolbar-size-value"
            aria-label={t("format.fontSize.aria")}
            aria-haspopup="menu"
            aria-expanded={openId === "size"}
            disabled={!text.enabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              menus.toggle("size");
            }}
          >
            {sizeLabel}
          </button>
          <button
            type="button"
            className="selection-toolbar-step"
            aria-label={t("format.fontSize.increase")}
            title={sizeReason ?? t("format.fontSize.increase")}
            disabled={!text.enabled || text.fontSize === null}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              if (text.fontSize === null) return;
              text.setFontSize(stepFontSize(text.fontSize, 1));
            }}
          >
            <Plus size={12} aria-hidden="true" />
          </button>
          <ToolMenu id="size" openId={openId} onClose={onClose} buttonRef={sizeRef} className="shape-menu selection-toolbar-size-menu" ariaLabel={t("format.fontSize.aria")}>
            {FONT_SIZE_PRESETS.map((size) => {
              const checked = !text.fontSizeMixed && displayFontSize === formatFontSize(size);
              return (
                <button
                  key={size}
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  className={checked ? "active" : undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    text.setFontSize(size);
                    menus.close("size");
                  }}
                >
                  <span className="font-family-menu-option-label">{size}</span>
                  {checked ? <Check size={14} className="font-family-menu-check" /> : <span className="font-family-menu-check" aria-hidden="true" />}
                </button>
              );
            })}
          </ToolMenu>
        </div>
        {/* 文字揃え */}
        <div className="shape-menu-anchor">
          <EditorToolbarMenuButton
            buttonRef={alignRef}
            variant="textAlign"
            className="selection-toolbar-button"
            active={openId === "align"}
            title={!text.canAlign ? structuralReason : t("format.align.label")}
            aria-label={t("format.align.current", { value: t(`format.align.${activeAlign.value}`) })}
            aria-haspopup="menu"
            aria-expanded={openId === "align"}
            disabledReason={structuralReason}
            disabled={!text.canAlign}
            onClick={(event) => {
              event.stopPropagation();
              menus.toggle("align");
            }}
          >
            <ActiveAlignIcon size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
            <ChevronDown size={13} aria-hidden="true" />
          </EditorToolbarMenuButton>
          <ToolMenu id="align" openId={openId} onClose={onClose} buttonRef={alignRef} className="shape-menu selection-toolbar-icon-menu" ariaLabel={t("format.align.label")}>
            {TEXT_ALIGN_OPTIONS.map((option) => {
              const Icon = option.icon;
              const label = t(`format.align.${option.value}`);
              return (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={text.textAlign === option.value}
                  className={text.textAlign === option.value ? "active" : undefined}
                  title={label}
                  aria-label={label}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    text.applyTextAlign(option.value);
                    menus.close("align");
                  }}
                >
                  <Icon size={16} aria-hidden="true" />
                </button>
              );
            })}
          </ToolMenu>
        </div>

        {/* その他のブロック: 上部ツールバーの「その他のブロック」と同じ集合 */}
        {inBody && <div className="shape-menu-anchor">
          <EditorToolbarMenuButton
            buttonRef={moreRef}
            className="selection-toolbar-button"
            active={openId === "more"}
            title={t("format.blockStructure.more")}
            aria-label={t("format.blockStructure.more")}
            aria-haspopup="menu"
            aria-expanded={openId === "more"}
            disabledReason={structuralReason}
            disabled={!text.canBlockStructure}
            onClick={(event) => {
              event.stopPropagation();
              menus.toggle("more");
            }}
          >
            <MoreHorizontal size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
          </EditorToolbarMenuButton>
          <ToolMenu id="more" openId={openId} onClose={onClose} buttonRef={moreRef} className="shape-menu block-structure-menu" ariaLabel={t("format.blockStructure.more")}>
            <BlockMenuItem
              icon={<List size={16} />}
              active={text.blockStructure.listType === "bullet"}
              label={t("format.blockStructure.bulletList")}
              onSelect={() => { text.applyBlockStructure("bulletList"); menus.close("more"); }}
            />
            <BlockMenuItem
              icon={<ListOrdered size={16} />}
              active={text.blockStructure.listType === "ordered"}
              label={t("format.blockStructure.orderedList")}
              onSelect={() => { text.applyBlockStructure("orderedList"); menus.close("more"); }}
            />
            <BlockMenuItem
              icon={<Quote size={16} />}
              active={text.blockStructure.inQuoteBlock}
              label={text.blockStructure.inQuoteBlock ? t("format.blockStructure.removeQuote") : t("format.blockStructure.quote")}
              onSelect={() => { text.applyBlockStructure("quote"); menus.close("more"); }}
            />
            <BlockMenuItem
              icon={<Code size={16} />}
              active={text.blockStructure.inCodeBlock}
              label={text.blockStructure.inCodeBlock ? t("format.blockStructure.removeCode") : t("format.blockStructure.code")}
              onSelect={() => { text.applyBlockStructure("code"); menus.close("more"); }}
            />
            <BlockMenuItem
              icon={<SeparatorHorizontal size={16} />}
              active={text.blockStructure.onDivider}
              label={text.blockStructure.onDivider ? t("format.blockStructure.removeDivider") : t("format.blockStructure.divider")}
              onSelect={() => { text.applyBlockStructure("divider"); menus.close("more"); }}
            />
            <BlockMenuItem
              icon={<Square size={16} />}
              active={false}
              label={t("format.blockStructure.fancybox")}
              onSelect={() => { text.insertBoxBlock(); menus.close("more"); }}
            />
          </ToolMenu>
        </div>}
      </div>
    </>
  );
}

function BlockMenuItem({
  icon,
  label,
  active,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={active ? "active" : ""}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
