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
import { BoxedTextIcon, BoxedTextStylePreview } from "@/components/editor/editor-shell/formatting-icons";
import { useT } from "@/lib/i18n/react";

import {
  BLOCK_STRUCTURE_OPTIONS,
  BLOCK_STYLE_OPTIONS,
  BOXED_TEXT_STYLE_OPTIONS,
  MAX_BOXED_TEXT_PADDING_Y,
  MIN_BOXED_TEXT_PADDING_Y,
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
import { FONT_SIZE_PRESETS, stepFontSize } from "./text-model";

type TextMenuId = "style" | "size" | "boxed" | "color" | "highlight" | "align" | "more";

/**
 * 本文の文字を選んだときの操作バー。左から「見出しなどの段落スタイル → フォントサイズ →
 * 太字・斜体・下線 → 囲み文字 → 文字色・ハイライト → 揃え → その他のブロック」。
 * 上部ツールバーと同じ状態・同じ要求で動く (`SelectionToolbarTextBinding`)。
 * 図形の中の文字 (`scope="shape"`) では段落スタイルとブロックは出さない。
 */
export function TextSelectionTools({
  text,
  scope = "body",
}: {
  text: SelectionToolbarTextBinding;
  /**
   * `body`: 本文。段落スタイルとブロック (リスト・引用など) も出す。
   * `shape`: 図形の中の文字。ブロックの入れ物を持たないので、文字書式と揃えだけ。
   */
  scope?: "body" | "shape";
}) {
  const t = useT("chrome");
  const menus = useToolbarMenus<TextMenuId>();
  const styleRef = useRef<HTMLButtonElement>(null);
  const sizeRef = useRef<HTMLButtonElement>(null);
  const boxedRef = useRef<HTMLButtonElement>(null);
  const colorRef = useRef<HTMLButtonElement>(null);
  const highlightRef = useRef<HTMLButtonElement>(null);
  const alignRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);

  const styleMenuEnabled = text.canBlockStyle || text.canBlockStructure;
  const structureLabel = text.blockStructure.listType === "bullet"
    ? t("format.blockStructure.bulletList")
    : text.blockStructure.listType === "ordered"
      ? t("format.blockStructure.orderedList")
      : text.blockStructure.inQuoteBlock
        ? t("format.blockStructure.quote")
        : text.blockStructure.inCodeBlock
          ? t("format.blockStructure.code")
          : null;
  const styleLabel = text.blockStyle === "h1" || text.blockStyle === "h2" || text.blockStyle === "h3" || text.blockStyle === "paragraph"
    ? t(`format.blockStyle.${text.blockStyle}`)
    : structureLabel ?? t("format.blockStyle.placeholder");
  const sizeLabel = text.fontSizeMixed ? "–" : text.fontSize === null ? "" : String(text.fontSize);
  const activeAlign = TEXT_ALIGN_OPTIONS.find((option) => option.value === text.textAlign) ?? TEXT_ALIGN_OPTIONS[0];
  const ActiveAlignIcon = activeAlign.icon;
  const inBody = scope === "body";
  const openId = menus.openId;
  const onToggle = (id: string) => menus.toggle(id as TextMenuId);
  const onClose = (id: string) => menus.close(id as TextMenuId);

  return (
    <>
      {/* 段落スタイル: 本文 / 見出し 1〜3 / リスト・引用・コード */}
      {inBody && <><div className="shape-menu-anchor">
        <button
          ref={styleRef}
          type="button"
          className="selection-toolbar-select"
          title={t("format.blockStyle.aria")}
          aria-label={t("format.blockStyle.aria")}
          aria-haspopup="menu"
          aria-expanded={openId === "style"}
          disabled={!styleMenuEnabled}
          onClick={(event) => {
            event.stopPropagation();
            menus.toggle("style");
          }}
        >
          <span>{styleLabel}</span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
        <ToolMenu id="style" openId={openId} onClose={onClose} buttonRef={styleRef} className="shape-menu font-family-menu" ariaLabel={t("format.blockStyle.aria")}>
          <div className="font-family-menu-group" role="group" aria-label={t("format.blockStyle.groupText")}>
            {BLOCK_STYLE_OPTIONS.map((value) => {
              const checked = text.blockStyle === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={checked}
                  className={`block-style-option block-style-option-${value}${checked ? " active" : ""}`}
                  disabled={!text.canBlockStyle}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    text.applyBlockStyle(value);
                    menus.close("style");
                  }}
                >
                  <span className="font-family-menu-option-label">{t(`format.blockStyle.${value}`)}</span>
                  {checked ? <Check size={14} className="font-family-menu-check" /> : <span className="font-family-menu-check" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
          <div className="font-family-menu-group" role="group" aria-label={t("format.blockStyle.groupBlock")}>
            {BLOCK_STRUCTURE_OPTIONS.map((value) => {
              const checked = value === "bulletList" ? text.blockStructure.listType === "bullet"
                : value === "orderedList" ? text.blockStructure.listType === "ordered"
                  : value === "quote" ? text.blockStructure.inQuoteBlock
                    : text.blockStructure.inCodeBlock;
              return (
                <button
                  key={value}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  className={checked ? "active" : undefined}
                  disabled={!text.canBlockStructure}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    text.applyBlockStructure(value);
                    menus.close("style");
                  }}
                >
                  <span className="font-family-menu-option-label">{t(`format.blockStructure.${value}`)}</span>
                  {checked ? <Check size={14} className="font-family-menu-check" /> : <span className="font-family-menu-check" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </ToolMenu>
      </div>

      <ToolDivider /></>}

      {/* フォントサイズ: − 12 ＋。数字を押すと候補の一覧。入力欄は置かない (フォーカスが移ると選択が外れる)。 */}
      <div className="selection-toolbar-size" title={text.fontSizeMixed ? t("format.fontSize.mixedHelp") : text.fontSize === null ? t("format.fontSize.aria") : `${text.fontSize}pt`}>
        <button
          type="button"
          className="selection-toolbar-step"
          aria-label={t("format.fontSize.decrease")}
          title={t("format.fontSize.decrease")}
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
          title={t("format.fontSize.increase")}
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
            const checked = !text.fontSizeMixed && text.fontSize === size;
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

      <ToolDivider />

      <ToolIconButton
        label={text.bold ? t("format.bold.remove") : t("format.bold.apply")}
        active={text.bold}
        disabled={!text.enabled}
        onClick={() => text.toggleInline("bold")}
      >
        <Bold size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
      </ToolIconButton>
      <ToolIconButton
        label={text.italic ? t("format.italic.remove") : t("format.italic.apply")}
        active={text.italic}
        disabled={!text.enabled}
        onClick={() => text.toggleInline("italic")}
      >
        <Italic size={TOOLBAR_ICON_SIZE} aria-hidden="true" />
      </ToolIconButton>
      <ToolIconButton
        label={text.underline ? t("format.underline.remove") : t("format.underline.apply")}
        active={text.underline}
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
        </ToolMenu>
      </div>

      <ToolDivider />

      <ToolColorMenu
        id="color"
        openId={openId}
        onToggle={onToggle}
        onClose={onClose}
        buttonRef={colorRef}
        label={t("format.textColor.label")}
        icon={<span aria-hidden="true" className="toolbar-icon-color-glyph">A</span>}
        swatch={text.textColor}
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

      {/* 文字揃え */}
      <div className="shape-menu-anchor">
        <EditorToolbarMenuButton
          buttonRef={alignRef}
          variant="textAlign"
          className="selection-toolbar-button"
          active={openId === "align"}
          title={t("format.align.label")}
          aria-label={t("format.align.current", { value: t(`format.align.${activeAlign.value}`) })}
          aria-haspopup="menu"
          aria-expanded={openId === "align"}
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
