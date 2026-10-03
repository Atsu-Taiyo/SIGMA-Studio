"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import {
  canCaptureRegion,
  captureRegionImage,
  copyCapturedImageToClipboard,
  saveCapturedImage,
  waitForNextPaint,
  type CapturedImage,
} from "./region-capture-client";
import { REGION_CAPTURE_ARM_EVENT } from "./region-capture-events";
import {
  isCaptureChord,
  isCaptureRectLargeEnough,
  placeCaptureActionBar,
  rectFromDrag,
  type CaptureBounds,
  type CapturePoint,
  type CaptureRect,
} from "./region-capture-model";

const READY_ATTRIBUTE = "data-region-capture-ready";
const CAPTURING_ATTRIBUTE = "data-region-capturing";
const OPEN_ATTRIBUTE = "data-region-capture-open";
/** 「コピーしました」などの結果を見せてから範囲を閉じるまでの時間。 */
const RESULT_LINGER_MS = 900;
const FAILURE_LINGER_MS = 2400;
const DEFAULT_HOST_SELECTOR = ".editor-canvas";
/** 紙面を覆うだけで中身を隠さない透明な幕の目印。ここを押しても、下の紙面から範囲を始められる。 */
const PASSTHROUGH_SELECTOR = "[data-region-capture-passthrough]";

export interface RegionCaptureActionContext {
  /** 選んだ範囲 (ウィンドウ内容の左上を原点にした CSS px)。 */
  rect: CaptureRect;
  /** 操作バーの左上。この近くに浮かぶパネルを出すときの基準にする。 */
  anchor: { left: number; top: number };
  /** 選択枠と操作バーを隠して範囲を撮る。撮れなかったときは null。 */
  capture: (options?: { maxDimension?: number }) => Promise<CapturedImage | null>;
  /** 撮影の失敗を操作バーに知らせる。 */
  reportFailure: () => void;
  /** 範囲と操作バーを閉じる。 */
  dismiss: () => void;
  /** 撮影の最中。重ねて押せないようにするために使う。 */
  busy: boolean;
}

export type RegionCapturePhase =
  | { kind: "idle" }
  | { kind: "dragging"; rect: CaptureRect }
  | { kind: "ready"; rect: CaptureRect };

export type RegionCaptureStatus = "idle" | "busy" | "copied" | "saved" | "failed";

interface DragSession {
  pointerId: number;
  start: CapturePoint;
  bounds: CaptureBounds;
}

const subscribeNever = () => () => undefined;
const getUnavailable = () => false;

function getHostBounds(host: Element): CaptureBounds {
  const box = host.getBoundingClientRect();
  // スクロールバーの上から範囲を始めたり、バーまで範囲を伸ばしたりしないよう、内容の領域だけを使う。
  return {
    left: box.left,
    top: box.top,
    right: box.left + host.clientWidth,
    bottom: box.top + host.clientHeight,
  };
}

function setReadyAttribute(on: boolean): void {
  if (on) {
    document.documentElement.setAttribute(READY_ATTRIBUTE, "true");
  } else {
    document.documentElement.removeAttribute(READY_ATTRIBUTE);
  }
}

/**
 * 範囲スクリーンショットの状態機械。window の capture 段階でポインタとキーを受け、
 * 範囲 (`phase`)・撮影の結果 (`status`)・操作バーの位置を持つ。描画は `RegionCaptureLayer`。
 *
 * `measureKey` は操作バーの幅が変わりうる入力 (差し込まれた操作の要素)。変わったら置き直す。
 */
export function useRegionCapture({
  hostSelector = DEFAULT_HOST_SELECTOR,
  measureKey,
}: {
  hostSelector?: string;
  measureKey?: unknown;
}) {
  // 取得経路の有無は実行環境で決まる。サーバー描画とハイドレーションでは常に false にして、
  // マウント後に確かめる (ポータルを使うので、描画結果を食い違わせない)。
  const available = useSyncExternalStore(subscribeNever, canCaptureRegion, getUnavailable);
  const [phase, setPhase] = useState<RegionCapturePhase>({ kind: "idle" });
  const [armed, setArmed] = useState(false);
  const [status, setStatus] = useState<RegionCaptureStatus>("idle");
  const [barPosition, setBarPosition] = useState<{ left: number; top: number } | null>(null);

  const phaseRef = useRef<RegionCapturePhase>(phase);
  const armedRef = useRef(false);
  const dragRef = useRef<DragSession | null>(null);
  const suppressClickRef = useRef(false);
  const chordHeldRef = useRef(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const lingerTimerRef = useRef<number | null>(null);
  const busyRef = useRef(false);

  const clearLingerTimer = useCallback(() => {
    if (lingerTimerRef.current !== null) {
      window.clearTimeout(lingerTimerRef.current);
      lingerTimerRef.current = null;
    }
  }, []);

  const syncReadyAttribute = useCallback(() => {
    setReadyAttribute(armedRef.current || chordHeldRef.current || dragRef.current !== null);
  }, []);

  const updatePhase = useCallback((next: RegionCapturePhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const dismiss = useCallback(() => {
    clearLingerTimer();
    dragRef.current = null;
    armedRef.current = false;
    setArmed(false);
    setStatus("idle");
    setBarPosition(null);
    updatePhase({ kind: "idle" });
    syncReadyAttribute();
  }, [clearLingerTimer, syncReadyAttribute, updatePhase]);

  useEffect(() => {
    if (!available) {
      return;
    }

    const cancelClickAfterDrag = () => {
      suppressClickRef.current = true;
      // 離した直後の click だけを止める。次のタスクで外し、後続の操作を巻き込まない。
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    };

    const finishDrag = (commit: boolean) => {
      const session = dragRef.current;
      dragRef.current = null;
      const current = phaseRef.current;
      if (commit && session && current.kind === "dragging" && isCaptureRectLargeEnough(current.rect)) {
        armedRef.current = false;
        setArmed(false);
        setStatus("idle");
        updatePhase({ kind: "ready", rect: current.rect });
      } else {
        updatePhase({ kind: "idle" });
      }
      cancelClickAfterDrag();
      syncReadyAttribute();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !event.isPrimary) {
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-region-capture-ui]")) {
        return;
      }
      const wantsCapture = armedRef.current || isCaptureChord(event);
      if (!wantsCapture) {
        // 範囲を出したまま、ほかの場所を普通に押したら閉じる (押下はそのまま通す)。
        if (phaseRef.current.kind === "ready" && !busyRef.current) {
          dismiss();
        }
        return;
      }
      // 紙面の上に敷かれた透明な幕 (AIのインライン面が開いている間の catcher など) は、
      // その下の紙面として扱う。幕に隠れていても、紙面の範囲は選べる。
      const host = target?.closest(hostSelector)
        ?? (target?.closest(PASSTHROUGH_SELECTOR) ? document.querySelector(hostSelector) : null);
      if (!host) {
        return;
      }
      const bounds = getHostBounds(host);
      if (event.clientX < bounds.left || event.clientX > bounds.right
        || event.clientY < bounds.top || event.clientY > bounds.bottom) {
        return;
      }
      if (busyRef.current) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      clearLingerTimer();
      setStatus("idle");
      setBarPosition(null);
      const start = { x: event.clientX, y: event.clientY };
      dragRef.current = { pointerId: event.pointerId, start, bounds };
      updatePhase({ kind: "dragging", rect: rectFromDrag(start, start, bounds) });
      syncReadyAttribute();
    };

    const onPointerMove = (event: PointerEvent) => {
      const session = dragRef.current;
      if (!session || event.pointerId !== session.pointerId) {
        return;
      }
      event.preventDefault();
      updatePhase({
        kind: "dragging",
        rect: rectFromDrag(session.start, { x: event.clientX, y: event.clientY }, session.bounds),
      });
    };

    const onPointerUp = (event: PointerEvent) => {
      const session = dragRef.current;
      if (!session || event.pointerId !== session.pointerId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      finishDrag(true);
    };

    const onPointerCancel = (event: PointerEvent) => {
      const session = dragRef.current;
      if (session && event.pointerId === session.pointerId) {
        finishDrag(false);
      }
    };

    // pointerdown を止めても、ブラウザによっては mousedown / selectstart / dragstart が出て
    // 本文のキャレットや文字選択・画像ドラッグが始まる。撮影のドラッグ中はまとめて止める。
    const swallowWhileDragging = (event: Event) => {
      if (dragRef.current) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    const onMouseDown = (event: MouseEvent) => {
      if (dragRef.current) {
        const target = event.target instanceof Element ? event.target : null;
        if (!target?.closest("[data-region-capture-ui]")) {
          event.preventDefault();
          event.stopPropagation();
        }
      }
    };

    const onClick = (event: MouseEvent) => {
      if (!suppressClickRef.current) {
        return;
      }
      // 操作バー自身の click は止めない (離した直後に押されても効くように)。
      if (event.target instanceof Element && event.target.closest("[data-region-capture-ui]")) {
        return;
      }
      suppressClickRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    };

    const onKeyChange = (event: KeyboardEvent) => {
      chordHeldRef.current = isCaptureChord(event);
      syncReadyAttribute();
      if (event.type === "keydown" && event.key === "Escape") {
        const current = phaseRef.current;
        if (current.kind !== "idle" || armedRef.current) {
          event.preventDefault();
          event.stopPropagation();
          if (current.kind === "dragging") {
            finishDrag(false);
          }
          if (!busyRef.current) {
            dismiss();
          }
        }
      }
    };

    const onWindowBlur = () => {
      chordHeldRef.current = false;
      syncReadyAttribute();
    };

    // 範囲を出したまま紙面が動くと、枠と中身がずれる。紙面が動いたら閉じる
    // (AIパネルの自動スクロールなど、紙面の外の動きでは閉じない)。
    const onViewportChange = () => {
      if (phaseRef.current.kind === "ready" && !busyRef.current) {
        dismiss();
      }
    };
    const onHostMotion = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-region-capture-ui]")) {
        return;
      }
      if (target instanceof Element ? target.closest(hostSelector) : target === document) {
        onViewportChange();
      }
    };

    const onArm = () => {
      armedRef.current = true;
      setArmed(true);
      setStatus("idle");
      setBarPosition(null);
      clearLingerTimer();
      updatePhase({ kind: "idle" });
      syncReadyAttribute();
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("selectstart", swallowWhileDragging, true);
    window.addEventListener("dragstart", swallowWhileDragging, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("keydown", onKeyChange, true);
    window.addEventListener("keyup", onKeyChange, true);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("scroll", onHostMotion, true);
    window.addEventListener("wheel", onHostMotion, { capture: true, passive: true });
    window.addEventListener("resize", onViewportChange);
    window.addEventListener(REGION_CAPTURE_ARM_EVENT, onArm);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("selectstart", swallowWhileDragging, true);
      window.removeEventListener("dragstart", swallowWhileDragging, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKeyChange, true);
      window.removeEventListener("keyup", onKeyChange, true);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("scroll", onHostMotion, true);
      window.removeEventListener("wheel", onHostMotion, true);
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener(REGION_CAPTURE_ARM_EVENT, onArm);
      clearLingerTimer();
      setReadyAttribute(false);
      document.documentElement.removeAttribute(CAPTURING_ATTRIBUTE);
    };
  }, [available, clearLingerTimer, dismiss, hostSelector, syncReadyAttribute, updatePhase]);

  const readyRect = phase.kind === "ready" ? phase.rect : null;
  const regionOpen = phase.kind !== "idle";

  // 範囲が出ているあいだは、本文の選択ポップオーバーなど別の浮遊 UI を退かせる (範囲の上に重なって紛らわしい)。
  useEffect(() => {
    if (!regionOpen) {
      return;
    }
    document.documentElement.setAttribute(OPEN_ATTRIBUTE, "true");
    return () => document.documentElement.removeAttribute(OPEN_ATTRIBUTE);
  }, [regionOpen]);

  // バーの実寸で置き直す。幅は差し込まれた操作で変わるので、描いた後に測る。
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!readyRect || !bar) {
      return;
    }
    const next = placeCaptureActionBar(
      readyRect,
      { width: bar.offsetWidth, height: bar.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setBarPosition((current) => (
      current && current.left === next.left && current.top === next.top ? current : next
    ));
  }, [readyRect, measureKey]);

  const capture = useCallback(async (options: { maxDimension?: number } = {}) => {
    const rect = phaseRef.current.kind === "ready" ? phaseRef.current.rect : null;
    if (!rect || busyRef.current) {
      return null;
    }
    busyRef.current = true;
    setStatus("busy");
    // 枠・バー・暗い幕は React の描き直しを待たずに隠す。選択バーなども同じ属性で隠す。
    const root = rootRef.current;
    if (root) {
      root.style.visibility = "hidden";
    }
    document.documentElement.setAttribute(CAPTURING_ATTRIBUTE, "true");
    try {
      await waitForNextPaint();
      return await captureRegionImage(rect, options);
    } catch {
      return null;
    } finally {
      document.documentElement.removeAttribute(CAPTURING_ATTRIBUTE);
      if (root) {
        root.style.visibility = "";
      }
      busyRef.current = false;
    }
  }, []);

  const showResult = useCallback((next: RegionCaptureStatus) => {
    setStatus(next);
    clearLingerTimer();
    lingerTimerRef.current = window.setTimeout(
      () => {
        lingerTimerRef.current = null;
        if (next === "failed") {
          setStatus("idle");
        } else {
          dismiss();
        }
      },
      next === "failed" ? FAILURE_LINGER_MS : RESULT_LINGER_MS,
    );
  }, [clearLingerTimer, dismiss]);

  const reportFailure = useCallback(() => showResult("failed"), [showResult]);

  const copy = useCallback(async () => {
    const image = await capture();
    if (image && await copyCapturedImageToClipboard(image)) {
      showResult("copied");
    } else {
      reportFailure();
    }
  }, [capture, reportFailure, showResult]);

  const save = useCallback(async () => {
    const image = await capture();
    if (!image) {
      reportFailure();
      return;
    }
    try {
      await saveCapturedImage(image);
      showResult("saved");
    } catch {
      reportFailure();
    }
  }, [capture, reportFailure, showResult]);

  const frameRect = phase.kind === "idle" ? null : phase.rect;
  const busy = status === "busy";
  const actionContext: RegionCaptureActionContext | null = readyRect && barPosition
    ? { rect: readyRect, anchor: barPosition, capture, reportFailure, dismiss, busy }
    : null;

  return {
    available,
    phase,
    armed,
    status,
    barPosition,
    rootRef,
    barRef,
    readyRect,
    frameRect,
    busy,
    actionContext,
    copy,
    save,
  };
}
