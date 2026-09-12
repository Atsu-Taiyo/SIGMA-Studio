/** MCP が書き出し、Electron の継続判定が読み取る run ごとの状態契約。 */
export interface VisualSessionStatusSnapshot {
  sessionId: string;
  targetId: string | null;
  operationCount: number;
  revision: number;
  lastReviewPassed: boolean | null;
  proposed: boolean;
  discarded: boolean;
  /** Semantic analysis of the figure from source image and problem statement. Min 20 chars. */
  sourceAnalysis?: string;
  /** Planned shape decomposition. Each item has kind and purpose describing the shape. */
  plannedShapes?: Array<{ kind: string; purpose: string }>;
}

export interface VisualSessionsStatusFile {
  version: 1;
  updatedAt: string;
  sessions: VisualSessionStatusSnapshot[];
}
