export const WEBMCP_STATUS_EVENT = "sigma-studio:webmcp-status";
export type WebMcpRegistrationState = "loading" | "connected" | "partial" | "failed" | "unavailable";
export interface WebMcpUiStatus {
  state: WebMcpRegistrationState;
  registeredToolCount: number;
  failedToolNames: string[];
  operationCount: number;
  changedIds: string[];
  conflictTargetIds: string[];
  conflictTargets: string;
}
