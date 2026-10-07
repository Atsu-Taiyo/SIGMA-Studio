"use client";

import { Globe, Search } from "lucide-react";
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type { KeyboardEvent, Ref } from "react";

import type { DesktopBrowserAPI } from "@/lib/browser/in-app-browser-contract";
import { useT } from "@/lib/i18n/react";
import { nextHighlight } from "../model/browser-format";
import styles from "./BrowserPanel.module.css";

const SUGGEST_DEBOUNCE_MS = 120;

export interface BrowserOmniboxHandle {
  focus(): void;
}

export interface BrowserOmniboxProps {
  bridge: DesktopBrowserAPI;
  engineId: string;
  /** 編集していないときに見せる、いまのページのアドレス (整形済み)。 */
  display: string;
  /** 編集を始めたときの入力 (完全なURL)。 */
  fullValue: string;
  /** いまのタブのページのアイコン。ページを開いていない、または未取得なら null。 */
  faviconDataUrl?: string | null;
  onSubmit(text: string): void;
  /** 候補の一覧が出ている間、ページ面を隠すために親へ知らせる。 */
  onSuggestionsOpenChange(open: boolean): void;
  handleRef?: Ref<BrowserOmniboxHandle>;
}

/**
 * URLも検索語も入れられる1つの入力欄。入力中は検索エンジンの候補を出し、矢印キーで選べる。
 * どこへ移動するか (URLか検索か) の判断はメインプロセスが行い、ここは入力と選択だけを担当する。
 */
export function BrowserOmnibox({ bridge, engineId, display, fullValue, faviconDataUrl = null, onSubmit, onSuggestionsOpenChange, handleRef }: BrowserOmniboxProps) {
  const t = useT("chrome");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestRef = useRef(0);
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState("");
  // 候補は「どの入力に対するものか」と一緒に持ち、入力が変わった瞬間に古い候補を出さない。
  const [result, setResult] = useState<{ query: string; list: string[] }>({ query: "", list: [] });
  const [highlight, setHighlight] = useState(-1);
  const suggestions = result.query === draft.trim() ? result.list : [];
  const open = focused && suggestions.length > 0;
  // 入力中と新しいタブは虫眼鏡 (これから探す)、ページを見ている間はそのページのアイコン。
  const showsPageIcon = !focused && Boolean(fullValue);

  useImperativeHandle(handleRef, () => ({
    focus: () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    },
  }));

  useEffect(() => onSuggestionsOpenChange(open), [onSuggestionsOpenChange, open]);
  useEffect(() => () => onSuggestionsOpenChange(false), [onSuggestionsOpenChange]);

  useEffect(() => {
    const text = draft.trim();
    const request = ++requestRef.current;
    if (!focused || !text || text === fullValue.trim()) return;
    const timer = window.setTimeout(() => {
      void bridge.suggest(text, engineId).then((list) => {
        if (request === requestRef.current) {
          setResult({ query: text, list });
          setHighlight(-1);
        }
      });
    }, SUGGEST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [bridge, draft, engineId, focused, fullValue]);

  const finish = () => {
    requestRef.current += 1;
    setResult({ query: "", list: [] });
    setHighlight(-1);
  };
  const submit = (text: string) => {
    finish();
    inputRef.current?.blur();
    onSubmit(text);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!suggestions.length) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((current) => nextHighlight(current, step, suggestions.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      submit(highlight >= 0 ? suggestions[highlight] : draft);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (open) finish();
      else inputRef.current?.blur();
    }
  };

  return (
    <div className={styles.omnibox}>
      <span className={styles.addressIcon} aria-hidden="true">
        {showsPageIcon ? (
          faviconDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- ネイティブ側で取得した data URL
            <img className={styles.favicon} src={faviconDataUrl} width={14} height={14} alt="" />
          ) : (
            <Globe size={14} />
          )
        ) : (
          <Search size={14} />
        )}
      </span>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label={t("rightDock.browser.addressLabel")}
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls="browser-suggestions"
        className={styles.addressInput}
        placeholder={t("rightDock.browser.addressPlaceholder")}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        value={focused ? (highlight >= 0 ? suggestions[highlight] : draft) : display}
        onFocus={(event) => {
          setDraft(fullValue);
          setFocused(true);
          event.currentTarget.select();
        }}
        onBlur={() => {
          setFocused(false);
          finish();
        }}
        onChange={(event) => {
          setDraft(event.target.value);
          setHighlight(-1);
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul id="browser-suggestions" className={styles.suggestions} role="listbox" aria-label={t("rightDock.browser.suggestions")}>
          {suggestions.map((suggestion, index) => (
            <li key={suggestion} role="none">
              <button
                type="button"
                role="option"
                aria-selected={index === highlight}
                className={styles.suggestion}
                // 入力欄の blur より先に選択を確定させる。
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => submit(suggestion)}
              >
                <Search size={13} className={styles.suggestionIcon} aria-hidden="true" />
                <span>{suggestion}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
