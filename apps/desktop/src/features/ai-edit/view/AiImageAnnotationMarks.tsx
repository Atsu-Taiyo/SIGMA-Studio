"use client";
import { Fragment, useEffect, useLayoutEffect, useState, type CSSProperties } from "react";
import {
  getAiImageAnnotationMarkLayout,
  type AiImageAnnotation,
} from "@/lib/ai/ai-image-annotations";
import { useT } from "@/lib/i18n/react";
import styles from "./AiImageAnnotation.module.css";

export type AiImageAnnotationShape = Pick<AiImageAnnotation, "x" | "y" | "width" | "height">;

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * 要素のレイアウト上の大きさ。ダイアログの出現アニメーション (transform) の途中でも
 * 縮んだ値を拾わないよう、getBoundingClientRect ではなく offsetWidth/offsetHeight を読む。
 */
export function useElementLayoutSize(element: HTMLElement | null): { width: number; height: number } | null {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useIsomorphicLayoutEffect(() => {
    if (!element) {
      return;
    }
    const update = () => {
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      setSize((current) => (
        current && current.width === width && current.height === height ? current : { width, height }
      ));
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

/** 画像の元の縦横。添付が寸法を持たないとき (古い履歴など) だけ読み込んで測る。 */
export function useImageNaturalSize(
  src: string | null | undefined,
  width?: number | null,
  height?: number | null,
): { width: number; height: number } | null {
  const hasKnownSize = Boolean(width && height && width > 0 && height > 0);
  const [measured, setMeasured] = useState<{ src: string; width: number; height: number } | null>(null);
  useEffect(() => {
    if (hasKnownSize || !src) {
      return;
    }
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (!cancelled && image.naturalWidth > 0 && image.naturalHeight > 0) {
        setMeasured({ src, width: image.naturalWidth, height: image.naturalHeight });
      }
    };
    image.src = src;
    return () => {
      cancelled = true;
      image.onload = null;
    };
  }, [hasKnownSize, src]);
  if (hasKnownSize && width && height) {
    return { width, height };
  }
  return measured && measured.src === src ? { width: measured.width, height: measured.height } : null;
}

function badgeStyle(center: { x: number; y: number }, radius: number): CSSProperties {
  return {
    left: center.x,
    top: center.y,
    width: radius * 2,
    height: radius * 2,
    fontSize: Math.max(8, Math.round(radius * 1.05)),
  };
}

/**
 * 注記の番号付きの印。親の箱 (画像と同じ縦横比) いっぱいに重ね、合成画像と同じ配置
 * (`getAiImageAnnotationMarkLayout`) で描く。`onSelect` を渡すと番号を押せるボタンにする。
 */
export function AiImageAnnotationMarks({
  annotations,
  badgeRadius,
  activeId = null,
  draft = null,
  onSelect,
  onHover,
}: {
  annotations: readonly AiImageAnnotation[];
  badgeRadius: number;
  activeId?: string | null;
  /** 書きかけの注記。番号は次に付く番号で、点線で見せる。 */
  draft?: { shape: AiImageAnnotationShape; index: number } | null;
  onSelect?: (annotationId: string) => void;
  onHover?: (annotationId: string | null) => void;
}) {
  const t = useT("ai");
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const size = useElementLayoutSize(container);
  const interactive = Boolean(onSelect);
  const renderMark = (
    key: string,
    annotation: AiImageAnnotationShape,
    index: number,
    state: { active: boolean; draft: boolean; annotationId: string | null },
  ) => {
    if (!size || size.width <= 0 || size.height <= 0) {
      return null;
    }
    const layout = getAiImageAnnotationMarkLayout({ id: key, comment: "", ...annotation }, size, badgeRadius);
    const dataProps = {
      "data-active": state.active ? "true" : undefined,
      "data-draft": state.draft ? "true" : undefined,
    };
    const label = t("imageAnnotation.mark", { replace: { index: index + 1 } });
    const annotationId = state.annotationId;
    return (
      <Fragment key={key}>
        {layout.rect && (
          <span
            className={styles.region}
            {...dataProps}
            style={{ left: layout.rect.x, top: layout.rect.y, width: layout.rect.width, height: layout.rect.height }}
          />
        )}
        {layout.point && (
          <span
            className={styles.ring}
            {...dataProps}
            style={{
              left: layout.point.x,
              top: layout.point.y,
              width: layout.ringRadius * 2,
              height: layout.ringRadius * 2,
            }}
          />
        )}
        {interactive && annotationId ? (
          <button
            type="button"
            className={styles.badge}
            {...dataProps}
            style={badgeStyle(layout.badgeCenter, layout.badgeRadius)}
            aria-label={t("imageAnnotation.edit", { replace: { index: index + 1 } })}
            title={label}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onSelect?.(annotationId)}
            onMouseEnter={() => onHover?.(annotationId)}
            onMouseLeave={() => onHover?.(null)}
          >
            {index + 1}
          </button>
        ) : (
          <span className={styles.badge} {...dataProps} style={badgeStyle(layout.badgeCenter, layout.badgeRadius)}>
            {index + 1}
          </span>
        )}
      </Fragment>
    );
  };
  return (
    <div
      ref={setContainer}
      className={styles.marks}
      data-interactive={interactive ? "true" : undefined}
      aria-hidden={interactive ? undefined : true}
    >
      {annotations.map((annotation, index) => renderMark(annotation.id, annotation, index, {
        active: annotation.id === activeId,
        draft: false,
        annotationId: annotation.id,
      }))}
      {draft && renderMark("__draft", draft.shape, draft.index, { active: true, draft: true, annotationId: null })}
    </div>
  );
}

/**
 * `background-size: contain` で枠に収めた画像の上へ、印を同じ縮尺で重ねる。
 * 画像の縦横比から、枠の中で実際に画像が占める箱を割り出して、その箱に印を描く。
 */
export function AiImageAnnotationOverlay({
  annotations,
  naturalSize,
  containerAspectRatio,
  badgeRadius,
}: {
  annotations: readonly AiImageAnnotation[];
  naturalSize: { width: number; height: number } | null;
  /** 枠の 幅/高さ。 */
  containerAspectRatio: number;
  badgeRadius: number;
}) {
  if (annotations.length === 0 || !naturalSize) {
    return null;
  }
  const imageAspectRatio = naturalSize.width / Math.max(1, naturalSize.height);
  const box = imageAspectRatio >= containerAspectRatio
    ? { width: 100, height: (containerAspectRatio / imageAspectRatio) * 100 }
    : { width: (imageAspectRatio / containerAspectRatio) * 100, height: 100 };
  return (
    <span
      className={styles.overlayBox}
      style={{ width: `${box.width}%`, height: `${box.height}%` }}
    >
      <AiImageAnnotationMarks annotations={annotations} badgeRadius={badgeRadius} />
    </span>
  );
}
