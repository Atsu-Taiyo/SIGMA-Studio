"use client";

import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { Editor as TiptapEditor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";

import { clampBlockSpaceAfterPx, resolveBlockSpaceAfterKeyAction } from "@/features/document";
import { getEffectiveZoom } from "@/features/rendering/adapters";
import { useT } from "@/lib/i18n/react";

import {
  collectTextShapeSpaceAfterUnits,
  findInnermostTextShapeSpaceAfterUnitIndex,
  isSpaceAfterTransaction,
  measureBottomWithin,
  projectPointerDeltaToShapeY,
  readTextShapeSpaceAfterPx,
  resolveSpaceAfterEdgeElement,
  resolveSpaceAfterUnitElement,
  setTextShapeSpaceAfter,
  SPACE_AFTER_TRANSACTION_META,
} from "./text-shape-space-after";

/** 画面上の座標を持つ最小のポインタ (ドラッグは window のイベントで追う)。 */
interface PointerPoint {
  clientX: number;
  clientY: number;
}

interface SpaceAfterGesture {
  /** 掴んだ単位の添字。ドラッグ中は構造が変わらない (属性を書き換えるだけ) ので添字で指せる。 */
  index: number;
  startPx: number;
  px: number;
  startPoint: PointerPoint;
  point: PointerPoint;
  /** 画面 px → 論理 px の換算 (ズーム)。掴んだ瞬間に決める。 */
  scale: number;
  frame: number | null;
}

interface HandleController {
  startDrag(event: ReactPointerEvent<HTMLButtonElement>): void;
  keyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void;
  reset(): void;
}

/**
 * 編集中のテキスト図形の、段落ごとの下余白つまみ (本文の `.page-block-space-handle` と同じ見た目・同じ操作)。
 *
 * 出る場所は編集中の図形の左ガターで、ポインタの下の段落、無ければキャレットのある段落の下端。
 * 図形を選んだだけでは出さない (呼び出し側が `editing` のときだけ置く)。
 *
 * 相手の指し方・書き方は本文と違う。本文は SigmaDoc のブロックを書き換えて編集面に流し込むが、
 * 編集中の図形は流し込みで選択が飛ぶので、ProseMirror の属性 (`spaceAfterPx`) を **直接** 書く。
 * 描画は属性が出す custom property を `document-surface.css` が padding にするだけなので、
 * 後続の段落は本物のレイアウトで動き、リスト項目の入れ子も本文と同じ規則で追従する。
 *
 * ドラッグ中は文書へ書かない。編集面の属性だけを動かして (`preventUpdate`)、離した時に 1 回だけ
 * `onCommit` で図形の blocks へ確定する — 取り消しが 1 手になり、保存も 1 回で済む。
 */
export function OverlayTextShapeSpaceHandle({
  editor,
  wrapperRef,
  rotation,
  draggingRef,
  onCommit,
}: {
  editor: TiptapEditor;
  /** 図形の箱。つまみを置く座標系 (位置指定の祖先) で、ホバーを拾う範囲でもある。 */
  wrapperRef: RefObject<HTMLDivElement | null>;
  /** 図形の回転 (rad)。ポインタの縦移動を図形の縦軸へ射影するのに使う。 */
  rotation: number;
  /** ドラッグ中かどうか。ドラッグ中は箱の高さの測り直しを保存しない (離した時の確定が持つ)。 */
  draggingRef: MutableRefObject<boolean>;
  /** 編集面の内容を図形の blocks として確定する (取り消し履歴に 1 手積む)。 */
  onCommit: () => void;
}) {
  const tEditor = useT("editor");
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const controllerRef = useRef<HandleController | null>(null);
  const rotationRef = useRef(rotation);
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    rotationRef.current = rotation;
    onCommitRef.current = onCommit;
  }, [onCommit, rotation]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const button = buttonRef.current;
    if (!wrapper || !button) {
      return;
    }

    let hoveredIndex: number | null = null;
    let gesture: SpaceAfterGesture | null = null;
    let frame: number | null = null;
    let current: { index: number; px: number } | null = null;

    // 編集面 (view) は mount の後に作られる。作られる前に `editor.view` を読むと例外になる。
    const alive = () => editor.isInitialized && !editor.isDestroyed;

    /** いま相手にする単位。ドラッグ中は掴んだ単位、次にホバー、最後にキャレットのある単位。 */
    const measure = () => {
      // 編集できない面 (読み取り専用・ロック中) は余白も動かせない。
      if (!alive() || !editor.isEditable) {
        return null;
      }
      const units = collectTextShapeSpaceAfterUnits(editor.state.doc);
      let index = gesture?.index ?? hoveredIndex ?? -1;
      if (index < 0 || index >= units.length) {
        // 区切り線を選んでいるときは、その線自身がキャレットの代わり (head は線の外側になる)。
        const { selection } = editor.state;
        index = findInnermostTextShapeSpaceAfterUnitIndex(units, "node" in selection ? selection.from : selection.head);
      }
      const unit = units[index];
      if (!unit) {
        return null;
      }
      const edge = resolveSpaceAfterEdgeElement(editor.view, unit);
      const bottom = edge ? measureBottomWithin(edge, wrapper) : null;
      return bottom === null ? null : { index, px: readTextShapeSpaceAfterPx(unit), bottom };
    };

    /** つまみの位置を DOM へ書く。ドラッグ中は React を介さず同じフレームで動かす。 */
    const place = () => {
      frame = null;
      const target = measure();
      current = target ? { index: target.index, px: target.px } : null;
      if (!target) {
        button.removeAttribute("data-visible");
        return;
      }
      button.dataset.visible = "true";
      button.dataset.index = String(target.index);
      button.style.top = `${target.bottom}px`;
    };
    const schedule = () => {
      if (frame === null) {
        frame = window.requestAnimationFrame(place);
      }
    };

    /** 単位の下余白を書く。`preview` は文書へ確定しない書き込み (離した時に 1 回だけ確定する)。 */
    const writePx = (index: number, px: number, preview: boolean): boolean => {
      if (!alive()) {
        return false;
      }
      const unit = collectTextShapeSpaceAfterUnits(editor.state.doc)[index];
      if (!unit || readTextShapeSpaceAfterPx(unit) === px) {
        return false;
      }
      const transaction = setTextShapeSpaceAfter(editor.state.tr, unit, px)
        .setMeta(SPACE_AFTER_TRANSACTION_META, true)
        .setMeta("addToHistory", false);
      if (preview) {
        transaction.setMeta("preventUpdate", true);
      }
      editor.view.dispatch(transaction);
      return true;
    };

    const pxAt = (drag: SpaceAfterGesture, point: PointerPoint) => clampBlockSpaceAfterPx(
      drag.startPx + projectPointerDeltaToShapeY(
        point.clientX - drag.startPoint.clientX,
        point.clientY - drag.startPoint.clientY,
        rotationRef.current,
        drag.scale,
      ),
    );

    const applyPreviewFrame = (drag: SpaceAfterGesture) => {
      drag.frame = null;
      const next = pxAt(drag, drag.point);
      if (next === drag.px) {
        return;
      }
      drag.px = next;
      writePx(drag.index, next, true);
      // 書き込んだフレームのうちにつまみを辺へ合わせる (次のフレームまで待つと遅れて見える)。
      place();
    };

    const stopListening = (drag: SpaceAfterGesture) => {
      if (drag.frame !== null) {
        window.cancelAnimationFrame(drag.frame);
        drag.frame = null;
      }
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("keydown", handleKeyDown, true);
      delete button.dataset.dragging;
      draggingRef.current = false;
      gesture = null;
    };

    /** 掴む前の値へ戻して畳む。文書へは何も書いていないので、確定の取り消しではない。 */
    const cancelDrag = () => {
      const drag = gesture;
      if (!drag) {
        return;
      }
      stopListening(drag);
      writePx(drag.index, drag.startPx, true);
      schedule();
    };

    function handlePointerMove(event: PointerEvent) {
      const drag = gesture;
      if (!drag) {
        return;
      }
      // 溜めるだけ。ポインタは 1 フレームに何度も来るので、書く仕事は rAF 1 回に畳む。
      drag.point = { clientX: event.clientX, clientY: event.clientY };
      if (drag.frame === null) {
        drag.frame = window.requestAnimationFrame(() => applyPreviewFrame(drag));
      }
    }

    function handlePointerCancel() {
      cancelDrag();
    }

    function handlePointerUp(event: PointerEvent) {
      const drag = gesture;
      if (!drag) {
        return;
      }
      // 確定値は離した位置から出し直す (rAF の間引きで、最後の動きが落ちないように)。
      const finalPx = pxAt(drag, { clientX: event.clientX, clientY: event.clientY });
      stopListening(drag);
      writePx(drag.index, finalPx, true);
      if (finalPx !== drag.startPx) {
        onCommitRef.current();
      }
      schedule();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      // 掴んでいる間の Escape は「ドラッグをやめる」。編集の終了 (図形側の Escape) へは渡さない。
      event.preventDefault();
      event.stopPropagation();
      cancelDrag();
    }

    controllerRef.current = {
      startDrag(event) {
        // 押下を止める: 図形の移動・編集の終了へ渡さない。`preventDefault` は mousedown 側で行う。
        event.stopPropagation();
        if (event.button !== 0 || !current || !alive()) {
          return;
        }
        if (gesture) {
          cancelDrag();
        }
        const point = { clientX: event.clientX, clientY: event.clientY };
        const drag: SpaceAfterGesture = {
          index: current.index,
          startPx: current.px,
          px: current.px,
          startPoint: point,
          point,
          scale: getEffectiveZoom(wrapper, "y"),
          frame: null,
        };
        gesture = drag;
        draggingRef.current = true;
        button.dataset.dragging = "true";
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // 取れなくても window のリスナで追える。
        }
        window.addEventListener("pointermove", handlePointerMove, { passive: true });
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", handlePointerCancel);
        // capture で拾う: 本文やポップオーバーが先に Escape を食べても、掴んでいる間はこちらが勝つ。
        window.addEventListener("keydown", handleKeyDown, true);
      },
      keyDown(event) {
        const action = resolveBlockSpaceAfterKeyAction(event);
        if (!action || !current) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const next = action.kind === "reset" ? 0 : clampBlockSpaceAfterPx(current.px + action.deltaPx);
        // 確定の書き込み (`preventUpdate` なし): 編集面の onUpdate が図形の blocks へ 1 手で確定する。
        if (writePx(current.index, next, false)) {
          // 次のキーまでに置き直しが間に合わなくても、続けて押した分が同じ値から積まれるように。
          current = { index: current.index, px: next };
        }
        schedule();
      },
      reset() {
        if (current) {
          writePx(current.index, 0, false);
          schedule();
        }
      },
    };

    const handleWrapperPointerMove = (event: PointerEvent) => {
      if (gesture || !(event.target instanceof Element) || button.contains(event.target)) {
        return;
      }
      const element = resolveSpaceAfterUnitElement(event.target, editor.view.dom);
      const units = collectTextShapeSpaceAfterUnits(editor.state.doc);
      const index = element ? units.findIndex((unit) => editor.view.nodeDOM(unit.pos) === element) : -1;
      // 単位に当たらない場所 (引用の中・余白) は、いまの相手を手放してキャレットの段落へ戻す。
      // 図形の外へ出たときは何もしない: 左ガターのつまみへ向かう途中で消えないように。
      const next = index >= 0 ? index : null;
      if (next !== hoveredIndex) {
        hoveredIndex = next;
        schedule();
      }
    };
    const handleSelectionUpdate = () => {
      hoveredIndex = null;
      schedule();
    };
    const handleTransaction = ({ transaction }: { transaction: Transaction }) => {
      // 構造が変わる編集 (Enter・削除・取り消し) の後は、位置で指した相手が別物になりうる。
      if (transaction.docChanged && !isSpaceAfterTransaction(transaction)) {
        hoveredIndex = null;
      }
      schedule();
    };

    wrapper.addEventListener("pointermove", handleWrapperPointerMove);
    editor.on("selectionUpdate", handleSelectionUpdate);
    editor.on("transaction", handleTransaction);
    // 箱の大きさ (= 中身の高さ) が変わったら置き直す: 折り返し・フォントの読み込み・外からの差し替え。
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resizeObserver?.observe(wrapper);
    schedule();

    return () => {
      if (gesture) {
        cancelDrag();
      }
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      wrapper.removeEventListener("pointermove", handleWrapperPointerMove);
      editor.off("selectionUpdate", handleSelectionUpdate);
      editor.off("transaction", handleTransaction);
      resizeObserver?.disconnect();
      controllerRef.current = null;
    };
  }, [draggingRef, editor, wrapperRef]);

  return (
    <div className="overlay-text-space-layer" data-testid="overlay-text-space-layer">
      <button
        ref={buttonRef}
        type="button"
        className="page-block-space-handle overlay-text-space-handle"
        data-testid="overlay-text-space-handle"
        aria-label={tEditor("pageCanvas.spaceAfter")}
        title={tEditor("pageCanvas.spaceAfterHint")}
        onMouseDown={(event) => {
          // 焦点と選択を動かさない (キャレットが飛ばず、編集も終わらない)。
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerDown={(event) => controllerRef.current?.startDrag(event)}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => {
          event.stopPropagation();
          controllerRef.current?.reset();
        }}
        onKeyDown={(event) => controllerRef.current?.keyDown(event)}
      />
    </div>
  );
}
