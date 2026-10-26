"use client";

import { createContext, useContext, useId, useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { getEffectiveZoom } from "@/features/rendering/adapters";
import { visibleBlockClientRect } from "./visible-block-rect";

/**
 * 紙面の操作の層。紙面の重なりは下から 本文 (`.page-flow`) → 図形 (`.page-overlay-layer`) → 操作
 * (この層) の順で、拡張が紙面に置く操作 (AI 提案の承認バーなど) は必ずこの層に描く。
 *
 * 本文フローの中に組まれる部品は `.page-flow` の重なりの文脈から出られない (z-index をいくら上げても
 * 図形の下)。そこで本文には同じ寸法の見えない場所取りだけを残し、操作そのものはこの層へ持ち上げて
 * 場所取りの位置に重ねる (`LiftedPageControl`)。
 *
 * この属性を持つ要素の上の押下は、紙面の図形の当たり判定に回さない (図形が下にあっても掴まない)。
 */
export const PAGE_CONTROL_ATTRIBUTE = "data-page-control";
export const PAGE_CONTROL_SELECTOR = `[${PAGE_CONTROL_ATTRIBUTE}]`;
/** 場所取りと持ち上げた本物を結ぶ id (両方に同じ値が付く)。 */
export const PAGE_CONTROL_ID_ATTRIBUTE = "data-page-control-id";

export const PageControlsLayerContext = createContext<HTMLElement | null>(null);

interface LiftedPlacement {
  left: number;
  top: number;
  width: number;
  clipPath: string;
}

function sameLiftedPlacement(a: LiftedPlacement | null, b: LiftedPlacement | null): boolean {
  return a === b || Boolean(a && b && a.left === b.left && a.top === b.top && a.width === b.width && a.clipPath === b.clipPath);
}

/**
 * 場所取りの箱を層の座標 (ズーム前) で追う。本文の組み直し・ページ割り・2 ページ並び・ズームのどれでも
 * 動くので、イベントを拾い集めずに描画のたびに測る (提案が出ている間だけ、要素 2 つの矩形)。
 */
function useLiftedPlacement(placeholder: HTMLElement | null, layer: HTMLElement | null): LiftedPlacement | null {
  const [placement, setPlacement] = useState<LiftedPlacement | null>(null);
  useLayoutEffect(() => {
    if (!placeholder || !layer) {
      return;
    }
    let frame = 0;
    const measure = () => {
      const box = placeholder.getBoundingClientRect();
      const origin = layer.getBoundingClientRect();
      const scale = getEffectiveZoom(layer);
      const visible = visibleBlockClientRect(placeholder);
      const next = box.width > 0 && scale > 0 && visible
        ? { left: (box.left - origin.left) / scale, top: (box.top - origin.top) / scale, width: box.width / scale,
          clipPath: `inset(${Math.max(0, visible.top - box.top) / scale}px ${Math.max(0, box.right - visible.right) / scale}px ${Math.max(0, box.bottom - visible.bottom) / scale}px ${Math.max(0, visible.left - box.left) / scale}px)` }
        : null;
      setPlacement((current) => sameLiftedPlacement(current, next) ? current : next);
      frame = window.requestAnimationFrame(measure);
    };
    measure();
    return () => window.cancelAnimationFrame(frame);
  }, [layer, placeholder]);
  return placeholder && layer ? placement : null;
}

/**
 * 本文フローの中の操作を紙面の操作の層へ持ち上げる。`render(true)` は本文に残す場所取り (同じ寸法で
 * 組むが、見せず触れない)、`render(false)` が層に描く本物。層が無い面 (紙面の外・テスト) では本文の
 * 中にそのまま描く。
 */
export function LiftedPageControl({
  className,
  attributes,
  render,
}: {
  className: string;
  /** 場所取りと本物の両方に付ける属性 (見た目の状態など)。 */
  attributes?: Record<string, string | undefined>;
  render: (placeholder: boolean) => ReactNode;
}) {
  const layer = useContext(PageControlsLayerContext);
  const controlId = useId();
  const [placeholder, setPlaceholder] = useState<HTMLDivElement | null>(null);
  const placement = useLiftedPlacement(placeholder, layer);
  if (!layer) {
    return (
      <div className={className} {...attributes} {...{ [PAGE_CONTROL_ATTRIBUTE]: "" }}>
        {render(false)}
      </div>
    );
  }
  return (
    <>
      <div
        ref={setPlaceholder}
        className={className}
        {...attributes}
        {...{ [PAGE_CONTROL_ID_ATTRIBUTE]: controlId }}
        data-page-control-placeholder=""
        aria-hidden="true"
        inert
      >
        {render(true)}
      </div>
      {createPortal(
        <div
          className={className}
          {...attributes}
          {...{ [PAGE_CONTROL_ATTRIBUTE]: "", [PAGE_CONTROL_ID_ATTRIBUTE]: controlId }}
          data-page-control-lifted=""
          hidden={!placement}
          style={placement
            ? { position: "absolute", left: `${placement.left}px`, top: `${placement.top}px`, width: `${placement.width}px`, clipPath: placement.clipPath }
            : undefined}
        >
          {render(false)}
        </div>,
        layer,
      )}
    </>
  );
}
