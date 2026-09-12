"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

import { ModalBody, ModalFrame } from "@/components/ui/Modal";
import { useAppLocale, useT } from "@/lib/i18n/react";

import {
  filterPaletteEntries,
  flattenPaletteGroups,
  groupPaletteEntries,
  type PaletteEntry,
} from "./command-palette-model";

export interface CommandPaletteProps {
  open: boolean;
  entries: readonly PaletteEntry[];
  onClose: () => void;
  onSelect: (entry: PaletteEntry) => void;
}

/** 検索欄に貼れる長さの上限。誤ペーストで 155 件 × 正規化が走るのを止める。 */
const MAX_QUERY_LENGTH = 200;

/**
 * ⌘P で開く単一の入口。コマンドと設定項目を同じ一覧で探して実行する。
 *
 * 並び・スコアリングは `command-palette-model.ts` (純関数) が決め、ここは描画と
 * キーボード操作だけを持つ。VS Code 風に 1 行 = 1 項目の密度で出す。
 */
export function CommandPalette({ open, entries, onClose, onSelect }: CommandPaletteProps) {
  if (!open) {
    return null;
  }
  return <CommandPaletteBody entries={entries} onClose={onClose} onSelect={onSelect} />;
}

function CommandPaletteBody({
  entries,
  onClose,
  onSelect,
}: {
  entries: readonly PaletteEntry[];
  onClose: () => void;
  onSelect: (entry: PaletteEntry) => void;
}) {
  const t = useT("command");
  const locale = useAppLocale();
  const listId = useId();
  const [query, setQuery] = useState("");
  // 選択位置は「どの絞り込み結果に対する何番目か」まで含めて持つ。
  // 絞り込みが変わったら先頭に戻したいが、それを effect でやると
  // 1 文字ごとに再レンダーが 2 回走る (cascading render)。クエリを一緒に覚えておけば
  // 描画時の比較だけで同じ結果になる。
  const [selection, setSelection] = useState<{ query: string; index: number }>({
    query: "",
    index: 0,
  });
  const activeIndex = selection.query === query ? selection.index : 0;
  const listRef = useRef<HTMLDivElement | null>(null);
  // 「キー操作で動いたのか、実際にポインタが動いたのか」。↑↓ でリストがスクロールすると
  // 静止したままのカーソルの下に別の行が滑り込んで mouseenter が発火し、選択を奪う。
  const pointerMovedRef = useRef(false);

  const groups = useMemo(
    () => groupPaletteEntries(filterPaletteEntries(entries, query, locale)),
    [entries, query, locale],
  );
  // 画面の並びを選択の唯一の出典にする。ここがずれると ↑↓ が行を飛ばす。
  const matches = useMemo(() => flattenPaletteGroups(groups), [groups]);

  const active = matches[Math.min(activeIndex, matches.length - 1)];

  // キーボードだけで「開く→絞る→実行」が完結するのが受入基準なので、
  // 選択中の行は必ず視界に入れる。
  useEffect(() => {
    if (!active) {
      return;
    }
    const element = listRef.current?.querySelector<HTMLElement>(
      `[data-palette-entry="${cssEscape(active.id)}"]`,
    );
    element?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const move = (delta: number) => {
    if (matches.length === 0) {
      return;
    }
    pointerMovedRef.current = false;
    setSelection({ query, index: (activeIndex + delta + matches.length) % matches.length });
  };

  return (
    <ModalFrame
      open
      onDismiss={onClose}
      size="md"
      ariaLabel={t("palette.title")}
      className="command-palette-overlay"
      surfaceClassName="command-palette-surface"
    >
      <ModalBody className="command-palette-body" padding="none">
        <div className="command-palette-search">
          <input
            data-modal-initial-focus
            className="command-palette-input"
            value={query}
            role="combobox"
            aria-expanded
            aria-autocomplete="list"
            aria-controls={listId}
            aria-activedescendant={active ? `${listId}-${active.id}` : undefined}
            placeholder={t("palette.placeholder")}
            maxLength={MAX_QUERY_LENGTH}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // IME 変換中の Enter は「確定」であって「実行」ではない。日本語で
              // 「たいじ」→変換→Enter が、そのままコマンド実行になってはいけない。
              // ↑↓ も変換候補の送りと取り合いになる。
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
                return;
              }
              // ⌘P をもう一度押したら閉じる。ここで拾わないと web ビルドでは
              // ブラウザの印刷ダイアログが出る。
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "p") {
                event.preventDefault();
                onClose();
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                move(1);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                move(-1);
                return;
              }
              if (event.key === "Home") {
                event.preventDefault();
                pointerMovedRef.current = false;
                setSelection({ query, index: 0 });
                return;
              }
              if (event.key === "End") {
                event.preventDefault();
                pointerMovedRef.current = false;
                setSelection({ query, index: Math.max(0, matches.length - 1) });
                return;
              }
              if (event.key === "Enter" && active) {
                event.preventDefault();
                onSelect(active);
              }
            }}
          />
        </div>

        <div
          className="command-palette-list"
          id={listId}
          role="listbox"
          aria-label={t("palette.listAria")}
          ref={listRef}
          onPointerMove={() => {
            pointerMovedRef.current = true;
          }}
        >
          {matches.length === 0 ? (
            <p className="command-palette-empty">{t("palette.empty")}</p>
          ) : groups.map((group) => (
            <div className="command-palette-group" role="group" aria-label={group.group} key={group.groupId}>
              <div className="command-palette-group-label" aria-hidden>{group.group}</div>
              {group.entries.map((entry) => {
                const selected = active?.id === entry.id;
                return (
                  <button
                    key={entry.id}
                    id={`${listId}-${entry.id}`}
                    type="button"
                    role="option"
                    // フォーカスは入力欄に留めたまま aria-activedescendant で示す。
                    // Tab 順に入れると Modal のフォーカストラップと二重になる。
                    tabIndex={-1}
                    aria-selected={selected}
                    data-palette-entry={entry.id}
                    className={`command-palette-entry ${selected ? "selected" : ""}`}
                    // mousedown で選択を移すと、click 前に入力欄からフォーカスが外れる。
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => {
                      // 実際にポインタが動いたときだけ。スクロールで行が滑り込んだ
                      // だけの mouseenter でキーボードの選択を奪わない。
                      if (pointerMovedRef.current) {
                        setSelection({ query, index: matches.indexOf(entry) });
                      }
                    }}
                    onClick={() => onSelect(entry)}
                  >
                    <span className="command-palette-entry-label">{entry.label}</span>
                    {entry.detail ? <span className="command-palette-entry-detail">{entry.detail}</span> : null}
                    {entry.kind === "command" && entry.shortcut
                      ? <kbd className="command-palette-entry-shortcut">{entry.shortcut}</kbd>
                      : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <p className="command-palette-hint">{t("palette.hint")}</p>
      </ModalBody>
    </ModalFrame>
  );
}

/**
 * `CSS.escape` は happy-dom に無いことがあるので、無いときだけ最低限の逃がしをする。
 * コマンド id は `[a-z0-9._-]` しか含まない前提だが、`CSS.escape` があるなら
 * そちらに任せる (自前実装は改行や制御文字を逃がせず `querySelector` が投げる)。
 */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/gu, "\\$&");
}
