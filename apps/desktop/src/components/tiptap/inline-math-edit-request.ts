import type { Editor } from "@tiptap/core";
import type { InlineMathLatexCommandTrigger } from "@/lib/inline-math-latex-commands";
import { resolveEditorInputTarget } from "./editor-input-target";
import { holdInlineMathTypeAhead, releaseInlineMathTypeAhead, type InlineMathTypeAheadKey } from "./inline-math-type-ahead";

export type InlineMathCursorPosition = "start" | "end";
interface MathEditOptions {
  cursorPosition: InlineMathCursorPosition;
  pendingLatexCommandTrigger?: InlineMathLatexCommandTrigger;
}
interface MathInput {
  id: () => string;
  position: () => number | undefined;
  edit: (options: MathEditOptions) => void;
}

const inputs = new WeakMap<Editor, Set<MathInput>>();
let cancelPending: (() => void) | undefined;

export function registerInlineMathInput(editor: Editor, input: MathInput): () => void {
  let entries = inputs.get(editor);
  if (!entries) inputs.set(editor, entries = new Set());
  entries.add(input);
  return () => { entries.delete(input); };
}

/** Resolve the formula's current position on each attempt, never a saved offset. */
export function requestInlineMathEdit(
  origin: Editor | (() => Editor | null),
  id: string,
  cursorPosition: InlineMathCursorPosition = "end",
  options: { pendingLatexCommandTrigger?: InlineMathLatexCommandTrigger; typeAhead?: readonly InlineMathTypeAheadKey[] } = {},
): void {
  if (!id || typeof window === "undefined") return;
  cancelPending?.();
  if (options.typeAhead) holdInlineMathTypeAhead(id, options.typeAhead);
  const ownerWindow = window;
  const timers: number[] = [];
  let frame = 0;
  const clear = () => {
    ownerWindow.cancelAnimationFrame(frame);
    timers.forEach(timer => ownerWindow.clearTimeout(timer));
    ownerWindow.removeEventListener("pointerdown", cancel, true);
    ownerWindow.removeEventListener("focusin", onFocus, true);
    if (cancelPending === cancel) cancelPending = undefined;
  };
  const cancel = () => { clear(); releaseInlineMathTypeAhead(id); };
  const getEditor = () => typeof origin === "function" ? origin() : origin;
  const onFocus = (event: FocusEvent) => {
    const editor = getEditor();
    if (editor && !editor.isDestroyed && event.target instanceof Node && !editor.view.dom.contains(event.target)) cancel();
  };
  const attempt = () => {
    if (cancelPending !== cancel) return;
    const editor = getEditor();
    if (!editor) return;
    if (editor.isDestroyed) { cancel(); return; }
    const source = [...(inputs.get(editor) ?? [])].find(input => input.id() === id);
    const position = source?.position();
    if (position === undefined) return;
    const target = resolveEditorInputTarget(editor, position);
    if (!target || editor.view.composing || target.editor.view.composing) return;
    const input = [...(inputs.get(target.editor) ?? [])].find(input => input.id() === id);
    if (!input) return;
    clear();
    input.edit({ cursorPosition, pendingLatexCommandTrigger: options.pendingLatexCommandTrigger });
  };
  cancelPending = cancel;
  ownerWindow.addEventListener("pointerdown", cancel, true);
  ownerWindow.addEventListener("focusin", onFocus, true);
  frame = ownerWindow.requestAnimationFrame(attempt);
  timers.push(ownerWindow.setTimeout(attempt, 50), ownerWindow.setTimeout(attempt, 250), ownerWindow.setTimeout(cancel, 300));
}
