/** Stable model-layer failures. User-facing copy is resolved by the rendering layer. */
export type Graph3DModelErrorCode =
  | "revolutionRadiusInvalid"
  | "solidSizeNotPositive"
  | "planeSizeNotPositive"
  | "inequalityOperatorInvalid"
  | "boundedSolidBuildFailed"
  | "boundedSolidRequiresLinearInequality"
  | "inequalityBoundaryPlaneFailed"
  | "revolutionAxisPlanesParallel"
  | "revolutionAxisParameterInvalid"
  | "rangeMaxNotGreaterThanMin"
  | "coordinateNotFinite"
  | "directionVectorZero"
  | "planePointsCollinear"
  | "planeNormalZero"
  | "planeFirstPointsEqual"
  | "planeBasisFailed"
  | "planeEquationNotLinear"
  | "planeFromEquationFailed"
  | "commonPartNeedsTwoObjects"
  | "commonPartObjectHasNoSurfaceOrInterior"
  | "planePositionFailed"
  | "commonPartSurfacesUnsupported"
  | "inequalityRequired"
  | "directionVectorLengthZero"
  | "solidScaleNotPositive"
  | "planeRequired"
  | "sceneBuildFailed";

export class Graph3DModelError extends Error {
  constructor(
    readonly code: Graph3DModelErrorCode,
    readonly params?: Record<string, string>,
  ) {
    super(code);
    this.name = "Graph3DModelError";
  }
}
