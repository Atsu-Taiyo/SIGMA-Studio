import type { MathExpressionVariables } from "@/features/drawing";

export const GRAPH_PARAMETER_PREVIEW_EVENT = "sigma-studio:graph-parameter-preview";
export const GRAPH_PARAMETERS_OPEN_EVENT = "sigma-studio:graph-parameters-open";
export interface GraphParameterPreviewDetail {
  shapeId: string;
  overrides: MathExpressionVariables;
  playing: boolean;
}
export function dispatchGraphParameterPreview(detail: GraphParameterPreviewDetail): void {
  window.dispatchEvent(new CustomEvent(GRAPH_PARAMETER_PREVIEW_EVENT, { detail }));
}
export function dispatchGraphParametersOpen(shapeId: string, open: boolean): void {
  window.dispatchEvent(new CustomEvent(GRAPH_PARAMETERS_OPEN_EVENT, { detail: { shapeId, open } }));
}
