"use client";

import { Check, ChevronDown, ChevronUp, Plus, Shapes, Sigma, Trash2, Type, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
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
import { getPocketPageHost, type PocketScreenRect } from "../application/pocket-drag";
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
/** 入れた部分がポケットへ飛んでいく時間。 */
const FLIGHT_MS = 620;
/** 飛んでいく間の大きさの幅。選択が極端に大きくても小さくても、カードが画面を覆ったり点になったりしない。 */
const FLIGHT_MIN_SCALE = 0.6;
const FLIGHT_MAX_SCALE = 2;
/** 着いたカードがはずむ時間。 */
const LANDED_MS = 360;
/**
 * ポケットが開閉する時間。`controls.css` の `.app-shell` のトランジション (280ms) と揃える。
 * 閉じるときは、この時間が過ぎるまで開いた中身を描き続ける (消えてから畳むと、空の帯が縮むだけに見える)。
 * 開いて入れたときは、開き切って着く先のカードの位置が決まってから「飛んでいく」を始める。
 */
const POCKET_TRANSITION_MS = 280;
/** 畳んでいるとき、チップを出すマウスの範囲 (ポケットの段の上端から下へ)。 */
const REVEAL_ZONE_PX = 44;
/** 範囲にマウスが少し留まってから出す。上のツールバーへ向かう途中で通り過ぎただけでは出さない。 */
const REVEAL_DWELL_MS = 120;
/** 範囲を出てから、チップを引っ込めるまでの時間。 */
const REVEAL_HIDE_MS = 350;

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
  flying,
  landed,
  onInsert,
  onDragStateChange,
  t,
}: {
  item: PocketItem;
  inserted: boolean;
  justAdded: boolean;
  dragging: boolean;
  /** 入れた部分が、このカードへ飛んでいる最中。着くまで隠しておく。 */
  flying: boolean;
  /** いま着いた。はずむ。 */
  landed: boolean;
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
        data-flying={flying ? "true" : undefined}
        data-landed={landed ? "true" : undefined}
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

/** 入れた部分が飛んでいく動き。出発点 (選択) の矩形と、着く先 (新しいカード) の矩形。 */
interface PocketFlight {
  readonly id: string;
  readonly token: number;
  readonly from: PocketScreenRect;
  readonly to: PocketScreenRect;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 入れた部分が、選んでいた場所からポケットのカードへ飛んでいく。
 *
 * 着く先のカードと同じ姿のものを、選択の中心・選択に近い大きさから、少し持ち上がる弧を描いて
 * カードの位置まで運ぶ。動かすのは transform と opacity だけ (レイアウトを巻き込まない)。
 * 動きが終わる (または動きが使えない) と `onDone` を呼び、本物のカードが入れ替わりに現れる。
 */
function PocketFlyer({ item, flight, onDone }: { item: PocketItem; flight: PocketFlight; onDone: (id: string) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const { from, to } = flight;
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const start = to.width > 0 ? clamp(from.width / to.width, FLIGHT_MIN_SCALE, FLIGHT_MAX_SCALE) : 1;
    const animation = element.animate(
      [
        { opacity: 0, transform: `translate(${dx}px, ${dy}px) scale(${start})` },
        { opacity: 1, offset: 0.12, transform: `translate(${dx}px, ${dy}px) scale(${start})` },
        // 真ん中で少し持ち上げて、まっすぐ滑るのではなく「飛ぶ」弧にする。
        { opacity: 1, offset: 0.5, transform: `translate(${dx / 2}px, ${dy / 2 - 36}px) scale(${(start + 1) / 2})` },
        { opacity: 1, transform: "translate(0px, 0px) scale(1)" },
      ],
      { duration: FLIGHT_MS, easing: "cubic-bezier(0.3, 0.1, 0.2, 1)" },
    );
    let disposed = false;
    const finish = () => {
      if (!disposed) {
        onDone(flight.id);
      }
    };
    animation.finished.then(finish, finish);
    return () => {
      disposed = true;
      animation.cancel();
    };
  }, [flight, onDone]);

  return createPortal(
    <div
      ref={ref}
      className={styles.flyer}
      data-pocket-flyer={item.id}
      style={{ left: flight.to.left, top: flight.to.top, width: flight.to.width, height: flight.to.height }}
      aria-hidden="true"
    >
      <span className={styles.cardPreview}>
        <PocketItemPreview preview={item.preview} />
      </span>
      <PreviewBadge preview={item.preview} />
    </div>,
    document.body,
  );
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
  // 描く姿。ふつうは phase と同じで、開いた姿から畳むときだけ、畳み終わるまで開いた姿を描き続ける。
  const [shownPhase, setShownPhase] = useState(phase);
  if (shownPhase !== phase && !(shownPhase === "expanded" && phase === "collapsed" && !prefersReducedMotion())) {
    setShownPhase(phase);
  }
  const stripRef = useRef<HTMLUListElement | null>(null);
  const previousPhaseRef = useRef(phase);
  const [insertedId, setInsertedId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [flight, setFlight] = useState<PocketFlight | null>(null);
  const [landedId, setLandedId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const barRef = useRef<HTMLElement | null>(null);
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

    // 入れた部分 (選んでいた文章・図形) が、新しいカードへ飛んでいく。ポケットが開いて紙面が
    // 下がるので、位置はその後のレイアウトで測る。選択の位置が分からないとき・動きが使えない
    // とき・動きを減らす設定のときは出さない (カードが現れて枠が光るだけ)。
    // ポケットが開く動きの途中は、カードの位置もまだ動いている。開き切ってから測って飛ばす。
    const { id, token } = justAdded;
    const opening = previousPhaseRef.current !== "expanded";
    let frame = 0;
    const timer = window.setTimeout(() => {
      frame = window.requestAnimationFrame(() => {
        if (prefersReducedMotion() || typeof Element.prototype.animate !== "function") {
          return;
        }
        const from = getPocketPageHost()?.getSelectionRect?.() ?? null;
        const card = stripRef.current?.querySelector<HTMLElement>(`[data-pocket-item="${id}"] button`);
        if (!from || !card) {
          return;
        }
        const to = card.getBoundingClientRect();
        setFlight({ id, token, from, to: { left: to.left, top: to.top, width: to.width, height: to.height } });
      });
    }, opening && !prefersReducedMotion() ? POCKET_TRANSITION_MS : 0);
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
    };
    // 件数は通知の文面にだけ使う。入れた操作 (token) ごとに 1 回だけ走らせる。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justAdded?.token]);

  // 直前のコミットの姿。上の効果が「開く動きの最中に入れたのか」を知るために、その後で更新する。
  useEffect(() => {
    previousPhaseRef.current = phase;
  });

  // 開いた姿から畳むとき、畳む動きが終わってから畳んだ姿に切り替える。開き直したらやめる。
  useEffect(() => {
    if (shownPhase === phase) {
      return;
    }
    const timer = window.setTimeout(() => setShownPhase(phase), POCKET_TRANSITION_MS + 20);
    return () => window.clearTimeout(timer);
  }, [shownPhase, phase]);

  const finishFlight = useCallback((id: string) => {
    setFlight((current) => (current?.id === id ? null : current));
    setLandedId(id);
  }, []);

  useEffect(() => {
    if (!landedId) {
      return;
    }
    const timer = window.setTimeout(() => setLandedId(null), LANDED_MS);
    return () => window.clearTimeout(timer);
  }, [landedId]);

  // 畳んでいるあいだ、チップは普段は見えない。上部 (ポケットの段の上端から下の帯) へマウスを
  // 持っていくと現れ、離れると引っ込む。キーボードの焦点でも現れる (CSS の :focus-visible)。
  useEffect(() => {
    if (phase !== "collapsed") {
      return;
    }
    let shown = false;
    let showTimer: number | null = null;
    let hideTimer: number | null = null;
    const cancel = (timer: number | null) => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
      return null;
    };
    const scheduleShow = () => {
      hideTimer = cancel(hideTimer);
      if (!shown && showTimer === null) {
        showTimer = window.setTimeout(() => {
          showTimer = null;
          shown = true;
          setRevealed(true);
        }, REVEAL_DWELL_MS);
      }
    };
    const scheduleHide = () => {
      showTimer = cancel(showTimer);
      if (shown && hideTimer === null) {
        hideTimer = window.setTimeout(() => {
          hideTimer = null;
          shown = false;
          setRevealed(false);
        }, REVEAL_HIDE_MS);
      }
    };
    const onMove = (event: globalThis.PointerEvent) => {
      const bar = barRef.current;
      if (!bar) {
        return;
      }
      const top = bar.getBoundingClientRect().top;
      if (event.clientY >= top - 2 && event.clientY <= top + REVEAL_ZONE_PX) {
        scheduleShow();
      } else {
        scheduleHide();
      }
    };
    window.addEventListener("pointermove", onMove, true);
    document.documentElement.addEventListener("pointerleave", scheduleHide);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      document.documentElement.removeEventListener("pointerleave", scheduleHide);
      cancel(showTimer);
      cancel(hideTimer);
      setRevealed(false);
    };
  }, [phase]);

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

  if (shownPhase === "hidden") {
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

  if (shownPhase === "collapsed") {
    return (
      <section
        ref={barRef}
        className={styles.bar}
        data-phase="collapsed"
        data-revealed={revealed ? "true" : undefined}
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
  const flightItem = flight ? state.items.find((item) => item.id === flight.id) : undefined;

  return (
    <section
      className={styles.bar}
      data-phase="expanded"
      data-closing={phase === "expanded" ? undefined : "true"}
      aria-label={t("pocket.region")}
      {...{ [POCKET_ROOT_ATTRIBUTE]: "" }}
      onMouseDown={keepEditorFocus}
    >
      {/* 中身は開き切った高さのまま下端に揃え、はみ出す分は隠す。バーの高さが増えるにつれて、
          中身がクロームの下から降りてくるように見える。 */}
      <div className={styles.panel}>
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
              flying={flight?.id === item.id}
              landed={landedId === item.id}
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
          <IconButton
            tone="ghost"
            size="sm"
            label={t("pocket.close")}
            onClick={() => {
              // 飛んでいる最中に畳んだら、動きは捨てる (開き直したときに古い動きが始まらないように)。
              setFlight(null);
              setPocketExpanded(false);
            }}
          >
            <ChevronUp size={16} />
          </IconButton>
        </div>
      </div>
      {liveRegion}
      <PocketDragGhost items={state.items} t={t} />
      {flightItem && flight && <PocketFlyer item={flightItem} flight={flight} onDone={finishFlight} />}
    </section>
  );
}
