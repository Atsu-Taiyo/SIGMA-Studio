import { describe, expect, it } from "vitest";
import { sessionReadOnlyExtensions } from "./session-read-only-extensions";
import { mergeEditorExtensionSets } from "../webmcp/webmcp-editor-extensions";
describe("session authority presentation", () => {
  it("overrides an AI guard reason only while host authority is read-only", () => {
    const ai = { textFlowEditPolicy: { guards: [], lockAll: { guardId: "ai", blockedMessage: "AI applying", presentation: { highlightedBlockClassName: "ai", readOnlyBlockClassName: "ai", characterClassName: "ai", atomClassName: "ai" }, highlight: false } } };
    const readOnly = sessionReadOnlyExtensions("共有権限を確認してください");
    expect(mergeEditorExtensionSets(ai, readOnly)?.textFlowEditPolicy?.lockAll?.blockedMessage).toBe("共有権限を確認してください");
    expect(mergeEditorExtensionSets(ai, undefined)?.textFlowEditPolicy?.lockAll?.blockedMessage).toBe("AI applying");
    expect(readOnly.auxiliarySurfaceExtensions?.textFlowEditPolicy?.lockAll?.guardId).toBe("document-session-read-only");
  });
});
