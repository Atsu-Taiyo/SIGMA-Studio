import { describe, expect, it } from "vitest";

import { AI_PERMISSION_MODES, aiPermissionModeSettings, parseAiPermissionMode, resolveAiPermissionMode } from "./ai-permission-mode";

describe("AI permission mode", () => {
  it("defaults to asking for approval", () => {
    expect(resolveAiPermissionMode({})).toBe("ask");
    expect(resolveAiPermissionMode({ aiAutoApplyVerifiedProposals: false, aiReadOnlyMode: false })).toBe("ask");
  });

  it("lets read only win over automatic approval", () => {
    expect(resolveAiPermissionMode({ aiAutoApplyVerifiedProposals: true })).toBe("auto");
    expect(resolveAiPermissionMode({ aiReadOnlyMode: true, aiAutoApplyVerifiedProposals: true })).toBe("readOnly");
  });

  it("writes settings that resolve back to the chosen mode", () => {
    for (const mode of AI_PERMISSION_MODES) {
      expect(resolveAiPermissionMode(aiPermissionModeSettings(mode))).toBe(mode);
    }
    // 読み取りのみへ切り替えると、自動承認は切れる (戻すときに、黙って自動承認へ戻らない)。
    expect(aiPermissionModeSettings("readOnly")).toEqual({ aiReadOnlyMode: true, aiAutoApplyVerifiedProposals: false });
  });

  it("accepts only the three modes", () => {
    expect(AI_PERMISSION_MODES.map(parseAiPermissionMode)).toEqual(["readOnly", "ask", "auto"]);
    expect(["", "full", true, null].map(parseAiPermissionMode)).toEqual([null, null, null, null]);
  });
});
