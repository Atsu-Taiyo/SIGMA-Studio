import type { MathExpressionVariables } from "@/features/drawing";

export const GRAPH3D_ANIMATION_PREVIEW_EVENT = "sigma-studio:graph3d-animation-preview";

export interface Graph3DAnimationPreviewDetail {
  shapeId: string;
  overrides: MathExpressionVariables;
  playing: boolean;
}

export function dispatchGraph3DAnimationPreview(detail: Graph3DAnimationPreviewDetail): void {
  window.dispatchEvent(new CustomEvent<Graph3DAnimationPreviewDetail>(
    GRAPH3D_ANIMATION_PREVIEW_EVENT,
    { detail },
  ));
}

/**
 * 3D教材の設定パネルが開いているかどうかを、本文側のライブ窓へ伝えるための通知。
 *
 * パネルの state は EditorShell 側にあり、本文の図形は別のツリーにいる。props で降ろすと
 * spec が1目盛り動くたびにシェルごと再レンダーされるので、再生プレビューと同じ経路で渡す。
 */
export const GRAPH3D_SETTINGS_OPEN_EVENT = "sigma-studio:graph3d-settings-open";

export interface Graph3DSettingsOpenDetail {
  /** 設定パネルが開いている3D教材。閉じているときは null。 */
  shapeId: string | null;
}

export function dispatchGraph3DSettingsOpen(shapeId: string | null): void {
  window.dispatchEvent(new CustomEvent<Graph3DSettingsOpenDetail>(
    GRAPH3D_SETTINGS_OPEN_EVENT,
    { detail: { shapeId } },
  ));
}
