"use client";

import { AlertTriangle } from "lucide-react";

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

/**
 * 右上の状態表示。画面に出すのは **エラーと警告だけ** にする。
 *
 * 「保存しました」「教材を開きました」のような成功・経過の報告は、緑色の文字が常に
 * 視界の端で入れ替わり続けるだけで、次の操作には何も足さない (保存中・未保存はタブの点が
 * 示している)。文言そのものは読み上げのために見えない領域へ残す — 親の
 * `.save-state-wrap` が `aria-live="polite"` なので、支援技術には従来どおり伝わる。
 */
export function SaveStatusBadge({ errorsOnly = false }: { errorsOnly?: boolean }) {
  // 保存状態の変化でどれだけ描画されるかを EditorShell と切り分けて見るためのカウンタ。
  countPerformanceEvent("SaveStatusBadge.render");
  const saveState = useEditorStore((state) => state.saveState);
  const statusMessage = useEditorStore((state) => state.statusMessage);
  const problem = saveState === "error" || saveState === "warning";
  if (errorsOnly && !problem) return null;
  if (!problem) {
    return (
      <div className={`save-state ${saveState}`} data-quiet="true">
        <span>{statusMessage}</span>
      </div>
    );
  }
  return (
    <div className={`save-state ${saveState}`}>
      <AlertTriangle size={14} />
      <span>{statusMessage}</span>
    </div>
  );
}
