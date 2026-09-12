/**
 * グリップを掴んでブロックを動かす操作 (Notion のブロックエディタと同じ文法)。
 *
 * - 押して数 px 動いたらドラッグ。動かさず離せば従来どおりクリック (選択 + メニュー)。
 * - ドラッグ中は **本文を 1px も動かさない**。掴んだ単位の写し (ゴースト) がポインタに追従し、
 *   落とし先は線で示す。文書へ書くのは離した 1 回だけ (undo も 1 手)。
 * - pointermove ごとの仕事は「ゴーストの transform 1 回」と「ポインタの下の 1 単位の実測」だけ。
 *   React の再レンダーは落とし先が **変わったとき** に限る。
 * - 画面の端では紙面のスクローラーを自動で流す (図形のドラッグと同じ `drag-auto-scroll`)。
 *
 * ゴーストは React が管理しない専用の層 (`.page-block-drag-ghost-layer`) に直接置く。React の
 * 子として描くと、ポインタが動くたびに紙面ごと再レンダーする作りに戻ってしまう。
 */

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import type { SigmaDocument } from "@/features/document";
import {
  canDropUnits,
  isColumnEligibleUnitType,
  normalizeDragUnitIds,
  type BlockDragMoveRequest,
  type BlockDropTarget,
} from "@/lib/block-drag-move";

import {
  createDragAutoScroller,
  findDragAutoScrollScroller,
  getDragAutoScrollViewportBounds,
  panDragAutoScrollElement,
  type DragAutoScroller,
} from "../drag-auto-scroll";
import {
  createDragGhost,
  measureDragUnit,
  resolveDragHitAt,
  toCanvasPoint,
  type DragIndex,
  type DragUnitGeometry,
} from "./block-drag-dom";
import { resolveDropFromHit, sameDropResolution, type DragBox, type DropResolution } from "./block-drag-target";

/** ここまで動いたらドラッグ。クリックのつもりの手ぶれで掴まない程度。 */
const DRAG_START_THRESHOLD_PX = 4;
const AUTO_SCROLL_MAX_SPEED_PX_PER_SEC = 900;
const BODY_DRAGGING_CLASS = "page-block-dragging";

export interface BlockDragSession {
  unitIds: readonly string[];
  /**
   * 掴んだ元のブロックの箱。薄く見せるベールをアフォーダンス層に描く — 本文の要素に class を
   * 付ける方式は ProseMirror が属性を書き戻した瞬間に消える。
   */
  sources: readonly DragBox[];
  resolution: DropResolution | null;
}

export interface UseBlockDragOptions {
  getCanvas: () => HTMLElement | null;
  getGhostLayer: () => HTMLElement | null;
  getDocument: () => SigmaDocument;
  getIndex: () => DragIndex;
  /** グリップで選んである単位。掴んだ単位が含まれていればまとめて動かす。 */
  getSelectedUnitIds: () => readonly string[];
  /** 左ガター・段間から狙ったときに本文へ寄せるプローブの x (画面 px)。 */
  getColumnProbeClientX: (clientX: number, clientY: number) => number;
  onCommit: (request: BlockDragMoveRequest) => void;
  onSessionChange?: (active: boolean) => void;
}

interface Press {
  pointerId: number;
  handle: HTMLElement;
  unitId: string;
  startClientX: number;
  startClientY: number;
}

interface ActiveDrag {
  unitIds: string[];
  columnEligible: boolean;
  geometries: DragUnitGeometry[];
  ghost: HTMLElement;
  /** 掴んだ瞬間のポインタ (紙面 px)。ゴーストの平行移動の原点。 */
  origin: { x: number; y: number };
  autoScroller: DragAutoScroller;
  resolution: DropResolution | null;
  lastClient: { x: number; y: number };
  frame: number | null;
}

export function useBlockDrag(options: UseBlockDragOptions) {
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const pressRef = useRef<Press | null>(null);
  const dragRef = useRef<ActiveDrag | null>(null);
  const suppressClickRef = useRef(false);
  const [session, setSession] = useState<BlockDragSession | null>(null);

  const updateTarget = useCallback((clientX: number, clientY: number) => {
    const drag = dragRef.current;
    const canvas = optionsRef.current.getCanvas();
    if (!drag || !canvas) {
      return;
    }
    const document = optionsRef.current.getDocument();
    const index = optionsRef.current.getIndex();
    const hit = resolveDragHitAt(
      canvas,
      document,
      index,
      clientX,
      clientY,
      optionsRef.current.getColumnProbeClientX(clientX, clientY),
    );
    const canDrop = (target: BlockDropTarget) => canDropUnits(
      document,
      drag.unitIds,
      target,
    );
    const next = resolveDropFromHit(hit, toCanvasPoint(canvas, clientX, clientY), {
      columnEligible: drag.columnEligible,
      canDrop,
    });
    if (sameDropResolution(drag.resolution, next)) {
      return;
    }
    drag.resolution = next;
    setSession({ unitIds: drag.unitIds, sources: drag.geometries.map((geometry) => geometry.box), resolution: next });
  }, []);

  const moveGhost = useCallback((clientX: number, clientY: number) => {
    const drag = dragRef.current;
    const canvas = optionsRef.current.getCanvas();
    if (!drag || !canvas) {
      return;
    }
    const point = toCanvasPoint(canvas, clientX, clientY);
    drag.ghost.style.transform = `translate(${point.x - drag.origin.x}px, ${point.y - drag.origin.y}px)`;
  }, []);

  const finishDrag = useCallback((commit: boolean) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) {
      return;
    }
    if (drag.frame !== null) {
      window.cancelAnimationFrame(drag.frame);
    }
    drag.autoScroller.stop();
    const canvas = optionsRef.current.getCanvas();
    const resolution = drag.resolution;
    const cleanupVisuals = () => {
      drag.ghost.remove();
      if (canvas) delete canvas.dataset.blockDragging;
      window.document.body.classList.remove(BODY_DRAGGING_CLASS);
      setSession(null);
      optionsRef.current.onSessionChange?.(false);
    };
    if (commit && resolution && canvas) {
      optionsRef.current.onCommit({
        unitIds: drag.unitIds,
        target: resolution.target,
      });
      // pointerup と React/ProseMirror の確定描画の間をゴーストでつなぐ。
      window.requestAnimationFrame(() => window.requestAnimationFrame(cleanupVisuals));
    } else {
      cleanupVisuals();
    }
  }, []);

  const endPress = useCallback(() => {
    const press = pressRef.current;
    pressRef.current = null;
    if (!press) {
      return;
    }
    try {
      press.handle.releasePointerCapture(press.pointerId);
    } catch {
      // すでに外れている。
    }
  }, []);

  const startDrag = useCallback((press: Press, clientX: number, clientY: number) => {
    const { getCanvas, getGhostLayer, getDocument, getIndex, getSelectedUnitIds, onSessionChange } = optionsRef.current;
    const canvas = getCanvas();
    const ghostLayer = getGhostLayer();
    if (!canvas || !ghostLayer) {
      return;
    }
    const document = getDocument();
    const index = getIndex();
    const selected = getSelectedUnitIds();
    const unitIds = normalizeDragUnitIds(
      document.content,
      selected.includes(press.unitId) ? selected : [press.unitId],
    );
    if (unitIds.length === 0) {
      return;
    }
    const geometries = unitIds
      .map((id) => {
        const info = index.units.get(id);
        return info ? measureDragUnit(canvas, id, info.type, press.startClientY) : null;
      })
      .filter((geometry): geometry is DragUnitGeometry => geometry !== null);
    if (geometries.length === 0) {
      return;
    }

    const scroller = findDragAutoScrollScroller(canvas);
    const autoScroller = createDragAutoScroller({
      ownerWindow: window,
      getViewportBounds: () => (scroller
        ? getDragAutoScrollViewportBounds(scroller, window)
        : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth }),
      panBy: (_dx, dy) => (scroller ? panDragAutoScrollElement(scroller, 0, dy) : null),
      onPan: (panClientX, panClientY) => {
        moveGhost(panClientX, panClientY);
        updateTarget(panClientX, panClientY);
      },
      maxSpeedPxPerSec: AUTO_SCROLL_MAX_SPEED_PX_PER_SEC,
      horizontal: false,
    });

    const first = geometries[0].box;
    const ghost = createDragGhost(canvas.ownerDocument, geometries);
    ghost.style.left = `${first.left}px`;
    ghost.style.top = `${first.top}px`;
    ghost.style.width = `${Math.max(0, first.right - first.left)}px`;
    ghostLayer.append(ghost);
    canvas.dataset.blockDragging = "true";
    window.document.body.classList.add(BODY_DRAGGING_CLASS);

    dragRef.current = {
      unitIds,
      columnEligible: unitIds.every((id) => isColumnEligibleUnitType(index.units.get(id)?.type ?? "")),
      geometries,
      ghost,
      origin: toCanvasPoint(canvas, press.startClientX, press.startClientY),
      autoScroller,
      resolution: null,
      lastClient: { x: clientX, y: clientY },
      frame: null,
    };
    setSession({ unitIds, sources: geometries.map((geometry) => geometry.box), resolution: null });
    onSessionChange?.(true);
    moveGhost(clientX, clientY);
    updateTarget(clientX, clientY);
  }, [moveGhost, updateTarget]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLElement>, unitId: string) => {
    if (event.button !== 0 || pressRef.current || dragRef.current) {
      return;
    }
    const handle = event.currentTarget;
    const press: Press = {
      pointerId: event.pointerId,
      handle,
      unitId,
      startClientX: event.clientX,
      startClientY: event.clientY,
    };
    pressRef.current = press;
    suppressClickRef.current = false;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // capture が使えない環境でも、押している間はグリップの上に居る前提で続ける。
    }

    const onMove = (moveEvent: PointerEvent) => {
      if (pressRef.current !== press) {
        return;
      }
      const drag = dragRef.current;
      if (!drag) {
        const dx = moveEvent.clientX - press.startClientX;
        const dy = moveEvent.clientY - press.startClientY;
        if (Math.hypot(dx, dy) < DRAG_START_THRESHOLD_PX) {
          return;
        }
        startDrag(press, moveEvent.clientX, moveEvent.clientY);
        return;
      }
      drag.lastClient = { x: moveEvent.clientX, y: moveEvent.clientY };
      moveGhost(moveEvent.clientX, moveEvent.clientY);
      drag.autoScroller.update(moveEvent.clientX, moveEvent.clientY);
      if (drag.frame === null) {
        drag.frame = window.requestAnimationFrame(() => {
          const current = dragRef.current;
          if (current !== drag) {
            return;
          }
          drag.frame = null;
          updateTarget(drag.lastClient.x, drag.lastClient.y);
        });
      }
    };
    const detach = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      handle.removeEventListener("lostpointercapture", onLost);
      window.removeEventListener("keydown", onKeyDown, true);
    };
    const onUp = () => {
      if (pressRef.current !== press) {
        return;
      }
      detach();
      const wasDragging = dragRef.current !== null;
      endPress();
      if (wasDragging) {
        // 直後の click はドラッグの終わり。メニューを開かせない。
        suppressClickRef.current = true;
        finishDrag(true);
      }
    };
    const onCancel = () => {
      if (pressRef.current !== press) {
        return;
      }
      detach();
      const wasDragging = dragRef.current !== null;
      endPress();
      if (wasDragging) {
        suppressClickRef.current = true;
        finishDrag(false);
      }
    };
    const onLost = () => {
      // capture が外れたら (要素が消えた等) 掴んだままにはしない。
      if (pressRef.current === press && dragRef.current) {
        onCancel();
      }
    };
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape" && dragRef.current) {
        keyEvent.preventDefault();
        keyEvent.stopPropagation();
        onCancel();
      }
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
    handle.addEventListener("lostpointercapture", onLost);
    window.addEventListener("keydown", onKeyDown, true);
  }, [endPress, finishDrag, moveGhost, startDrag, updateTarget]);

  /** グリップの click が「ドラッグの終わり」だったら true を返して 1 回だけ食う。 */
  const consumeClickSuppression = useCallback((): boolean => {
    const suppressed = suppressClickRef.current;
    suppressClickRef.current = false;
    return suppressed;
  }, []);

  const isDragging = useCallback(() => dragRef.current !== null, []);

  useEffect(() => () => {
    endPress();
    finishDrag(false);
  }, [endPress, finishDrag]);

  return { session, handlePointerDown, consumeClickSuppression, isDragging };
}
