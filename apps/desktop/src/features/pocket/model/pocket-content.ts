import {
  EDITOR_CLIPBOARD_MIME,
  parseEditorClipboardHtml,
  parseEditorClipboardPayload,
  type EditorClipboardPayload,
} from "@/lib/editor-clipboard";

/** プレビューの見た目ではなく、コピー時の正本から転送先を決める。図形の種別は問わない。 */
export type PocketTransferTarget = "page" | "caret";

export function readPocketClipboardPayload(clip: Readonly<Record<string, string>>): EditorClipboardPayload | null {
  return parseEditorClipboardPayload(clip[EDITOR_CLIPBOARD_MIME] ?? "")
    ?? parseEditorClipboardHtml(clip["text/html"] ?? "");
}

export function getPocketTransferTarget(payload: EditorClipboardPayload | null): PocketTransferTarget {
  return payload?.kind === "overlayShapes" ? "page" : "caret";
}
