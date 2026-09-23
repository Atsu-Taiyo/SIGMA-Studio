import type { EditorExtensionContextValue } from "../editor-extension-context";

/** Host authority becomes a generic editing guard, independent of AI state. */
export function sessionReadOnlyExtensions(message: string): EditorExtensionContextValue {
  const policy: EditorExtensionContextValue = {
    textFlowEditPolicy: {
      guards: [],
      lockAll: {
        guardId: "document-session-read-only",
        blockedMessage: message,
        presentation: { highlightedBlockClassName: "", readOnlyBlockClassName: "", characterClassName: "", atomClassName: "" },
        highlight: false,
      },
    },
  };
  return { ...policy, auxiliarySurfaceExtensions: policy };
}
