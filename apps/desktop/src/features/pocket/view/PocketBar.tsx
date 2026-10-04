"use client";

import { Check, ChevronDown, ChevronUp, Plus, Shapes, Sigma, Trash2, Type, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";

import { IconButton } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import type { Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";

import {
  clearPocket,
  dismissPocketNotice,
  dismissPocketRemoval,
  getPocketPhase,
  removeFromPocket,
  setPocketExpanded,
  undoPocketRemoval,
  usePocketState,
} from "../application/pocket-store";
import { usePocketDragState } from "../application/pocket-drag-state";
import { consumePocketDragClick, startPocketPointerDrag, type PocketDragOutcome } from "../application/pocket-pointer-drag";
import { addSelectionToPocket, insertPocketItem, POCKET_ROOT_ATTRIBUTE } from "../application/pocket-transfer";
import type { PocketItem } from "../model/pocket-items";
import type { PocketPreview } from "../model/pocket-preview";
import styles from "./PocketBar.module.css";
import { PocketItemPreview } from "./PocketPreview";

/** 「元に戻す」を出しておく時間。 */
const REMOVAL_UNDO_MS = 8000;
/** うまくいかなかった理由を出しておく時間。 */
const NOTICE_MS = 5000;
/** 挿入できたことを、カードの上に出しておく時間。 */
const INSERTED_FLASH_MS = 900;

/** 仕立て屋の「パッチポケット」。lucide に無いので、同じ線の太さ・端の丸めで描く。 */
export function PocketIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 4h14v9a7 7 0 0 1-14 0V4Z" />
      <path d="M5 8.5h14" />
    </svg>
  );
}

function previewSummary(preview: PocketPreview, t: Translate<"editor">): string {
  switch (preview.kind) {
    case "blocks":
      return t("pocket.summary.blocks", { replace: { blocks: preview.blockCount } });
    case "shapes":
      return t("pocket.summary.shapes", { replace: { shapes: preview.shapeCount } });
    case "mixed":
      return t("pocket.summary.mixed", { replace: { shapes: preview.shapeCount } });
    case "math":
      return t("pocket.summary.math");
    case "text":
      return t("pocket.summary.text");
  }
}

/** カードの読み上げ名と、ホバーで出る説明に使う、中身の頭の部分。 */
function previewSnippet(preview: PocketPreview, length = 60): string {
  const text = preview.kind === "blocks" || preview.kind === "mixed" || preview.kind === "text"
    ? preview.text
    : preview.kind === "math" ? preview.tex : "";
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

/** 種類の目印のアイコン。カードの隅とドラッグ中のゴーストで同じものを使う。 */
function PreviewKindIcon({ preview, size, className }: { preview: PocketPreview; size: number; className?: string }) {
  if (preview.kind === "shapes" || preview.kind === "mixed") {
    return <Shapes className={className} size={size} />;
  }
  return preview.kind === "math" ? <Sigma className={className} size={size} /> : <Type className={className} size={size} />;
}

/** カードの隅の目印。種類がひと目で分かり、複数個あるときだけ数を添える。 */
function PreviewBadge({ preview }: { preview: PocketPreview }) {
  const count = preview.kind === "blocks" ? preview.blockCount
    : preview.kind === "shapes" || preview.kind === "mixed" ? preview.shapeCount : 1;
  return (
    <span className={styles.badge} aria-hidden="true">
      <PreviewKindIcon preview={preview} size={11} />
      {count > 1 && <span>{count}</span>}
    </span>
  );
}

function PocketCard({
  item,
  inserted,
  justAdded,
  dragging,
  onInsert,
  onDragStateChange,
  t,
}: {
  item: PocketItem;
  inserted: boolean;
  justAdded: boolean;
  dragging: boolean;
  onInsert: (id: string) => void;
  onDragStateChange: (id: string, state: "start" | PocketDragOutcome) => void;
  t: Translate<"editor">;
}) {
  const summary = previewSummary(item.preview, t);
  const snippet = previewSnippet(item.preview);
  const label = t("pocket.insert", { replace: { summary: snippet ? `${summary}「${snippet}」` : summary } });

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      removeFromPocket([item.id]);
    }
  };

  // 押した位置から動かすとドラッグになる。動かさずに離せば、ふつうのクリック (挿入)。
  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary) {
      return;
    }
    startPocketPointerDrag(item.id, event, {
      onStart: () => onDragStateChange(item.id, "start"),
      onEnd: (outcome) => onDragStateChange(item.id, outcome),
    });
  };

  const handleClick = () => {
    // ドラッグの終わりをカードの上で離したときの click は、挿入として扱わない。
    if (!consumePocketDragClick()) {
      onInsert(item.id);
    }
  };

  return (
    <li className={styles.item} data-pocket-item={item.id}>
      <button
        type="button"
        className={styles.card}
        aria-label={label}
        title={`${snippet || summary}\n${t("pocket.insertHint")}`}
        data-kind={item.preview.kind}
        data-just-added={justAdded ? "true" : undefined}
        data-inserted={inserted ? "true" : undefined}
        data-dragging={dragging ? "true" : undefined}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
      >
        <span className={styles.cardPreview}>
          <PocketItemPreview preview={item.preview} />
        </span>
        <PreviewBadge preview={item.preview} />
        {inserted && (
          <span className={styles.insertedMark} aria-hidden="true">
            <Check size={18} />
          </span>
        )}
      </button>
      <button
        type="button"
        className={styles.remove}
        aria-label={t("pocket.remove")}
        title={t("pocket.remove")}
        onClick={() => removeFromPocket([item.id])}
      >
        <X size={12} />
      </button>
    </li>
  );
}

/**
 * ドラッグしているカードのゴースト。ポインタに付いて動き、指している場所がドロップを受けないときは
 * 薄くなる。ポインタの動きで描き直すのはここだけ (並びは動かさない)。
 */
function PocketDragGhost({ items, t }: { items: readonly PocketItem[]; t: Translate<"editor"> }) {
  const drag = usePocketDragState();
  const item = drag ? items.find((candidate) => candidate.id === drag.id) : undefined;
  if (!drag || !item) {
    return null;
  }
  return createPortal(
    <div
      className={styles.ghost}
      data-accepted={drag.accepted ? "true" : "false"}
      style={{ left: drag.x + 14, top: drag.y + 14 }}
      aria-hidden="true"
    >
      <PreviewKindIcon preview={item.preview} size={14} className={styles.ghostIcon} />
      <span className={styles.ghostText}>{previewSnippet(item.preview, 24) || previewSummary(item.preview, t)}</span>
    </div>,
    document.body,
  );
}

/**
 * 編集画面の上にある、一時的な置き場。
 *
 * 選んだ文章・図形・ブロックをコピーと同じ内容で入れておき、別のページや別の教材へ何度でも
 * 挿入できる。カードは押すとキャレットの位置へ、ドラッグすると落とした場所へ入る。畳んでいる間は
 * 上部に件数だけの小さなチップを出す。中身はこのアプリの作業台で、教材には保存されず、共有しても相手には見えない。
 * 押してもキャレットと選択を動かさない (ボタンの mousedown で焦点を奪わない) ので、
 * 本文を選んだまま「入れる」、キャレットを置いたまま「挿入する」ができる。
 */
export function PocketBar({ addShortcut }: { addShortcut?: string | null }) {
  const t = useT("editor");
  const state = usePocketState();
  const phase = getPocketPhase(state);
  const stripRef = useRef<HTMLUListElement | null>(null);
  const [insertedId, setInsertedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const { removal, notice, justAdded } = state;

  // 入れた直後は、並びの端までスクロールして新しいカードを見せる。
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !justAdded) {
      return;
    }
    strip.scrollTo({ left: strip.scrollWidth, behavior: "auto" });
    setAnnouncement(t("pocket.announceAdded", { replace: { items: state.items.length } }));
    // 件数は通知の文面にだけ使う。入れた操作 (token) ごとに 1 回だけ走らせる。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justAdded?.token]);

  // マウスのホイール (縦回転) でも並びを横へ送れるようにする。トラックパッドの横スクロールは
  // そのまま通す。React の onWheel は passive で preventDefault できないので、直接つなぐ。
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      if (event.deltaX !== 0 || strip.scrollWidth <= strip.clientWidth) {
        return;
      }
      event.preventDefault();
      strip.scrollLeft += event.deltaY;
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, [phase]);

  useEffect(() => {
    if (!removal) {
      return;
    }
    const timer = window.setTimeout(() => dismissPocketRemoval(removal.token), REMOVAL_UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [removal]);

  useEffect(() => {
    if (!notice) {
      return;
    }
    const timer = window.setTimeout(() => dismissPocketNotice(notice.token), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!insertedId) {
      return;
    }
    const timer = window.setTimeout(() => setInsertedId(null), INSERTED_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [insertedId]);

  if (phase === "hidden") {
    return null;
  }

  const flashInserted = (id: string) => {
    setInsertedId(id);
    setAnnouncement(t("pocket.announceInserted"));
  };

  const insert = (id: string) => {
    if (insertPocketItem(id) === "inserted") {
      flashInserted(id);
    }
  };

  const handleDragStateChange = (id: string, state: "start" | PocketDragOutcome) => {
    setDraggingId(state === "start" ? id : null);
    // 受けた場所があったときだけ、挿入できたことを知らせる (受けない場所では何も言わない)。
    if (state === "dropped") {
      flashInserted(id);
    }
  };

  // ボタンを押しても、本文のキャレットや選択を奪わない。入力欄 (無いが将来のため) は除く。
  const keepEditorFocus = (event: MouseEvent<HTMLElement>) => {
    if (!(event.target instanceof Element) || !event.target.closest("input, textarea")) {
      event.preventDefault();
    }
  };

  const liveRegion = (
    <span className="visually-hidden" role="status" aria-live="polite">{announcement}</span>
  );

  if (phase === "collapsed") {
    return (
      <section
        className={styles.bar}
        data-phase="collapsed"
        aria-label={t("pocket.region")}
        {...{ [POCKET_ROOT_ATTRIBUTE]: "" }}
        onMouseDown={keepEditorFocus}
      >
        <button type="button" className={styles.handle} onClick={() => setPocketExpanded(true)} title={t("pocket.open")}>
          <PocketIcon size={14} />
          <span>{t("pocket.handle", { replace: { items: state.items.length } })}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        {liveRegion}
      </section>
    );
  }

  const noticeText = notice ? t(`pocket.notice.${notice.kind}`) : null;

  return (
    <section
      className={styles.bar}
      data-phase="expanded"
      aria-label={t("pocket.region")}
      {...{ [POCKET_ROOT_ATTRIBUTE]: "" }}
      onMouseDown={keepEditorFocus}
    >
      <div className={styles.title}>
        <PocketIcon />
        <span className={styles.titleText}>{t("pocket.title")}</span>
        {state.items.length > 0 && <span className={styles.count}>{state.items.length}</span>}
      </div>

      <ul ref={stripRef} className={styles.strip} aria-label={t("pocket.list")}>
        {state.items.map((item) => (
          <PocketCard
            key={item.id}
            item={item}
            inserted={insertedId === item.id}
            justAdded={justAdded?.id === item.id}
            dragging={draggingId === item.id}
            onInsert={insert}
            onDragStateChange={handleDragStateChange}
            t={t}
          />
        ))}
        <li className={styles.item}>
          <Tooltip label={t("pocket.addTooltip")} shortcut={addShortcut}>
            <button type="button" className={styles.addCard} onClick={() => addSelectionToPocket()}>
              <Plus size={16} aria-hidden="true" />
              <span>{t("pocket.add")}</span>
            </button>
          </Tooltip>
        </li>
        {state.items.length === 0 && !noticeText && !removal && (
          <li className={styles.empty}>{t("pocket.empty")}</li>
        )}
      </ul>

      <div className={styles.side}>
        {noticeText && <p className={styles.notice} data-tone="error" role="status">{noticeText}</p>}
        {!noticeText && removal && (
          <p className={styles.notice}>
            <span>{t("pocket.removed", { replace: { items: removal.removed.length } })}</span>
            <button type="button" className={styles.undo} onClick={undoPocketRemoval}>{t("pocket.undo")}</button>
          </p>
        )}
        {state.items.length > 1 && (
          <IconButton
            tone="ghost"
            size="sm"
            label={t("pocket.clear")}
            className={styles.dangerOnHover}
            onClick={clearPocket}
          >
            <Trash2 size={15} />
          </IconButton>
        )}
        <IconButton tone="ghost" size="sm" label={t("pocket.close")} onClick={() => setPocketExpanded(false)}>
          <ChevronUp size={16} />
        </IconButton>
      </div>
      {liveRegion}
      <PocketDragGhost items={state.items} t={t} />
    </section>
  );
}
