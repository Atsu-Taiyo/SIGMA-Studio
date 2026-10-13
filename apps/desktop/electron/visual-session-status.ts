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

/**
 * 読み手 (Electron の継続判定) と、書き出す前に今の内容を読む MCP の両方が使う。
 * 形式が違う・壊れている場合は null、個々の不正な項目は落とす。
 */
export function parseVisualSessionsStatusFile(value: unknown): VisualSessionsStatusFile | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.sessions)) {
    return null;
  }
  return {
    version: 1,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    sessions: value.sessions.filter(isVisualSessionStatusSnapshot),
  };
}

function isVisualSessionStatusSnapshot(value: unknown): value is VisualSessionStatusSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.sessionId === "string"
    && (typeof value.targetId === "string" || value.targetId === null)
    && typeof value.operationCount === "number"
    && Number.isFinite(value.operationCount)
    && typeof value.revision === "number"
    && Number.isFinite(value.revision)
    && (typeof value.lastReviewPassed === "boolean" || value.lastReviewPassed === null)
    && typeof value.proposed === "boolean"
    && typeof value.discarded === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
