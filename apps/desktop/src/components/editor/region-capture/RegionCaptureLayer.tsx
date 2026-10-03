"use client";

import { Camera, Check, Download } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useT } from "@/lib/i18n/react";

import { useRegionCapture, type RegionCaptureActionContext } from "./use-region-capture";

export type { RegionCaptureActionContext } from "./use-region-capture";

/**
 * 操作バーに差し込まれた操作が、いま選ばれている範囲と撮影・閉じる操作を受け取る口。
 * 関数の呼び出しではなくコンテキストで渡すので、差し込む側は普通のコンポーネントとして書ける。
 */
export const RegionCaptureActionsContext = createContext<RegionCaptureActionContext | null>(null);

export function useRegionCaptureActions(): RegionCaptureActionContext {
  const context = useContext(RegionCaptureActionsContext);
  if (!context) {
    throw new Error("useRegionCaptureActions must be used inside the region capture action bar");
  }
  return context;
}

export interface RegionCaptureLayerProps {
  /** ドラッグを始められる領域 (スクロールする紙面) のセレクタ。範囲もこの内側に収める。 */
  hostSelector?: string;
  /**
   * 操作バーの右側に差し込む操作 (AI へ聞くなど)。汎用の撮影層は中身を知らない。
   * 差し込まれた要素は `useRegionCaptureActions()` で範囲と撮影を受け取る。
   */
  actions?: ReactNode;
}

/**
 * ⌥⇧ を押しながら紙面をドラッグして範囲を選び、その場でスクリーンショットを撮る層。
 *
 * - ポインタは window の capture 段階で奪う。本文・図形のどちらの編集面にも押下を渡さない。
 * - 範囲を選び終えると、枠のそばに操作バー (コピー / 保存 / 差し込まれた操作) が浮かぶ。
 * - 撮るときは枠とバーを隠し、2 フレーム待ってから描画済みの画面を取得する。
 * - デスクトップ版以外 (取得経路がない) では何も描かず、何も奪わない。
 *
 * 状態と入力は `useRegionCapture` が持ち、ここは描くだけ。
 */
export function RegionCaptureLayer({ hostSelector, actions }: RegionCaptureLayerProps) {
  const t = useT("editor");
  const capture = useRegionCapture({ hostSelector, measureKey: actions });
  const { available, phase, armed, status, barPosition, rootRef, barRef, readyRect, frameRect, busy, actionContext } = capture;

  if (!available || typeof document === "undefined") {
    return null;
  }

  const copyLabel = status === "copied" ? t("regionCapture.copied") : t("regionCapture.copy");
  const saveLabel = status === "saved" ? t("regionCapture.saved") : t("regionCapture.save");

  return createPortal(
    <div ref={rootRef} className="region-capture-root" data-region-capture-ui="true">
      {armed && phase.kind === "idle" && (
        <div className="region-capture-hint" role="status">{t("regionCapture.armed")}</div>
      )}
      {frameRect && (
        <div
          className="region-capture-frame"
          data-phase={phase.kind}
          style={{
            left: `${frameRect.left}px`,
            top: `${frameRect.top}px`,
            width: `${frameRect.width}px`,
            height: `${frameRect.height}px`,
          }}
        />
      )}
      {readyRect && (
        <div
          ref={barRef}
          className="region-capture-bar"
          role="toolbar"
          aria-label={t("regionCapture.toolbar")}
          // 実寸を測るまでは見えない場所に置いて、ちらつかせない。
          style={barPosition
            ? { left: `${barPosition.left}px`, top: `${barPosition.top}px` }
            : { left: 0, top: 0, visibility: "hidden" }}
          // 本文の選択やフォーカスを奪わない (入力欄はないので一律に止める)。
          onMouseDown={(event) => event.preventDefault()}
        >
          <button
            type="button"
            className="region-capture-button"
            data-state={status === "copied" ? "done" : undefined}
            title={copyLabel}
            aria-label={copyLabel}
            disabled={busy}
            onClick={() => { void capture.copy(); }}
          >
            {status === "copied" ? <Check size={16} aria-hidden="true" /> : <Camera size={16} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="region-capture-button"
            data-state={status === "saved" ? "done" : undefined}
            title={saveLabel}
            aria-label={saveLabel}
            disabled={busy}
            onClick={() => { void capture.save(); }}
          >
            {status === "saved" ? <Check size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
          </button>
          {actionContext && actions && (
            <RegionCaptureActionsContext.Provider value={actionContext}>
              <span className="region-capture-divider" aria-hidden="true" />
              {actions}
            </RegionCaptureActionsContext.Provider>
          )}
          {status === "failed" && (
            <span className="region-capture-error" role="alert">{t("regionCapture.failed")}</span>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
