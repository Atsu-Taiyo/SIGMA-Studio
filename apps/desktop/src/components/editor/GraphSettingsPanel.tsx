"use client";

import { X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { OverlayGraphSettings, type SelectedOverlayGraph } from "@/components/editor/EditorSettings";
import {
  GRAPH_SETTINGS_GRID_PANEL_WIDTH_PX,
  GRAPH_SETTINGS_PANEL_MARGIN_PX,
  GRAPH_SETTINGS_PANEL_WIDTH_PX,
  getGraphSettingsPanelPlacement,
  type GraphSettingsPanelOffset,
  type GraphSettingsPanelPlacement,
  type GraphSettingsPanelRect,
} from "@/components/editor/graph-settings-panel-placement";
import { IconButton } from "@/components/ui/Button";

import styles from "./GraphSettingsPanel.module.css";
import { useT } from "@/lib/i18n/react";

const FALLBACK_PANEL_HEIGHT_PX = 520;

function subscribeToHydration(): () => void {
  return () => undefined;
}

/**
 * パネルが覆ってはいけない矩形。
 *
 * `.graph-shape` の描画矩形は軸ラベルのぶん `.overlay-shape` の外へはみ出しうるし、
 * 逆に選択枠やハンドルは `.overlay-shape` 側にある。どちらか一方だけを見ると
 * 数 px の重なりが残るので、両方の和集合を避ける。
 */
function getGraphAnchorElements(shapeId: string): HTMLElement[] {
  if (typeof document === "undefined") {
    return [];
  }

  const escaped = CSS.escape(shapeId);
  // アンカーハンドル (`[data-overlay-anchor-handle]`) も同じ shape id を持つが、
  // 本文カラム全幅に伸びるので避ける対象に含めてはいけない。
  return [
    ...document.querySelectorAll<HTMLElement>(
      `.overlay-shape[data-overlay-shape-id="${escaped}"]`,
    ),
    ...document.querySelectorAll<HTMLElement>(`.graph-shape[id="${escaped}"]`),
  ];
}

function getGraphAnchorRect(shapeId: string): GraphSettingsPanelRect | null {
  const elements = getGraphAnchorElements(shapeId);

  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const element of elements) {
    const box = element.getBoundingClientRect();
    if (box.width <= 0 && box.height <= 0) {
      continue;
    }
    left = Math.min(left, box.left);
    top = Math.min(top, box.top);
    right = Math.max(right, box.right);
    bottom = Math.max(bottom, box.bottom);
  }

  if (!Number.isFinite(left) || !Number.isFinite(top)) {
    return null;
  }

  return { left, top, width: right - left, height: bottom - top };
}

/**
 * ドラッグ量を「実際に動いた分」に丸める。
 * 生のポインタ差分をそのまま溜めると、viewport 端で押し込んだぶんが次のドラッグの
 * 始めに空走りとして現れる。
 */
function clampManualOffset(
  shapeId: string,
  offset: GraphSettingsPanelOffset,
  panelWidth: number,
  panelMinWidth: number,
  panelHeight: number | undefined,
): GraphSettingsPanelOffset {
  const graphRect = getGraphAnchorRect(shapeId)
    ?? { left: GRAPH_SETTINGS_PANEL_MARGIN_PX, top: GRAPH_SETTINGS_PANEL_MARGIN_PX, width: 0, height: 0 };
  const panelSize = {
    width: panelWidth,
    minWidth: panelMinWidth,
    height: panelHeight || FALLBACK_PANEL_HEIGHT_PX,
  };
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const base = getGraphSettingsPanelPlacement(graphRect, panelSize, viewport, null);
  const moved = getGraphSettingsPanelPlacement(graphRect, panelSize, viewport, offset);

  return { dx: moved.left - base.left, dy: moved.top - base.top };
}

/**
 * グラフ設定の非モーダル浮遊パネル。
 *
 * `ModalFrame` を使わないのが本質: backdrop・`inert` による背面隔離・フォーカストラップは
 * 「グラフを見ながら編集する」「原点指定や塗りつぶし中にキャンバスを触る」と両立しない。
 * `role="dialog"` と `aria-label` は維持しつつ `aria-modal` は付けない。
 */
export function GraphSettingsPanel({
  selectedOverlayGraph,
  onClose,
}: {
  selectedOverlayGraph: SelectedOverlayGraph;
  onClose: () => void;
}) {
  const t = useT("shape");
  return (
    <GraphSettingsPanelFrame
      shapeId={selectedOverlayGraph.shapeId}
      title={t("graphPanel.title")}
      ariaLabel={t("graphPanel.title")}
      closeLabel={t("common.close")}
      onClose={onClose}
      width={GRAPH_SETTINGS_GRID_PANEL_WIDTH_PX}
      minWidth={GRAPH_SETTINGS_PANEL_WIDTH_PX}
    >
      <OverlayGraphSettings selectedOverlayGraph={selectedOverlayGraph} />
    </GraphSettingsPanelFrame>
  );
}

export function GraphSettingsPanelFrame({
  shapeId,
  title,
  ariaLabel,
  closeLabel,
  children,
  /** 既定はグラフ設定と同じ幅。要素が多いパネルだけ広げる。 */
  width = GRAPH_SETTINGS_PANEL_WIDTH_PX,
  /** 横に置けないときに縮んでよい下限。広いパネルはこれを下げてグラフを覆わずに済ませる。 */
  minWidth = width,
  onClose,
}: {
  shapeId: string;
  title: string;
  ariaLabel: string;
  closeLabel?: string;
  children: ReactNode;
  width?: number;
  minWidth?: number;
  onClose: () => void;
}) {
  const t = useT("shape");
  const resolvedCloseLabel = closeLabel ?? t("common.close");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const manualOffsetRef = useRef<GraphSettingsPanelOffset | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originOffset: GraphSettingsPanelOffset;
  } | null>(null);
  const placementFrameRef = useRef<number | null>(null);
  const [placement, setPlacement] = useState<GraphSettingsPanelPlacement | null>(null);
  // Modal.tsx の BodyPortal と同じ hydration ガード。body portal は水和後にしか張れない。
  const hydrated = useSyncExternalStore(subscribeToHydration, () => true, () => false);

  const updatePlacement = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    const panelBox = panelRef.current?.getBoundingClientRect();
    const graphRect = getGraphAnchorRect(shapeId)
      // グラフ要素がまだ描画されていないときは、左上寄りの安全な仮位置に置く。
      ?? { left: GRAPH_SETTINGS_PANEL_MARGIN_PX, top: GRAPH_SETTINGS_PANEL_MARGIN_PX, width: 0, height: 0 };

    const next = getGraphSettingsPanelPlacement(
      graphRect,
      {
        width,
        minWidth,
        height: panelBox?.height || FALLBACK_PANEL_HEIGHT_PX,
      },
      { width: window.innerWidth, height: window.innerHeight },
      manualOffsetRef.current,
    );

    setPlacement((current) => (
      current
        && current.left === next.left
        && current.top === next.top
        && current.width === next.width
        && current.maxHeight === next.maxHeight
        && current.side === next.side
        ? current
        : next
    ));
  }, [minWidth, shapeId, width]);

  // ズームは CSS transform なのでレイアウトサイズが変わらず ResizeObserver も
  // resize も発火しない。変化を起こしうる入力のあとに1フレームだけ遅らせて測り直す。
  const schedulePlacement = useCallback(() => {
    if (placementFrameRef.current !== null) {
      return;
    }
    placementFrameRef.current = requestAnimationFrame(() => {
      placementFrameRef.current = null;
      updatePlacement();
    });
  }, [updatePlacement]);

  useLayoutEffect(() => {
    updatePlacement();
    return () => {
      if (placementFrameRef.current !== null) {
        cancelAnimationFrame(placementFrameRef.current);
        placementFrameRef.current = null;
      }
    };
  }, [updatePlacement]);

  useEffect(() => {
    // body 末尾へ portal されるので、開いた時点でフォーカスを移さないと
    // キーボード操作では文書全体を tab しないと到達できない。
    // コンテキストメニューが閉じたあとにキャンバスがフォーカスを取り戻すため、
    // 次のフレームまで待ってから移す。
    const frame = requestAnimationFrame(() => {
      panelRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [shapeId]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    // グラフはページのスクロール・ズームで動く。カード側から追従する。
    // 非モーダルなのでパネルを開いたままグラフをドラッグ・リサイズできる。
    // ドラッグ中の毎フレーム再計算は避け、pointerup で置き直す。
    window.addEventListener("scroll", updatePlacement, true);
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("pointerup", updatePlacement, true);
    window.addEventListener("keyup", schedulePlacement, true);
    window.addEventListener("wheel", schedulePlacement, { capture: true, passive: true });
    return () => {
      window.removeEventListener("scroll", updatePlacement, true);
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("pointerup", updatePlacement, true);
      window.removeEventListener("keyup", schedulePlacement, true);
      window.removeEventListener("wheel", schedulePlacement, true);
    };
  }, [schedulePlacement, updatePlacement]);

  // 高さ・大きさが変わったら測り直す。対象は3つ:
  // パネル自身 (本文セクションの開閉)、グラフ (リサイズ)、ページキャンバス (ズーム)。
  // ズームは scroll / resize / pointerup のどれも発火しないので、キャンバスを見る必要がある。
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => updatePlacement());
    observer.observe(panel);
    for (const element of getGraphAnchorElements(shapeId)) {
      observer.observe(element);
      const canvas = element.closest(".overlay-canvas-editor");
      if (canvas) {
        observer.observe(canvas);
      }
    }

    return () => observer.disconnect();
  }, [shapeId, updatePlacement]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      // ポップオーバー等が先に Escape を処理していれば、そちらに任せる。
      if (event.target instanceof Element && event.target.closest("[data-toolbar-popover]")) {
        return;
      }
      onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleDragStart = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    // 閉じるボタン上の pointerdown までヘッダーが奪うと、クリックが成立しなくなる
    // (target はボタン内の svg になりうるので closest で見る)。
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button"))) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originOffset: manualOffsetRef.current ?? { dx: 0, dy: 0 },
    };
  }, []);

  const handleDragMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    manualOffsetRef.current = clampManualOffset(
      shapeId,
      {
        dx: drag.originOffset.dx + event.clientX - drag.startX,
        dy: drag.originOffset.dy + event.clientY - drag.startY,
      },
      width,
      minWidth,
      panelRef.current?.getBoundingClientRect().height,
    );
    updatePlacement();
  }, [minWidth, shapeId, updatePlacement, width]);

  const handleDragEnd = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    dragStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  if (!hydrated) {
    return null;
  }

  const panel = (
    <div
      ref={panelRef}
      className={styles.panel}
      role="dialog"
      aria-label={ariaLabel}
      data-graph-settings-panel=""
      data-non-modal-surface=""
      data-side={placement?.side ?? "right"}
      tabIndex={-1}
      style={{
        left: placement?.left ?? GRAPH_SETTINGS_PANEL_MARGIN_PX,
        top: placement?.top ?? GRAPH_SETTINGS_PANEL_MARGIN_PX,
        width: placement?.width ?? width,
        maxHeight: placement?.maxHeight,
        visibility: placement ? undefined : "hidden",
      }}
    >
      <header
        className={styles.header}
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerCancel={handleDragEnd}
      >
        <h2 className={styles.title}>{title}</h2>
        <IconButton label={resolvedCloseLabel} tone="ghost" size="sm" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </IconButton>
      </header>
      <div className={styles.body}>
        {children}
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}
