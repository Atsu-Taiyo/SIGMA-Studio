"use client";

import { Check } from "lucide-react";
import { useEffect, useRef } from "react";

import { DEFAULT_FONT_FAMILY_VALUE, type FontFamilyGroup } from "@/components/editor/editor-shell/constants";
import { SearchField } from "@/components/ui/SearchField";
import type { BrowserFontAccess } from "@/lib/browser-local-fonts";
import { useT } from "@/lib/i18n/react";
import { INLINE_MATH_FONT_MENU_ATTRIBUTE } from "@/lib/math-font-style";

export interface FontFamilyOption {
  label: string;
  value: string;
}

/**
 * 書体メニューに並べる中身と、選んだときの操作。上部ツールバーと選択カードが同じものを使う。
 * 状態の持ち主は `EditorShell` (検索語も 1 つを共有する。同時に開くメニューは 1 つだけ)。
 */
export interface FontFamilyMenuModel {
  /** 現在の書体 (CSS の font-family)。選択に複数の書体が混じっていれば空文字。 */
  value: string;
  label: string;
  mixed: boolean;
  /** 現在の書体が一覧に載っているか。載っていなければ「現在の書体」の段に出す。 */
  isKnownOption: boolean;
  query: string;
  setQuery: (query: string) => void;
  recentOptions: FontFamilyOption[];
  customOptions: FontFamilyOption[];
  groups: FontFamilyGroup[];
  browserFontAccess: BrowserFontAccess | null;
  requestSystemFonts: () => void;
  shortcut: (fontFamily: string) => string | undefined;
  /** 書体を当てる。既定の書体は書式を外す (空文字) ことで表す。 */
  select: (fontFamily: string) => void;
}

/** 書体メニューの中身 (検索欄・現在・最近・追加した書体・書体の分類ごとの一覧)。 */
export function FontFamilyMenuContent({
  font,
  onClose,
}: {
  font: FontFamilyMenuModel;
  onClose: () => void;
}) {
  const t = useT("chrome");
  const rootRef = useRef<HTMLDivElement>(null);
  // マウスで開いても検索欄へ焦点を移す。ボタンは本文の選択を保つために焦点を取らないので、
  // 移さないと打った文字が選んでいる本文を置き換えてしまう。本文の選択は焦点が外れても保たれる。
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>("[data-popover-initial-focus]")?.focus({ preventScroll: true });
  }, []);
  const renderOption = (item: FontFamilyOption, key: string, withShortcut: boolean) => {
    const checked = font.value === item.value;
    return (
      <button
        key={key}
        type="button"
        role="menuitemradio"
        aria-checked={checked}
        className={checked ? "active" : undefined}
        title={item.label}
        style={{ fontFamily: item.value }}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          font.select(item.value);
          onClose();
        }}
      >
        <span className="font-family-menu-option-label">{item.label}</span>
        {withShortcut && <FontFamilyMenuShortcut label={font.shortcut(item.value)} />}
        {checked ? <Check size={14} className="font-family-menu-check" /> : <span className="font-family-menu-check" aria-hidden="true" />}
      </button>
    );
  };

  return (
    <div ref={rootRef} className="font-family-menu-content" {...{ [INLINE_MATH_FONT_MENU_ATTRIBUTE]: "" }}>
      <SearchField
        size="sm"
        className="font-family-menu-search"
        value={font.query}
        aria-label={t("format.font.search")}
        placeholder={t("format.font.search")}
        data-popover-initial-focus=""
        onChange={font.setQuery}
      />
      {font.browserFontAccess && font.browserFontAccess !== "granted" && (
        <div className="font-family-local-access">
          {font.browserFontAccess !== "unsupported" && (
            <button
              type="button"
              role="menuitem"
              disabled={font.browserFontAccess === "loading"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={font.requestSystemFonts}
              title={t("format.font.local.help")}
            >
              {t(font.browserFontAccess === "loading" ? "format.font.local.loading" : "format.font.local.enable")}
            </button>
          )}
          {font.browserFontAccess !== "loading" && (
            <p className="font-family-menu-empty" role="status">{t(`format.font.local.${font.browserFontAccess}`)}</p>
          )}
        </div>
      )}
      {!font.isKnownOption ? (
        <div className="font-family-menu-group" role="group" aria-label={t("format.font.currentGroup")}>
          <div className="font-family-menu-group-label">{t("format.font.currentGroup")}</div>
          <button
            type="button"
            role="menuitemradio"
            aria-checked="true"
            className="active"
            title={font.label}
            style={{ fontFamily: font.value }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClose}
          >
            <span className="font-family-menu-option-label">{font.label}</span>
            <Check size={14} className="font-family-menu-check" />
          </button>
        </div>
      ) : null}
      {font.recentOptions.length > 0 && (
        <div className="font-family-menu-group" role="group" aria-label={t("format.font.recentGroup")}>
          <div className="font-family-menu-group-label">{t("format.font.recentGroup")}</div>
          {font.recentOptions.map((item) => renderOption(item, item.value, false))}
        </div>
      )}
      {/* 読み込んだ書体・拡張機能の書体は、このPCの書体 (数百) の後ろに埋もれないよう先頭に置く。 */}
      {font.customOptions.length > 0 && (
        <div className="font-family-menu-group" role="group" aria-label={t("format.font.customGroup")}>
          <div className="font-family-menu-group-label">{t("format.font.customGroup")}</div>
          {font.customOptions.map((item) => renderOption(item, `custom-${item.value}`, true))}
        </div>
      )}
      {font.groups.map((group) => (
        <div className="font-family-menu-group" role="group" aria-label={t(`format.font.group.${group.id}`)} key={group.id}>
          <div className="font-family-menu-group-label">{t(`format.font.group.${group.id}`)}</div>
          {group.options.map((item) => renderOption(item, `${group.id}-${item.value}`, true))}
        </div>
      ))}
      {font.groups.length === 0 && font.customOptions.length === 0 && (
        <p className="font-family-menu-empty">{t("format.font.empty")}</p>
      )}
    </div>
  );
}

/** 書体を当てる要求の値。既定の書体は書式を外す (空文字)。 */
export function fontFamilyFormatValue(fontFamily: string): string {
  return fontFamily === DEFAULT_FONT_FAMILY_VALUE ? "" : fontFamily;
}

/** 書体メニューの行に添える「この書体にするキー」。割り当てが無ければ何も描かない。 */
function FontFamilyMenuShortcut({ label }: { label: string | undefined }) {
  return label ? <kbd className="font-family-menu-shortcut">{label}</kbd> : null;
}
