"use client";

import type { Editor as TiptapEditor } from "@tiptap/core";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

import {
  commitListIndent,
  defaultListIndentEmForNode,
  findListIndentTarget,
  listIndentEmForNode,
  setListIndentPreview,
  type ListIndentTarget,
} from "@/components/tiptap/list-indent-extension";
import { LIST_INDENT_EM_MAX, LIST_INDENT_EM_MIN, LIST_INDENT_EM_STEP } from "@/features/document";
import { useT } from "@/lib/i18n/react";

/** 既定の字下げへ吸い寄せる幅 (字)。段組の境界の「均等の近くで吸着」と同じ考え方。 */
const SNAP_TO_DEFAULT_EM = 0.2;
/** 横の目盛り (トラック) の長さ。字下げの上限まで。 */
const TRACK_EM = LIST_INDENT_EM_MAX;

interface SliderGeometry {
  /** リストの左端 (= マーカーが本文の左端に揃うときの位置)。`.text-flow-shell` の座標。 */
  listLeft: number;
  /** 文字の始まる線。 */
  textLeft: number;
  top: number;
  height: number;
  fontSizePx: number;
}

interface DragState {
  pointerId: number;
  target: ListIndentTarget;
  startClientX: number;
  startEm: number;
  defaultEm: number;
  scale: number;
  fontSizePx: number;
  em: number;
}

/**
 * キャレットのあるリストに出る字下げのつまみ。リストの上辺の「文字の始まる線」に▼を置き、
 * 左右に引くとその線 (= マーカーごと項目) が動く。引いている間は線を縦に通して字数を出す。
 * ダブルクリックで既定 (マーカーの左端が本文の左端に揃う幅)、←/→ で 0.25字 (Shift で 1字)。
 *
 * 位置は `.text-flow-shell` の中の絶対配置なので、紙面の拡大縮小はそのまま乗る。
 */
export function ListIndentSlider({ editor, shellRef }: { editor: TiptapEditor | null; shellRef: RefObject<HTMLDivElement | null> }) {
  const t = useT("editor");
  const [target, setTarget] = useState<ListIndentTarget | null>(null);
  const [geometry, setGeometry] = useState<SliderGeometry | null>(null);
  const [dragEm, setDragEm] = useState<number | null>(null);
  const [knobFocused, setKnobFocused] = useState(false);
  const dragRef = useRef<DragState | null>(null);
  const knobFocusedRef = useRef(false);
  useEffect(() => {
    knobFocusedRef.current = knobFocused;
  }, [knobFocused]);

  const measure = useCallback(() => {
    const shell = shellRef.current;
    if (!editor || editor.isDestroyed || !shell) {
      setTarget(null);
      setGeometry(null);
      return;
    }
    const next = editor.isEditable && (editor.isFocused || dragRef.current || knobFocusedRef.current)
      ? findListIndentTarget(editor.state.selection.$from)
      : null;
    const list = next ? editor.view.nodeDOM(next.pos) : null;
    if (!next || !(list instanceof HTMLElement)) {
      setTarget(null);
      setGeometry(null);
      return;
    }
    const shellRect = shell.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const scale = shell.offsetWidth > 0 ? shellRect.width / shell.offsetWidth : 1;
    const style = getComputedStyle(list);
    const listLeft = (listRect.left - shellRect.left) / scale;
    setTarget(next);
    setGeometry({
      listLeft,
      textLeft: listLeft + (Number.parseFloat(style.paddingInlineStart) || 0),
      top: (listRect.top - shellRect.top) / scale,
      height: listRect.height / scale,
      fontSizePx: Number.parseFloat(style.fontSize) || 16,
    });
  }, [editor, shellRef]);

  // 文書・選択・フォーカスが変わるたびに測り直す。DOM が描き終わった後のフレームで読む。
  useEffect(() => {
    if (!editor) {
      return;
    }
    let frame: number | null = null;
    const schedule = () => {
      if (frame === null) {
        frame = window.requestAnimationFrame(() => {
          frame = null;
          measure();
        });
      }
    };
    editor.on("transaction", schedule);
    editor.on("focus", schedule);
    editor.on("blur", schedule);
    window.addEventListener("resize", schedule);
    const shell = shellRef.current;
    const observer = shell && typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    if (shell) observer?.observe(shell);
    schedule();
    return () => {
      editor.off("transaction", schedule);
      editor.off("focus", schedule);
      editor.off("blur", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [editor, measure, shellRef]);

  useEffect(() => {
    measure();
  }, [knobFocused, measure]);

  const commit = useCallback((listTarget: ListIndentTarget, indentEm: number | null) => {
    if (!editor || editor.isDestroyed) {
      return;
    }
    // 引いている間に文書が変わっていたら、つかんだときのノードではなく今のノードへ書く。
    const node = editor.state.doc.nodeAt(listTarget.pos);
    if (!node || node.type !== listTarget.node.type) {
      editor.view.dispatch(setListIndentPreview(editor.state.tr, null));
      return;
    }
    editor.view.dispatch(commitListIndent(editor.state, { pos: listTarget.pos, node }, indentEm));
  }, [editor]);

  const endDrag = useCallback((apply: boolean) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    dragRef.current = null;
    setDragEm(null);
    if (apply && drag.em !== drag.startEm) {
      commit(drag.target, drag.em);
    } else if (editor && !editor.isDestroyed) {
      editor.view.dispatch(setListIndentPreview(editor.state.tr, null));
    }
  }, [commit, editor]);

  useEffect(() => () => endDrag(false), [endDrag]);

  if (!editor || !target || !geometry) {
    return null;
  }

  const currentEm = dragEm ?? listIndentEmForNode(target.node);
  const dragging = dragEm !== null;

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const shell = shellRef.current;
    const scale = shell && shell.offsetWidth > 0 ? shell.getBoundingClientRect().width / shell.offsetWidth : 1;
    const startEm = listIndentEmForNode(target.node);
    dragRef.current = {
      pointerId: event.pointerId,
      target,
      startClientX: event.clientX,
      startEm,
      defaultEm: defaultListIndentEmForNode(target.node),
      scale,
      fontSizePx: geometry.fontSizePx,
      em: startEm,
    };
    setDragEm(startEm);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 取れなくても pointermove はボタン上で拾える。
    }
  };

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    const rawEm = drag.startEm + (event.clientX - drag.startClientX) / drag.scale / drag.fontSizePx;
    const em = snapListIndentEm(rawEm, drag.defaultEm);
    if (em === drag.em) {
      return;
    }
    drag.em = em;
    setDragEm(em);
    editor.view.dispatch(setListIndentPreview(editor.state.tr, { pos: drag.target.pos, indentEm: em }));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape" && dragRef.current) {
      event.preventDefault();
      endDrag(false);
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace" || event.key === "Home") {
      event.preventDefault();
      commit(target, null);
      return;
    }
    const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!direction) {
      return;
    }
    event.preventDefault();
    const step = event.shiftKey ? 1 : LIST_INDENT_EM_STEP;
    commit(target, clampListIndentEm(currentEm + direction * step));
  };

  const valueLabel = t("pageCanvas.listIndentValue", { value: formatEm(currentEm) });

  return (
    <div
      className="list-indent-slider"
      data-dragging={dragging ? "true" : undefined}
      style={{
        left: `${geometry.listLeft}px`,
        top: `${geometry.top}px`,
        height: `${geometry.height}px`,
        "--list-indent-text-left": `${geometry.textLeft - geometry.listLeft}px`,
        "--list-indent-track": `${TRACK_EM * geometry.fontSizePx}px`,
      } as CSSProperties}
    >
      <span className="list-indent-slider-track" aria-hidden="true" />
      <span className="list-indent-slider-guide" aria-hidden="true" />
      <button
        type="button"
        role="slider"
        className="list-indent-slider-knob"
        aria-label={t("pageCanvas.listIndent")}
        aria-valuemin={LIST_INDENT_EM_MIN}
        aria-valuemax={LIST_INDENT_EM_MAX}
        aria-valuenow={currentEm}
        aria-valuetext={valueLabel}
        title={dragging ? undefined : t("pageCanvas.listIndentHint")}
        onMouseDown={(event) => {
          // キャレットと本文の選択を動かさない (本文のフォーカスを保つ)。
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={() => endDrag(true)}
        onPointerCancel={() => endDrag(false)}
        onLostPointerCapture={() => endDrag(true)}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => {
          event.stopPropagation();
          commit(target, null);
        }}
        onKeyDown={handleKeyDown}
        onFocus={() => setKnobFocused(true)}
        onBlur={() => setKnobFocused(false)}
      />
      {dragging && <span className="list-indent-slider-value" aria-hidden="true">{valueLabel}</span>}
    </div>
  );
}

function clampListIndentEm(em: number): number {
  return Math.min(LIST_INDENT_EM_MAX, Math.max(LIST_INDENT_EM_MIN, em));
}

/** 0.25字刻みに丸め、既定の近くでは既定へ吸い寄せる。 */
export function snapListIndentEm(rawEm: number, defaultEm: number): number {
  const clamped = clampListIndentEm(rawEm);
  if (Math.abs(clamped - defaultEm) < SNAP_TO_DEFAULT_EM) {
    return defaultEm;
  }
  return Math.round(clamped / LIST_INDENT_EM_STEP) * LIST_INDENT_EM_STEP;
}

function formatEm(em: number): string {
  return String(Math.round(em * 100) / 100);
}
