"use client";

import { AlertTriangle, Check, Loader2, Save } from "lucide-react";

import { useEditorStore } from "@/features/editor-state";
import { countPerformanceEvent } from "@/lib/performance";

/**
 * 保存状態はエディタ画面の中でも一番よく変わる値 (打鍵のたびに idle→dirty→saving→saved と動く)
 * なので、EditorShell 本体では購読せず**この葉だけが購読する**。ここを親に戻すと、保存状態が
 * 変わるたびに画面全体が再描画される。
 */
export function DocumentTabSaveDot() {
  countPerformanceEvent("DocumentTabSaveDot.render");
  const saveState = useEditorStore((state) => state.saveState);
  return <i className={`document-tab-save-dot ${saveState}`} aria-hidden="true" />;
}

export function SaveStatusBadge() {
  // 保存状態の変化でどれだけ描画されるかを EditorShell と切り分けて見るためのカウンタ。
  countPerformanceEvent("SaveStatusBadge.render");
  const saveState = useEditorStore((state) => state.saveState);
  const statusMessage = useEditorStore((state) => state.statusMessage);
  return (
    <div className={`save-state ${saveState}`}>
      {saveState === "saving"
        ? <Loader2 className="save-state-spinner" size={14} />
        : saveState === "saved"
          ? <Check size={14} />
          : saveState === "warning"
            ? <AlertTriangle size={14} />
            : saveState === "error"
              ? <AlertTriangle size={14} />
              : <Save size={14} />}
      <span>{statusMessage}</span>
    </div>
  );
}
