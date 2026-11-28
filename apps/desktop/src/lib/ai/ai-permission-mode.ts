// AIの権限。教材に対して AI にどこまで任せるかを、3 段階のうち 1 つで決める。
//
//   readOnly … 教材を読んで答えるだけ。編集案を作らせない。
//   ask      … 編集は提案になり、利用者が承認すると教材に入る (既定)。
//   auto     … 検証を通った提案を自動で承認する。
//
// 保存は 2 つの設定に分かれている: `aiReadOnlyMode` (読み取りのみ) と、以前からある
// `aiAutoApplyVerifiedProposals` (検証済み提案の自動承認)。段階はこの 2 つから決まり、
// 読み取りのみが優先する。どちらも端末ごとの設定で、アカウント間では同期しない。

export type AiPermissionMode = "readOnly" | "ask" | "auto";

export const AI_PERMISSION_MODES: readonly AiPermissionMode[] = ["readOnly", "ask", "auto"];

export const DEFAULT_AI_PERMISSION_MODE: AiPermissionMode = "ask";

export interface AiPermissionSettings {
  aiReadOnlyMode?: boolean;
  aiAutoApplyVerifiedProposals?: boolean;
}

export function resolveAiPermissionMode(settings: AiPermissionSettings): AiPermissionMode {
  if (settings.aiReadOnlyMode === true) return "readOnly";
  return settings.aiAutoApplyVerifiedProposals === true ? "auto" : "ask";
}

/** 段階を選んだときに書く 2 つの設定。 */
export function aiPermissionModeSettings(mode: AiPermissionMode): Required<AiPermissionSettings> {
  return { aiReadOnlyMode: mode === "readOnly", aiAutoApplyVerifiedProposals: mode === "auto" };
}

export function parseAiPermissionMode(value: unknown): AiPermissionMode | null {
  return value === "readOnly" || value === "ask" || value === "auto" ? value : null;
}
