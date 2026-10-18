"use client";

import { ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { Button, IconButton } from "@/components/ui/Button";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Inline, Stack } from "@/components/ui/layout";
import { useT } from "@/lib/i18n/react";
import {
  avatarCropPlacement,
  avatarCropZoom,
  avatarSliderFromZoom,
  avatarZoomFromSlider,
  avatarZoomRange,
  clampAvatarCrop,
  dragAvatarCrop,
  initialAvatarCrop,
  zoomAvatarCrop,
  type AvatarCrop,
} from "../model/avatar-crop";
import type { AvatarSource } from "./avatar-image";
import styles from "./avatar-crop.module.css";

/** ボタン・+/- キーで 1 回に変える拡大率の倍数。 */
const ZOOM_STEP = 1.25;
/** 矢印キーで動かす量 (枠の一辺に対する割合)。Shift で大きく動かす。 */
const KEY_MOVE = 0.04;
const KEY_MOVE_LARGE = 0.2;
const ZOOM_EPSILON = 1e-6;

/**
 * 選んだ画像のどこをアイコンにするかを決める。ドラッグ・矢印キーで位置を、スライダー・ホイール・
 * ピンチ・+/- キーで大きさを変える。枠の丸はアイコンの見え方で、外側は暗くして画像の続きを見せる。
 * 名前とアイコンのダイアログの上に重ねて開き、キャンセル・Esc では何も変えずに閉じる。
 */
export function CollaborationAvatarCropDialog({ source, initialCrop, onCancel, onApply }: {
  source: AvatarSource;
  /** 前に決めた範囲 (選び直さずに調整し直すとき)。無ければ真ん中の正方形から始める。 */
  initialCrop?: AvatarCrop;
  onCancel: () => void;
  onApply: (crop: AvatarCrop) => Promise<void> | void;
}) {
  const t = useT("chrome");
  const hintId = useId();
  const { width, height } = source;
  const image = useMemo(() => ({ width, height }), [width, height]);
  const [crop, setCrop] = useState(() => clampAvatarCrop(image, initialCrop ?? initialAvatarCrop(image)));
  const [dragging, setDragging] = useState(false);
  const [applying, setApplying] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; start: AvatarCrop } | null>(null);

  const range = avatarZoomRange(image);
  const zoom = avatarCropZoom(image, crop);
  const slider = avatarSliderFromZoom(image, zoom);
  const placement = avatarCropPlacement(image, crop);
  const imageStyle: CSSProperties = {
    left: `${placement.left * 100}%`,
    top: `${placement.top * 100}%`,
    width: `${placement.width * 100}%`,
    height: `${placement.height * 100}%`,
  };

  // ホイールとトラックパッドのピンチ (Chromium では ctrlKey 付きのホイール) は、ポインタの下を止めて拡大する。
  // React のホイールは passive で既定の動作 (ダイアログのスクロール・画面の拡大) を止められないので、直接受ける。
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = frameRef.current?.getBoundingClientRect();
      if (!rect || rect.width <= 0) return;
      const pixels = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
      const factor = Math.exp(-Math.max(-200, Math.min(200, pixels)) * (event.ctrlKey ? 0.01 : 0.002));
      const focus = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
      setCrop((current) => zoomAvatarCrop(image, current, avatarCropZoom(image, current) * factor, focus));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [image]);

  const zoomBy = (factor: number) => setCrop((current) => zoomAvatarCrop(image, current, avatarCropZoom(image, current) * factor));
  const moveBy = (dx: number, dy: number) => setCrop((current) => dragAvatarCrop(image, current, dx, dy));

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  const onStageKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const step = event.shiftKey ? KEY_MOVE_LARGE : KEY_MOVE;
    const action: Record<string, () => void> = {
      ArrowLeft: () => moveBy(-step, 0),
      ArrowRight: () => moveBy(step, 0),
      ArrowUp: () => moveBy(0, -step),
      ArrowDown: () => moveBy(0, step),
      "+": () => zoomBy(ZOOM_STEP),
      "=": () => zoomBy(ZOOM_STEP),
      "-": () => zoomBy(1 / ZOOM_STEP),
      _: () => zoomBy(1 / ZOOM_STEP),
    };
    const run = Object.hasOwn(action, event.key) ? action[event.key] : undefined;
    if (!run) return;
    event.preventDefault();
    run();
  };

  const apply = async () => {
    setApplying(true);
    try {
      await onApply(crop);
    } finally {
      setApplying(false);
    }
  };

  const zoomLabel = `${Math.round(zoom * 100)}%`;

  return (
    <ModalFrame open layer="nested" size="sm" onDismiss={onCancel}>
      <ModalHeader title={t("collaboration.profile.crop.title")} description={t("collaboration.profile.crop.description")} onClose={onCancel} />
      <ModalBody>
        <Stack gap="lg">
          <div
            ref={stageRef}
            className={styles.stage}
            data-dragging={dragging}
            data-testid="avatar-crop-stage"
            role="group"
            aria-label={t("collaboration.profile.crop.area")}
            aria-describedby={hintId}
            tabIndex={0}
            data-modal-initial-focus
            onKeyDown={onStageKeyDown}
            onPointerDown={(event) => {
              if (event.button !== 0 || applying) return;
              event.preventDefault();
              event.currentTarget.focus({ preventScroll: true });
              event.currentTarget.setPointerCapture?.(event.pointerId);
              drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, start: crop };
              setDragging(true);
            }}
            onPointerMove={(event) => {
              const current = drag.current;
              const rect = frameRef.current?.getBoundingClientRect();
              if (!current || current.pointerId !== event.pointerId || !rect || rect.width <= 0) return;
              setCrop(dragAvatarCrop(image, current.start, (event.clientX - current.x) / rect.width, (event.clientY - current.y) / rect.height));
            }}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
          >
            <div ref={frameRef} className={styles.frame} data-testid="avatar-crop-frame">
              {/* eslint-disable-next-line @next/next/no-img-element -- object URL of the chosen file; Next Image cannot load it. */}
              <img src={source.url} alt="" draggable={false} style={imageStyle} />
              <span className={styles.mask} aria-hidden="true" />
            </div>
            <span id={hintId} hidden>{t("collaboration.profile.crop.keyboardHint")}</span>
          </div>
          <Inline gap="xs" align="center">
            <IconButton
              label={t("collaboration.profile.crop.zoomOut")}
              tone="ghost"
              size="sm"
              disabled={applying || zoom <= range.min + ZOOM_EPSILON}
              onClick={() => zoomBy(1 / ZOOM_STEP)}
            >
              <ZoomOut size={16} aria-hidden="true" />
            </IconButton>
            <input
              className={styles.slider}
              type="range"
              min={0}
              max={1}
              // 矢印キーで 1 目盛り (約 1.02 倍)、PageUp/PageDown で 10 目盛り動く。
              step={0.01}
              value={slider}
              disabled={applying || range.max <= range.min}
              aria-label={t("collaboration.profile.crop.zoom")}
              aria-valuetext={zoomLabel}
              style={{ "--slider-fill": `${slider * 100}%` } as CSSProperties}
              onChange={(event) => {
                const next = avatarZoomFromSlider(image, Number(event.currentTarget.value));
                setCrop((current) => zoomAvatarCrop(image, current, next));
              }}
            />
            <IconButton
              label={t("collaboration.profile.crop.zoomIn")}
              tone="ghost"
              size="sm"
              disabled={applying || zoom >= range.max - ZOOM_EPSILON}
              onClick={() => zoomBy(ZOOM_STEP)}
            >
              <ZoomIn size={16} aria-hidden="true" />
            </IconButton>
          </Inline>
          <Inline gap="lg" align="center" justify="between">
            {/* 表示する大きさ (このダイアログ・ヘッダー) の見本。 */}
            <Inline gap="md" align="end" aria-hidden="true" data-testid="avatar-crop-previews">
              <span className={`${styles.preview} ${styles.preview_lg}`}>
                {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
                <img src={source.url} alt="" draggable={false} style={imageStyle} />
              </span>
              <span className={`${styles.preview} ${styles.preview_sm}`}>
                {/* eslint-disable-next-line @next/next/no-img-element -- see above */}
                <img src={source.url} alt="" draggable={false} style={imageStyle} />
              </span>
            </Inline>
            <Inline gap="sm" justify="end">
              <Button tone="ghost" disabled={applying} onClick={onCancel}>{t("collaboration.profile.cancel")}</Button>
              <Button tone="primary" disabled={applying} onClick={() => void apply()}>{t("collaboration.profile.crop.apply")}</Button>
            </Inline>
          </Inline>
        </Stack>
      </ModalBody>
    </ModalFrame>
  );
}
