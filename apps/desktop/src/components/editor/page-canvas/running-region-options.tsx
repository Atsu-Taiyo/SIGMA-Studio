"use client";
import { Switch } from "@/components/ui/settings";
import {
  describeRunningRegionPageExceptions,
  getRunningRegionPageRange,
  listRunningRegionContentPages,
  runningRegionFieldToken,
  type PageRunningRegion,
  type RunningRegionFieldName,
  type RunningRegionPageRange,
} from "@/features/document";
import { useT } from "@/lib/i18n/react";
import type { Editor } from "@tiptap/core";
import { PanelBottom, PanelTop } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { RunningRegionKind } from "./types";

/**
 * 差し込みの行。`{page} / {total}` は 2 つの差し込みを 1 回で入れる。
 * 文字は本文へ書くとおり (`{page}`) で、描くときだけそのページの値になる。
 */
type RunningRegionInsert = RunningRegionFieldName | "pageOfTotal";

const INSERTS: readonly RunningRegionInsert[] = ["page", "total", "pageOfTotal", "title"];

const RANGES: readonly RunningRegionPageRange[] = ["all", "firstOnly", "exceptFirst"];

function insertText(insert: RunningRegionInsert): string {
  return insert === "pageOfTotal"
    ? `${runningRegionFieldToken("page")} / ${runningRegionFieldToken("total")}`
    : runningRegionFieldToken(insert);
}

/** 編集中の帯のエディタへ、カーソルの位置 (選択があれば置き換え) に文字を入れる。 */
function insertIntoRunningRegionEditor(band: HTMLElement | null, text: string): boolean {
  const dom = band?.querySelector<HTMLElement & { editor?: Editor }>(".page-running-direct-flow .ProseMirror");
  const editor = dom?.editor;
  if (!editor) {
    return false;
  }
  return editor.chain().focus().insertContent(text).run();
}

/**
 * ヘッダー/フッターの帯の右に出る小さな丸いボタンと、そこから開く設定のカード。
 *
 * - 「表示するページ」: すべて / 先頭ページのみ / 先頭ページ以外、と、「このページに表示」で
 *   そのページだけの例外 (本文を足してページが送られると、番号で決まる例外は同じ番号のページへ移る)。
 * - 「このページだけ内容を変える」: そのページ専用の文字を持たせる。変えるときは共通の文字を写して
 *   から始め、共通に戻すとそのページ専用の文字は捨てる。図形と画像は共通のまま。
 * - 編集中は、ページ番号・総ページ数・題名を入れる行も出す。差し込みの書き方 (`{page}`) を
 *   覚えなくても入れられる。
 *
 * ボタンは帯にカーソルを合わせたときと編集中だけ見える (CSS)。押すとカードが開き、外側を押す・Esc で閉じる。
 */
export function RunningRegionOptions({
  kind,
  label,
  region,
  bandRef,
  pageNumber,
  totalPages,
  title,
  editing,
  shownOnPage,
  ownContent,
  onShownOnPageChange,
  onPageRangeChange,
  onOwnContentChange,
  onClearOwnContents,
}: {
  kind: RunningRegionKind;
  label: string;
  region: PageRunningRegion;
  bandRef: { current: HTMLElement | null };
  pageNumber: number;
  totalPages: number;
  title: string;
  editing: boolean;
  shownOnPage: boolean;
  /** このページが、ページ専用の中身を持っているか。 */
  ownContent: boolean;
  onShownOnPageChange: (shown: boolean) => void;
  onPageRangeChange: (range: RunningRegionPageRange) => void;
  onOwnContentChange: (enabled: boolean) => void;
  onClearOwnContents: () => void;
}) {
  const t = useT("editor");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cardId = useId();
  const range = getRunningRegionPageRange(region);
  const exceptions = describeRunningRegionPageExceptions(region, totalPages);
  const contentPages = listRunningRegionContentPages(region).filter((page) => page <= totalPages);
  const joinPages = (pages: readonly number[]) => pages.join(t("running.pageSeparator"));
  const Icon = kind === "header" ? PanelTop : PanelBottom;
  const optionsLabel = t("running.options", { replace: { region: label } });

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOnOutsidePress = (event: MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", closeOnOutsidePress);
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.removeEventListener("mousedown", closeOnOutsidePress);
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [open]);

  const values: Record<RunningRegionInsert, string> = {
    page: String(pageNumber),
    total: String(totalPages),
    pageOfTotal: `${pageNumber} / ${totalPages}`,
    title,
  };

  return (
    <div
      ref={rootRef}
      className={`page-running-options ${kind}${open ? " open" : ""}`}
      // 帯の編集・選択の操作 (ダブルクリックで編集に入る・紙面の選択解除) に渡さない。
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="page-running-options-toggle"
        aria-label={optionsLabel}
        aria-expanded={open}
        aria-controls={open ? cardId : undefined}
        title={optionsLabel}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon size={15} aria-hidden="true" />
      </button>
      {open && (
        <div className="page-running-options-card" id={cardId} role="group" aria-label={optionsLabel}>
          {editing && (
            <section className="page-running-options-section">
              <p className="page-running-options-caption">{t("running.insertCaption")}</p>
              {INSERTS.map((insert) => (
                <button
                  key={insert}
                  type="button"
                  className="page-running-options-item"
                  // 押してもヘッダーの編集欄から焦点を外さない (外すとカーソルの位置が分からなくなる)。
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => insertIntoRunningRegionEditor(bandRef.current, insertText(insert))}
                >
                  <span>{t(`running.insert.${insert}`)}</span>
                  <span className="page-running-options-value">{values[insert]}</span>
                </button>
              ))}
            </section>
          )}
          <section className="page-running-options-section">
            <p className="page-running-options-caption" id={`${cardId}-range`}>{t("running.range.caption")}</p>
            <div className="page-running-options-range" role="radiogroup" aria-labelledby={`${cardId}-range`}>
              {RANGES.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={range === option}
                  className="page-running-options-range-option"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onPageRangeChange(option)}
                >
                  {t(`running.range.${option}`)}
                </button>
              ))}
            </div>
            <label className="page-running-options-row">
              <span>{t("running.showOnPage", { replace: { region: label } })}</span>
              <Switch
                checked={shownOnPage}
                label={t("running.showOnPageAria", { replace: { region: label, page: pageNumber } })}
                onCheckedChange={onShownOnPageChange}
              />
            </label>
            {exceptions && (
              <p className="page-running-options-hint">
                {exceptions.pages.length === 0
                  ? t("running.noPages")
                  : t(exceptions.kind === "hidden" ? "running.hiddenPages" : "running.shownPages", {
                    replace: { pages: joinPages(exceptions.pages) },
                  })}
              </p>
            )}
          </section>
          <section className="page-running-options-section">
            <p className="page-running-options-caption">{t("running.content.caption")}</p>
            <label className="page-running-options-row">
              <span>{t("running.content.own")}</span>
              <Switch
                checked={ownContent}
                label={t("running.content.ownAria", { replace: { region: label, page: pageNumber } })}
                onCheckedChange={onOwnContentChange}
              />
            </label>
            <p className="page-running-options-hint">{t("running.content.hint")}</p>
            {contentPages.length > 0 && (
              <>
                <p className="page-running-options-hint">
                  {t("running.content.pages", { replace: { pages: joinPages(contentPages) } })}
                </p>
                <button
                  type="button"
                  className="page-running-options-link"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={onClearOwnContents}
                >
                  {t("running.content.reset")}
                </button>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
