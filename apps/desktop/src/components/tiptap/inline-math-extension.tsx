"use client";

import { mergeAttributes, Node, nodeInputRule, nodePasteRule, type Editor, type JSONContent } from "@tiptap/core";
import { chainCommands, deleteSelection, joinBackward, selectNodeBackward } from "@tiptap/pm/commands";
import { Fragment, Slice, type Node as ProseMirrorNode, type NodeType, type ResolvedPos } from "@tiptap/pm/model";
import { NodeSelection, Plugin, TextSelection, type EditorState, type Selection, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { NodeView } from "@tiptap/pm/view";
import type { NodeViewProps } from "@tiptap/react";
import * as React from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { ChangeEvent, KeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent } from "react";

import {
  createInlineMathBodyElement,
  createInlineMathFrameElement,
  inlineMathNodeClassName,
  inlineMathNodeDataAttributes,
  INLINE_MATH_NODE_VIEW_ATTRIBUTE,
  renderMathHtml,
  setInlineMathBodyTex,
} from "@/features/rendering/adapters";
import { InlineMathTexEditor } from "@/components/tiptap/inline-math-tex-editor";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import {
  createInlineMathClipboardPayload,
  createTiptapSliceClipboardPayload,
  readEditorClipboardPayload,
  writeEditorClipboardData,
} from "@/lib/editor-clipboard";
import { createId } from "@/lib/id";
import { countPerformanceEvent } from "@/lib/performance";
import { getInlineMathInputMode, useInlineMathInputMode } from "@/lib/inline-math-mode";
import { boxCommandToInlineNodes, parseTexBoxCommand } from "@/lib/tex-box-command";
import { inlineNodesToTiptapNodes } from "@/lib/tiptap-adapter";
import { MathEnvironmentValueProvider } from "@/features/rendering/adapters/react";
import { mathFieldDefaultMode } from "@/features/rendering/core";
import {
  DEFAULT_MATH_RENDER_ENVIRONMENT,
  type MathRenderEnvironment,
} from "@/lib/math-environment";
import { configureInlineMathLiveField, MATHLIVE_MATH_MODE_SPACE, type InlineMathLiveFieldElement } from "@/lib/mathlive-config";
import { normalizeMathLiveLineBreakTex, normalizeMathTextRuns } from "@/lib/math-tex";
import { applyTexBracketEditToTextarea, resolveTexBracketEdit, type TexBracketEdit } from "@/lib/tex-bracket-pairs";
import {
  getInlineMathLatexCommandTrigger,
  getInlineMathShiftDigit7Text,
  hasInlineMathLatexCommandCandidate,
  isInlineMathBackslashKey,
  isInlineMathLatexCommandCharacterKey,
  resolveInlineMathLatexCommand,
  shouldClearPendingInlineMathLatexCommand,
  shouldFlushPendingInlineMathLatexCommand,
  shouldStartInlineMathOnBackslash,
  type InlineMathKeyboardEventLike,
  type InlineMathLatexCommandTrigger,
} from "@/lib/inline-math-latex-commands";
export {
  getInlineMathLatexCommandTrigger,
  getInlineMathShiftDigit7Text,
  hasInlineMathLatexCommandCandidate,
  resolveInlineMathLatexCommand,
  shouldStartInlineMathOnBackslash,
} from "@/lib/inline-math-latex-commands";
export { renderMathHtml };
import {
  getMathfieldLatex,
  getMathKeyboardMathShortcut,
  handleMathKeyboardMathShortcut,
  isMathKeyboardMathModeShortcut,
  isMathKeyboardReturnToTextShortcut,
  type MathKeyboardMathShortcut,
  type MathKeyboardMathfieldLike,
} from "@/lib/math-keyboard-shortcuts";
import type { MathFractionSizing } from "@/features/document";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    mathInline: {
      insertMathInline: (attrs: { id: string; startEditing?: boolean; tex: string }) => ReturnType;
    };
  }
}

export const SELECT_INLINE_MATH_EVENT = "sigma-studio:select-inline-math";
export const EDIT_INLINE_MATH_EVENT = "sigma-studio:edit-inline-math";
export const UPDATE_INLINE_MATH_DRAFT_EVENT = "sigma-studio:update-inline-math-draft";

export interface MathNodeOptions {
  enableDelimiters: boolean;
  /**
   * 描画環境 (前文マクロ + 組版スタイル)。
   *
   * `renderHTML` (クリップボード・HTML シリアライズ) と素の DOM ノードビューは React の外で
   * 走るので context が使えない。ここで受け取らないと、その経路だけ前文マクロも組版スタイルも
   * 既定に落ちる。**1 つの値**で受け取るのは、片方だけ渡された状態を表現させないため。
   */
  mathEnvironment: MathRenderEnvironment;
  /**
   * 旧: 組版スタイルだけを受け取る口。`mathEnvironment.typesetStyle` に含まれるので
   * ノードビューは読まないが、呼び出し側の形を変えないために受け取りは残す。
   */
  mathFractionSizing?: MathFractionSizing | null;
}

const SINGLE_INLINE_MATH_TEXT = /^\$([^$]+)\$$/;
type PendingInlineMathEditRequest = {
  cursorPosition: InlineMathCursorPosition;
  pendingLatexCommandTrigger?: InlineMathLatexCommandTrigger;
};

const pendingInlineMathEditRequests = new Map<string, PendingInlineMathEditRequest>();
const INLINE_MATH_KEYBOARD_EDIT_WINDOW_MS = 1000;
const INLINE_MATH_DRAG_SELECTION_THRESHOLD_PX = 2;
const INLINE_MATH_LATEX_COMMAND_TIMEOUT_MS = 900;
export type InlineMathCursorPosition = "start" | "end";
let pendingInlineMathKeyboardEditIntent: {
  cursorPosition: InlineMathCursorPosition;
  until: number;
} | null = null;

type InlineMathSelectionState = {
  lastOffset?: number;
  position?: number;
  selectionIsCollapsed?: boolean;
};

type NormalizeInlineMathInputOptions = {
  forceLatexCommands?: boolean;
};

type NormalizeInlineMathLatexAliasOptions = {
  includeEnd?: boolean;
};

type PendingInlineMathLatexCommand = {
  startOffset: number;
  text: string;
  trigger: InlineMathLatexCommandTrigger;
};

type InlineMathTexFieldChange = {
  cursor: number;
  tex: string;
};

type DesktopAsciiInputSession = {
  restoreToken: Promise<string | null>;
  restored: boolean;
};

type InlineMathFieldElement = InlineMathLiveFieldElement & MathKeyboardMathfieldLike & {
  // MathLive の prompt API (クリックした placeholder に直接入る機能で使う)。
  getPromptRange?: (id: string) => [number, number] | null;
  getPrompts?: () => string[];
  readOnly: boolean;
  value: string;
  focus: (options?: FocusOptions) => void;
  lastOffset?: number;
  position?: number;
  selection?: {
    direction?: "backward" | "forward" | "none";
    ranges: Array<[number, number]>;
  } | [number, number] | number;
  selectionIsCollapsed?: boolean;
};

export function requestInlineMathEdit(
  id: string,
  cursorPosition: InlineMathCursorPosition = "end",
  options: { pendingLatexCommandTrigger?: InlineMathLatexCommandTrigger } = {},
) {
  if (!id || typeof window === "undefined") {
    return;
  }

  const request: PendingInlineMathEditRequest = {
    cursorPosition,
    pendingLatexCommandTrigger: options.pendingLatexCommandTrigger,
  };
  pendingInlineMathEditRequests.set(id, request);
  const dispatchEditRequest = () => {
    if (pendingInlineMathEditRequests.get(id) !== request) {
      return;
    }
    window.dispatchEvent(new CustomEvent(EDIT_INLINE_MATH_EVENT, { detail: { ...request, id } }));
  };
  window.requestAnimationFrame(dispatchEditRequest);
  window.setTimeout(dispatchEditRequest, 50);
  window.setTimeout(dispatchEditRequest, 250);
  window.setTimeout(() => pendingInlineMathEditRequests.delete(id), 1500);
}

export function updateInlineMathDraft(id: string, tex: string, cursor?: number) {
  if (!id || typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent(UPDATE_INLINE_MATH_DRAFT_EVENT, {
    detail: { cursor, id, tex },
  }));
}

const INLINE_MATH_CLICK_PLACEHOLDER_ID_PREFIX = "sigma-click-";

export function getInlineMathPlaceholderIndexAtPoint(
  preview: Element,
  clientX: number,
  clientY: number,
): number | null {
  const placeholders = Array.from(preview.querySelectorAll<HTMLElement>(".ML__prompt-atom"));
  const index = placeholders.findIndex((placeholder) => {
    const bounds = placeholder.getBoundingClientRect();
    return clientX >= bounds.left && clientX <= bounds.right &&
      clientY >= bounds.top && clientY <= bounds.bottom;
  });
  return index >= 0 ? index : null;
}

export function focusInlineMathPlaceholder(
  mathField: InlineMathFieldElement,
  placeholderIndex: number | null,
): boolean {
  if (placeholderIndex === null || !mathField.getPrompts || !mathField.getPromptRange) {
    return false;
  }

  try {
    const promptId = mathField.getPrompts()[placeholderIndex];
    const range = promptId === undefined ? null : mathField.getPromptRange(promptId);
    if (!range) {
      return false;
    }
    mathField.selection = range;
    return true;
  } catch {
    // MathLive can briefly reject selection writes while the custom element mounts.
    return false;
  }
}

export function indexAnonymousInlineMathPlaceholders(tex: string): string {
  let placeholderIndex = 0;
  return tex.replace(
    /\\placeholder(?:\[([^\]]*)\])?\{([^{}]*)\}/g,
    (match, id: string | undefined, body: string) => {
      const index = placeholderIndex;
      placeholderIndex += 1;
      return id
        ? match
        : `\\placeholder[${INLINE_MATH_CLICK_PLACEHOLDER_ID_PREFIX}${index}]{${body}}`;
    },
  );
}

export function removeInlineMathClickPlaceholderIds(tex: string): string {
  return tex.replace(
    new RegExp(`\\\\placeholder\\[${INLINE_MATH_CLICK_PLACEHOLDER_ID_PREFIX}\\d+\\]`, "g"),
    "\\placeholder",
  );
}

export function createMathHtmlElement(
  tex: string,
  displayMode = false,
  environment: MathRenderEnvironment,
): HTMLElement | string {
  // 数式 DOM の出典は 1 つ (`features/rendering/adapters/inline-math-frame.ts`)。
  return createInlineMathBodyElement(tex, { displayMode, environment });
}

export function shouldInsertInlineMathLineBreak(event: InlineMathKeyboardEventLike): boolean {
  return event.key === "Enter" && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing;
}

export function shouldCommitInlineMathOnKeyDown(event: InlineMathKeyboardEventLike): boolean {
  return (event.key === "Enter" || event.key === "Escape") &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.isComposing &&
    event.keyCode !== 229;
}

export function shouldCommitInlineMathTexOnKeyDown(event: InlineMathKeyboardEventLike): boolean {
  const isEscape = event.key === "Escape" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
  const isModifiedEnter = event.key === "Enter" &&
    !event.shiftKey &&
    !event.altKey &&
    (event.ctrlKey || event.metaKey);
  return (isEscape || isModifiedEnter) && !event.isComposing && event.keyCode !== 229;
}

export function normalizeInlineMathLineBreakInput(tex: string, options: NormalizeInlineMathInputOptions = {}): string {
  const normalizedAliases = normalizeInlineMathLatexAliases(tex, {
    includeEnd: options.forceLatexCommands,
  });
  const normalizedCommands = normalizeInlineMathLatexCommandSpacing(normalizedAliases, options);
  return normalizeMathTextRuns(normalizeMathLiveLineBreakTex(normalizedCommands));
}

export function normalizeInlineMathTexLiteralInput(tex: string): string {
  return normalizeMathTextRuns(normalizeMathLiveLineBreakTex(tex));
}

export function normalizeInlineMathLatexAliases(
  tex: string,
  options: NormalizeInlineMathLatexAliasOptions = {},
): string {
  return normalizeInlineMathLatexAliasesWithCursor(tex, tex.length, options).tex;
}

export function createInlineMathTexFromMathKeyboardShortcut(
  shortcut: MathKeyboardMathShortcut,
  selectedText = "",
): string {
  if (!shortcut.wrapsSelection || !selectedText) {
    return shortcut.tex;
  }

  return shortcut.tex.replace("#?", selectedText);
}

export function insertMathKeyboardShortcutInlineMathAtSelection(
  state: EditorState,
  mathInlineType: NodeType,
  shortcut: MathKeyboardMathShortcut,
  dispatch?: (tr: Transaction) => void,
): boolean {
  if (!canInsertInlineMathAtSelection(state.selection)) {
    return false;
  }

  const id = createId("m_inline");
  const selectedText = state.selection.empty
    ? ""
    : state.doc.textBetween(state.selection.from, state.selection.to, "");
  const node = mathInlineType.create({
    id,
    tex: createInlineMathTexFromMathKeyboardShortcut(shortcut, selectedText),
  });
  dispatch?.(state.tr.replaceSelectionWith(node).scrollIntoView());
  requestInlineMathEdit(id);
  return true;
}

export function requestDesktopAsciiInputSource(): DesktopAsciiInputSession | null {
  const inputSource = getDesktopBridge()?.inputSource;
  const switchToAscii = inputSource?.switchToAscii;
  if (!switchToAscii) {
    return null;
  }

  return {
    restored: false,
    restoreToken: switchToAscii()
      .then((result) => (result.ok && result.restoreToken ? result.restoreToken : null))
      .catch(() => null),
  };
}

export function restoreDesktopInputSource(session: DesktopAsciiInputSession | null) {
  if (!session || session.restored) {
    return;
  }

  session.restored = true;
  const restore = getDesktopBridge()?.inputSource?.restore;
  if (!restore) {
    return;
  }

  void session.restoreToken
    .then((restoreToken) => {
      if (!restoreToken) {
        return undefined;
      }
      return restore(restoreToken);
    })
    .catch(() => undefined);
}

/**
 * 数式ノードの表示は**素の DOM**、編集中の 1 つだけ React。
 *
 * 以前は全数式が React のノードビュー (portal) だった。1,277 個の portal は打鍵のたびに
 * 調停され、位置チェックと再描画が走る — 文書が長いほど 1 打鍵が重くなる原因のひとつ。
 * 表示に必要なのは `renderMathHtml` が返す静的 markup だけなので、非編集時は React を通さない。
 *
 * DOM は `features/rendering/adapters/inline-math-frame.ts` が唯一の出典で、PDF・印刷・viewer の
 * 静的レンダラと同じ関数から作る (`inline-math-node-view.test.ts` が outerHTML の一致を固定)。
 */
export class InlineMathNodeView implements NodeView {
  readonly dom: HTMLElement;

  private node: ProseMirrorNode;
  private decorations: readonly Decoration[];
  private readonly editor: Editor;
  private readonly getPos: () => number | undefined;
  private readonly mathEnvironment: MathRenderEnvironment;

  private id: string;
  private tex: string;
  private body: HTMLElement | null = null;

  private editing = false;
  /**
   * MathLive が保持する編集中の値。レイアウトは常に `body` の静的 markup が決めるため、
   * 入力のたびに同じ値を静的レンダラへも渡す。SigmaDoc への確定は従来どおり commit 時だけ。
   */
  private editingTex: string | null = null;
  /** ProseMirror がこのノードを選択中か (数式パネルへの通知が要るかの判定に使う)。 */
  private selected = false;
  /** AI 編集ロックが今この数式に掛かっているか (装飾から読む)。 */
  private editGuarded: boolean;
  private fieldRoot: Root | null = null;
  private fieldContainer: HTMLElement | null = null;
  private initialCursorPosition: InlineMathCursorPosition = "end";
  /** クリックされた placeholder の序数。押した位置から編集を始めるときだけ入る。 */
  private initialPlaceholderIndex: number | null = null;
  private initialLatexCommandTrigger: InlineMathLatexCommandTrigger | null = null;
  private inputSourceSession: DesktopAsciiInputSession | null = null;
  private pendingEditFrame = 0;
  private readonly disposers: Array<() => void> = [];

  constructor(
    props: {
      decorations: readonly Decoration[];
      editor: Editor;
      getPos: () => number | undefined;
      node: ProseMirrorNode;
    },
    options: { mathEnvironment: MathRenderEnvironment },
  ) {
    countPerformanceEvent("InlineMathNodeView.mount");
    this.node = props.node;
    this.decorations = props.decorations ?? [];
    this.editGuarded = hasInlineMathEditGuardDecoration(this.decorations);
    this.editor = props.editor;
    this.getPos = props.getPos;
    this.mathEnvironment = options.mathEnvironment;
    this.id = String(props.node.attrs.id ?? "");
    this.tex = String(props.node.attrs.tex ?? "");

    // `text-selected` と編集ガードの属性は ProseMirror が装飾としてこの要素に付けるので、
    // ここでは付けない (二重管理にすると付け外しの順序で食い違う)。
    this.dom = createInlineMathFrameElement(this.tex, {
      id: this.id,
      environment: this.mathEnvironment,
    });
    this.dom.contentEditable = "false";
    // 「編集面のノードビューである」印。囲みランの採寸が「1 つの mark span が何個の文書ターゲットを
    // 代表しているか」を数えるのに使う (`boxed-text-run-height.ts`)。静的レンダラの数式には付かない
    // ので、印刷側は従来どおり span 全体を 1 つとして測る。React ノードビューだった頃に Tiptap が
    // 被せていた `.react-renderer` の代わり。
    this.dom.setAttribute(INLINE_MATH_NODE_VIEW_ATTRIBUTE, "");
    this.body = this.dom.firstElementChild as HTMLElement | null;

    this.dom.addEventListener("mousedown", this.handleMouseDown);
    this.disposers.push(() => this.dom.removeEventListener("mousedown", this.handleMouseDown));

    if (typeof window !== "undefined") {
      window.addEventListener(EDIT_INLINE_MATH_EVENT, this.handleEditRequest);
      window.addEventListener(UPDATE_INLINE_MATH_DRAFT_EVENT, this.handleDraftUpdate);
      this.disposers.push(() => {
        window.removeEventListener(EDIT_INLINE_MATH_EVENT, this.handleEditRequest);
        window.removeEventListener(UPDATE_INLINE_MATH_DRAFT_EVENT, this.handleDraftUpdate);
      });

      // 「作られる前に飛んできた編集依頼」を拾う (貼り付け直後や AI 適用直後の昇格)。
      const pending = this.id ? pendingInlineMathEditRequests.get(this.id) : undefined;
      if (pending) {
        this.scheduleEditFrame(() => {
          this.beginEditing(this.tex, pending.cursorPosition ?? "end", {
            pendingLatexCommandTrigger: pending.pendingLatexCommandTrigger,
          });
        });
      }
    }
  }

  update(node: ProseMirrorNode, decorations: readonly Decoration[]): boolean {
    if (node.type !== this.node.type) {
      return false;
    }
    this.node = node;
    this.decorations = decorations;
    // ロックは打鍵と無関係に付いたり外れたりする。編集中の入力欄はロック状態を props で
    // 受け取っているので、tex が変わらなくても掛け直す必要がある (旧 React 版は装飾の
    // 変化でそのまま再描画されていた)。書き込みそのものは `filterTransaction` が別に
    // 止めるので、ここが遅れても文書は守られる — 見た目だけがロックを裏切る。
    const nextEditGuarded = hasInlineMathEditGuardDecoration(decorations);
    const editGuardChanged = nextEditGuarded !== this.editGuarded;
    this.editGuarded = nextEditGuarded;
    const nextId = String(node.attrs.id ?? "");
    const nextTex = String(node.attrs.tex ?? "");
    if (nextId !== this.id) {
      this.id = nextId;
      if (nextId) {
        this.dom.setAttribute("data-id", nextId);
      } else {
        this.dom.removeAttribute("data-id");
      }
    }
    if (nextTex === this.tex) {
      // ここが本題: 打鍵で文書が作り直されても、tex が同じ数式は DOM を一切触らない。
      // 例外はロックの付け外し (入力欄が props で受け取っているので描き直しが要る)。
      if (editGuardChanged && this.editing) {
        this.renderEditingField();
      }
      return true;
    }

    countPerformanceEvent("InlineMathNodeView.rerender");
    this.tex = nextTex;
    this.dom.setAttribute("data-tex", nextTex);
    this.dom.setAttribute("title", nextTex);
    if (this.editing) {
      this.editingTex = nextTex;
      this.renderEditingField();
    } else if (this.body) {
      setInlineMathBodyTex(this.body, nextTex, { environment: this.mathEnvironment });
    }
    if (this.selected) {
      // 選択中の数式が undo/redo や AI 適用で書き変わったら、数式パネルへ知らせ直す。
      // 知らせないとパネルは古い TeX を編集し続ける (旧 React 版は tex を deps に持っていた)。
      this.dispatchSelection(nextTex);
    }
    return true;
  }

  selectNode(): void {
    this.selected = true;
    this.dom.classList.add("selected");
    const keyboardEditIntent = consumeInlineMathKeyboardEditIntent();
    if (keyboardEditIntent && typeof window !== "undefined") {
      this.scheduleEditFrame(() => {
        this.beginEditing(this.tex, keyboardEditIntent.cursorPosition);
      });
      return;
    }
    this.dispatchSelection();
  }

  deselectNode(): void {
    this.selected = false;
    this.dom.classList.remove("selected");
  }

  /** 編集中はキーもポインタも `<math-field>` のもの。ProseMirror には渡さない。 */
  stopEvent(): boolean {
    return this.editing;
  }

  /** atom なので中身は ProseMirror の管理外 (innerHTML の差し替えを変更と見なされると壊れる)。 */
  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    // 先に編集フラグを落とす。ノードが消えた後 (= PM が破棄した後) に走る `finishEditing`
    // — 枠コマンドへの変換がまさにそれ — が、外れた DOM へ数式を描き直さないように。
    this.editing = false;
    if (this.pendingEditFrame && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.pendingEditFrame);
      this.pendingEditFrame = 0;
    }
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers.length = 0;
    this.unmountEditingField();
    restoreDesktopInputSource(this.inputSourceSession);
    this.inputSourceSession = null;
  }



  /**
   * 次のフレームで編集を始める予約は**常に 1 本**。
   *
   * 予約は 2 箇所 (作られた直後の依頼の拾い上げ / キーボードでの選択) から来る。同じフレームで
   * 両方が走ると、上書きされた方は `destroy()` でも止められず、破棄済みのビューで編集を始めて
   * IME の入力ソースを取ったまま返さなくなる。
   */
  private scheduleEditFrame(run: () => void): void {
    if (typeof window === "undefined") {
      return;
    }
    if (this.pendingEditFrame) {
      window.cancelAnimationFrame(this.pendingEditFrame);
    }
    this.pendingEditFrame = window.requestAnimationFrame(() => {
      this.pendingEditFrame = 0;
      run();
    });
  }

  private readonly handleEditRequest = (event: Event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (!this.id || detail?.id !== this.id) {
      return;
    }
    this.beginEditing(this.tex, normalizeInlineMathCursorPosition(detail.cursorPosition) ?? "end", {
      pendingLatexCommandTrigger: normalizeInlineMathLatexCommandTrigger(detail.pendingLatexCommandTrigger) ?? null,
    });
  };

  private readonly handleDraftUpdate = (event: Event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (!this.id || detail?.id !== this.id || typeof detail.tex !== "string") {
      return;
    }
    this.updateTexAttribute(detail.tex);
    this.dispatchSelection(detail.tex, typeof detail.cursor === "number" ? detail.cursor : detail.tex.length);
  };

  private updateTexAttribute(nextTex: string): void {
    if (updateInlineMathNodeTex(this.editor, this.id, nextTex)) {
      return;
    }
    const position = this.getPos();
    if (typeof position !== "number" || this.editor.isDestroyed) {
      return;
    }
    this.editor.view.dispatch(this.editor.state.tr.setNodeMarkup(position, undefined, {
      ...this.node.attrs,
      tex: nextTex,
    }));
  }

  private dispatchSelection(nextTex = this.tex, cursor = nextTex.length): void {
    if (typeof window === "undefined") {
      return;
    }
    window.dispatchEvent(new CustomEvent(SELECT_INLINE_MATH_EVENT, {
      detail: {
        id: this.id,
        tex: nextTex,
        cursor: clampInlineMathTexCursor(cursor, nextTex),
        blockId: findInlineMathBlockId(this.editor, this.id),
        updateTex: (tex: string) => this.updateTexAttribute(tex),
      },
    }));
  }

  private beginEditing(
    nextTex = this.tex,
    cursorPosition: InlineMathCursorPosition = "end",
    options: {
      pendingLatexCommandTrigger?: InlineMathLatexCommandTrigger | null;
      placeholderIndex?: number | null;
    } = {},
  ): void {
    if (this.editGuarded) {
      return;
    }
    pendingInlineMathEditRequests.delete(this.id);
    if (!this.editing) {
      this.editing = true;
      this.inputSourceSession = requestDesktopAsciiInputSource();
    }
    this.editingTex = nextTex;
    this.initialCursorPosition = cursorPosition;
    this.initialPlaceholderIndex = options.placeholderIndex ?? null;
    this.initialLatexCommandTrigger = options.pendingLatexCommandTrigger ?? null;
    this.renderEditingField();
    this.dispatchSelection(nextTex, cursorPosition === "start" ? 0 : nextTex.length);
  }

  private finishEditing(): void {
    if (!this.editing) {
      return;
    }
    this.editing = false;
    this.editingTex = null;
    this.dom.classList.remove("editing");
    restoreDesktopInputSource(this.inputSourceSession);
    this.inputSourceSession = null;
    this.unmountEditingField();
    this.renderStaticBody();
  }

  private renderStaticBody(): void {
    if (this.body?.isConnected) {
      this.body.removeAttribute("aria-hidden");
      setInlineMathBodyTex(this.body, this.tex, { environment: this.mathEnvironment });
      return;
    }
    const body = createInlineMathBodyElement(this.tex, { environment: this.mathEnvironment });
    if (typeof body === "string") {
      this.dom.textContent = body;
      this.body = null;
      return;
    }
    this.body = body;
    this.dom.append(body);
  }

  /** 編集中の 1 ノードだけ React を建てる (数式入力欄は MathLive/TeX 両対応の既存 UI)。 */
  private renderEditingField(): void {
    if (typeof document === "undefined") {
      return;
    }
    this.dom.classList.add("editing");
    const editingTex = this.editingTex ?? this.tex;
    // PDF と同じ静的 markup を、編集中も唯一のレイアウト箱として残す。MathLive は
    // absolute overlay なので、Shadow DOM の内部寸法やキャレット層が行高・折返し・改ページを
    // 変えることはない。`aria-hidden` は入力欄との二重読み上げを防ぐため。
    if (!this.body?.isConnected) {
      const body = createInlineMathBodyElement(editingTex, { environment: this.mathEnvironment });
      if (typeof body !== "string") {
        this.body = body;
        this.dom.prepend(body);
      }
    }
    if (this.body) {
      setInlineMathBodyTex(this.body, editingTex, { environment: this.mathEnvironment });
      this.body.setAttribute("aria-hidden", "true");
    }
    if (!this.fieldContainer) {
      this.fieldContainer = document.createElement("span");
      // 入力欄を静的レイアウト箱へ重ねるための層。通常フローへ戻すと編集中だけ行高が変わる。
      this.fieldContainer.className = "inline-math-field-host";
      this.dom.append(this.fieldContainer);
    }
    this.fieldRoot ??= createRoot(this.fieldContainer);
    // 同期でマウントする。`createRoot().render()` は既定だと次のフレームまで反映されず、
    // 「編集を開いて即キー入力」(外部イベントで開く経路) がまだ存在しない入力欄を素通りして
    // 本文に届いてしまう。React ツリーの外から呼ぶので `flushSync` を使ってよい。
    // このノードビューは React ツリーの外に自前の root を作るので、描画環境の context が
    // 届かない。ここで張り直しておかないと、TeX ダイアログのライブプレビューだけが
    // 既定環境で描かれ、前文マクロを使った数式が本文と食い違う。
    flushSync(() => this.fieldRoot?.render(
      <MathEnvironmentValueProvider environment={this.mathEnvironment}>
      <InlineMathField
        locked={this.editGuarded}
        tex={editingTex}
        mathEnvironment={this.mathEnvironment}
        initialCursorPosition={this.initialCursorPosition}
        initialLatexCommandTrigger={this.initialLatexCommandTrigger}
        initialPlaceholderIndex={this.initialPlaceholderIndex}
        onInput={(nextTex, cursor) => this.handleEditingInput(nextTex, cursor)}
        onCancel={() => this.finishEditing()}
        onCommit={(nextTex) => this.commitMath(nextTex)}
        onDeleteBackwardFromStart={(nextTex) => this.commitMathAndDeleteBackwardFromStart(nextTex)}
        onReturnToTextAfter={(nextTex) => this.commitMathAndReturnToTextAfter(nextTex)}
        onReturnToTextBefore={(nextTex) => this.commitMathAndReturnToTextBefore(nextTex)}
        onPointerDown={stopInlineMathEventPropagation}
        onMouseDown={stopInlineMathEventPropagation}
        onKeyDown={stopInlineMathEventPropagation}
      />
      </MathEnvironmentValueProvider>,
    ));
  }

  private handleEditingInput(nextTex: string, cursor?: number): void {
    this.editingTex = nextTex;
    if (this.body) {
      setInlineMathBodyTex(this.body, nextTex, { environment: this.mathEnvironment });
    }
    this.dispatchSelection(nextTex, cursor);
  }

  private unmountEditingField(): void {
    const root = this.fieldRoot;
    const container = this.fieldContainer;
    this.fieldRoot = null;
    this.fieldContainer = null;
    container?.remove();
    // React は描画中の同期 unmount を嫌う (この呼び出し自体が React のイベントから来る)。
    queueMicrotask(() => root?.unmount());
  }

  /** 確定した TeX が枠コマンドだった場合は本文の囲みランへ化けるので、その後の数式処理は行わない。 */
  private commitMath(nextTex: string): boolean {
    const position = this.getPos();
    if (typeof position === "number" && convertInlineMathToBoxedRun(this.editor, position, this.node.nodeSize, nextTex)) {
      this.finishEditing();
      return true;
    }
    this.updateTexAttribute(nextTex);
    this.dispatchSelection(nextTex);
    this.finishEditing();
    return false;
  }

  private commitMathAndReturnToTextAfter(nextTex: string): void {
    const position = this.getPos();
    const nextInlineMath = typeof position === "number"
      ? findAdjacentInlineMath(this.editor, position, this.node.nodeSize, "after")
      : null;
    if (this.commitMath(nextTex) || typeof position !== "number") {
      return;
    }
    if (nextInlineMath) {
      requestInlineMathEdit(nextInlineMath.id, "start");
      return;
    }
    focusTextSelection(this.editor, position + this.node.nodeSize);
  }

  private commitMathAndReturnToTextBefore(nextTex: string): void {
    const position = this.getPos();
    const previousInlineMath = typeof position === "number"
      ? findAdjacentInlineMath(this.editor, position, this.node.nodeSize, "before")
      : null;
    if (this.commitMath(nextTex) || typeof position !== "number") {
      return;
    }
    if (previousInlineMath) {
      requestInlineMathEdit(previousInlineMath.id, "end");
      return;
    }
    focusTextSelection(this.editor, position);
  }

  private commitMathAndDeleteBackwardFromStart(nextTex: string): void {
    const position = this.getPos();
    if (typeof position === "number" && isEmptyInlineMathTex(nextTex)) {
      this.finishEditing();
      deleteInlineMathNode(this.editor, position, this.node.nodeSize);
      return;
    }
    if (this.commitMath(nextTex) || typeof position !== "number") {
      return;
    }
    deleteBackwardFromTextSelection(this.editor, position);
  }

  private readonly handleMouseDown = (event: globalThis.MouseEvent) => {
    if (this.editing || event.button !== 0 || event.defaultPrevented) {
      return;
    }

    const position = this.getPos();
    if (typeof position !== "number" || this.editor.isDestroyed) {
      event.preventDefault();
      event.stopPropagation();
      this.beginEditing();
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const startPoint = { x: event.clientX, y: event.clientY };
    const ownerWindow = this.editor.view.dom.ownerDocument.defaultView ?? window;
    let dragged = false;

    const updateSelection = (clientX: number, clientY: number) => {
      if (this.editor.isDestroyed) {
        return;
      }
      const head = getTextSelectionPositionAtClientPoint(this.editor, clientX, clientY);
      if (head === null) {
        return;
      }
      const anchor = getInlineMathDragSelectionAnchor(position, this.node.nodeSize, startPoint, { x: clientX, y: clientY });
      const transaction = this.editor.state.tr
        .setSelection(TextSelection.create(
          this.editor.state.doc,
          clampTextSelectionPosition(this.editor, anchor),
          clampTextSelectionPosition(this.editor, head),
        ))
        .scrollIntoView();
      this.editor.view.focus();
      this.editor.view.dispatch(transaction);
    };

    const handleMouseMove = (moveEvent: globalThis.MouseEvent) => {
      const moved =
        Math.abs(moveEvent.clientX - startPoint.x) > INLINE_MATH_DRAG_SELECTION_THRESHOLD_PX ||
        Math.abs(moveEvent.clientY - startPoint.y) > INLINE_MATH_DRAG_SELECTION_THRESHOLD_PX;
      if (!moved) {
        return;
      }
      dragged = true;
      moveEvent.preventDefault();
      updateSelection(moveEvent.clientX, moveEvent.clientY);
    };

    const handleMouseUp = (upEvent: globalThis.MouseEvent) => {
      if (!dragged) {
        // 押した位置に placeholder があれば、そこへ直接入る。静的プレビューは prompt id を
        // 持たないので、序数を編集用の math-field へ持ち越す。
        this.beginEditing(this.tex, "end", {
          placeholderIndex: this.body
            ? getInlineMathPlaceholderIndexAtPoint(this.body, startPoint.x, startPoint.y)
            : null,
        });
        return;
      }
      upEvent.preventDefault();
      updateSelection(upEvent.clientX, upEvent.clientY);
    };

    // ドラッグ中にノードビューが壊されることがある (本文ユニットの作り直し・ウィンドウ外で
    // ボタンを離す)。`mouseup` が来ないまま残ると、破棄済みのビューを掴んだ `mousemove` が
    // 生き続けるので、破棄時にも必ず外す。
    const stopDragListeners = () => {
      ownerWindow.removeEventListener("mousemove", handleMouseMove);
      ownerWindow.removeEventListener("mouseup", handleMouseUp);
    };
    this.disposers.push(stopDragListeners);
    ownerWindow.addEventListener("mousemove", handleMouseMove);
    ownerWindow.addEventListener("mouseup", (upEvent) => {
      stopDragListeners();
      handleMouseUp(upEvent);
    }, { once: true });
  };
}

function stopInlineMathEventPropagation(event: { stopPropagation: () => void }): void {
  event.stopPropagation();
}

/**
 * If `tex` is a TeX box command (e.g. `\tcolorbox{…}`, `\itembox{t}{b}`), replace the
 * inline-math node at [position, position + nodeSize) with the equivalent boxed text
 * run and return true. Otherwise leave the node untouched and return false, so normal
 * math committing proceeds. Guarded on the schema actually having the boxed mark.
 */
function convertInlineMathToBoxedRun(
  editor: Editor,
  position: number,
  nodeSize: number,
  tex: string,
): boolean {
  if (!editor || editor.isDestroyed || !editor.schema.marks.boxed) {
    return false;
  }

  const box = parseTexBoxCommand(tex);
  if (!box) {
    return false;
  }

  const from = position;
  const to = position + nodeSize;
  const inlineNodes = boxCommandToInlineNodes(box, createId);

  if (inlineNodes.length === 0) {
    return editor.chain().focus().deleteRange({ from, to }).run();
  }

  const content = inlineNodesToTiptapNodes(inlineNodes) as unknown as JSONContent[];
  return editor.chain().focus().insertContentAt({ from, to }, content).run();
}

export function InlineMathField({
  ariaDescribedBy,
  ariaLabel,
  className,
  dataTestId,
  invalid = false,
  locked,
  tex,
  mathEnvironment,
  initialCursorPosition,
  initialLatexCommandTrigger,
  initialPlaceholderIndex,
  onInput,
  onCancel,
  onCommit,
  onDeleteBackwardFromStart,
  onReturnToTextAfter,
  onReturnToTextBefore,
  onPointerDown,
  onMouseDown,
  onKeyDown,
}: {
  ariaDescribedBy?: string;
  ariaLabel?: string;
  className?: string;
  dataTestId?: string;
  invalid?: boolean;
  locked: boolean;
  tex: string;
  /** 描画環境。NodeView は React ツリーの外で mount するので context では届かない。 */
  mathEnvironment: MathRenderEnvironment;
  /** クリックされた placeholder の序数 (無ければ null)。 */
  initialPlaceholderIndex: number | null;
  initialCursorPosition: InlineMathCursorPosition;
  initialLatexCommandTrigger: InlineMathLatexCommandTrigger | null;
  onInput: (tex: string, cursor?: number) => void;
  onCancel: () => void;
  onCommit: (tex: string) => void;
  onDeleteBackwardFromStart: (tex: string) => void;
  onReturnToTextAfter: (tex: string) => void;
  onReturnToTextBefore: (tex: string) => void;
  onPointerDown: (event: PointerEvent) => void;
  onMouseDown: (event: ReactMouseEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
}) {
  const [inputMode] = useInlineMathInputMode();

  if (inputMode === "mathlive") {
    return (
      <InlineMathLiveField
        ariaDescribedBy={ariaDescribedBy}
        ariaLabel={ariaLabel}
        className={className}
        dataTestId={dataTestId}
        invalid={invalid}
        locked={locked}
        tex={tex}
        mathEnvironment={mathEnvironment}
        initialCursorPosition={initialCursorPosition}
        initialPlaceholderIndex={initialPlaceholderIndex}
        initialLatexCommandTrigger={initialLatexCommandTrigger}
        onInput={onInput}
        onCancel={onCancel}
        onCommit={onCommit}
        onDeleteBackwardFromStart={onDeleteBackwardFromStart}
        onReturnToTextAfter={onReturnToTextAfter}
        onReturnToTextBefore={onReturnToTextBefore}
        onPointerDown={onPointerDown}
        onMouseDown={onMouseDown}
        onKeyDown={onKeyDown}
      />
    );
  }

  return (
    <InlineMathTexField
      ariaDescribedBy={ariaDescribedBy}
      ariaLabel={ariaLabel}
      dataTestId={dataTestId}
      invalid={invalid}
      locked={locked}
      tex={tex}
      initialCursorPosition={initialCursorPosition}
      onInput={onInput}
      onCancel={onCancel}
      onCommit={onCommit}
      onDeleteBackwardFromStart={onDeleteBackwardFromStart}
      onReturnToTextAfter={onReturnToTextAfter}
      onReturnToTextBefore={onReturnToTextBefore}
      onPointerDown={onPointerDown}
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
    />
  );
}

function InlineMathTexField({
  ariaDescribedBy,
  ariaLabel,
  dataTestId,
  invalid = false,
  locked,
  tex,
  initialCursorPosition,
  onInput,
  onCancel,
  onCommit,
  onDeleteBackwardFromStart,
  onReturnToTextAfter,
  onReturnToTextBefore,
  onPointerDown,
  onMouseDown,
  onKeyDown,
}: {
  ariaDescribedBy?: string;
  ariaLabel?: string;
  dataTestId?: string;
  invalid?: boolean;
  locked: boolean;
  tex: string;
  initialCursorPosition: InlineMathCursorPosition;
  onInput: (tex: string, cursor?: number) => void;
  onCancel: () => void;
  onCommit: (tex: string) => void;
  onDeleteBackwardFromStart: (tex: string) => void;
  onReturnToTextAfter: (tex: string) => void;
  onReturnToTextBefore: (tex: string) => void;
  onPointerDown: (event: PointerEvent) => void;
  onMouseDown: (event: ReactMouseEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const onInputRef = useRef(onInput);
  const draftTexRef = useRef(tex);
  const committedRef = useRef(false);
  const commandReferenceOpenRef = useRef(false);
  const armedEdgeRef = useRef<"left" | "right" | null>(null);
  const [draftTex, setDraftTex] = useState(tex);

  useEffect(() => {
    onInputRef.current = onInput;
  }, [onInput]);

  useEffect(() => {
    draftTexRef.current = tex;
    const syncFrame = window.requestAnimationFrame(() => setDraftTex(tex));
    return () => window.cancelAnimationFrame(syncFrame);
  }, [tex]);

  // Placing the initial caret exactly once on mount is not enough. The textarea lives inside a
  // `ToolbarPopover`, which renders `null` until its portal host is resolved in a layout effect,
  // and any ProseMirror transaction on the math node (the draft-sync round trip fires one) can
  // rebuild the node view underneath it. Each of those remounts hands React's `autoFocus` a fresh
  // textarea whose caret sits at offset 0 — which is why `\` + `frac` in TeX mode used to produce
  // `frac\`: every character landed *before* the backslash the node was seeded with. So re-assert
  // the requested caret on every attach/focus until the author actually interacts with the field.
  const userInteractedRef = useRef(false);

  const markUserInteraction = useCallback(() => {
    userInteractedRef.current = true;
  }, []);

  const applyInitialCaret = useCallback((input: HTMLTextAreaElement | null) => {
    if (!input || locked || userInteractedRef.current) {
      return;
    }
    const cursor = initialCursorPosition === "start" ? 0 : input.value.length;
    if (input.selectionStart === cursor && input.selectionEnd === cursor) {
      return;
    }
    input.setSelectionRange(cursor, cursor);
    onInputRef.current(input.value, cursor);
  }, [initialCursorPosition, locked]);

  const setInputElement = useCallback((element: HTMLTextAreaElement | null) => {
    inputRef.current = element;
    applyInitialCaret(element);
  }, [applyInitialCaret]);

  useEffect(() => {
    let focusFrame = 0;
    let focusTimeout = 0;

    const focusInput = () => {
      const input = inputRef.current;
      if (!input || locked) {
        return;
      }
      input.focus({ preventScroll: true });
      applyInitialCaret(input);
    };

    focusFrame = window.requestAnimationFrame(focusInput);
    focusTimeout = window.setTimeout(focusInput, 50);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.clearTimeout(focusTimeout);
    };
  }, [applyInitialCaret, locked]);

  const restoreInputCursor = useCallback((cursor: number) => {
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) {
        return;
      }
      const nextCursor = clampInlineMathTexCursor(cursor, input.value);
      input.setSelectionRange(nextCursor, nextCursor);
    });
  }, []);

  const updateDraft = useCallback((nextTex: string, cursor = nextTex.length) => {
    const nextCursor = clampInlineMathTexCursor(cursor, nextTex);
    draftTexRef.current = nextTex;
    setDraftTex(nextTex);
    onInputRef.current(nextTex, nextCursor);
    return nextCursor;
  }, []);

  const applyInlineMathTexChange = useCallback((change: InlineMathTexFieldChange) => {
    const cursor = updateDraft(change.tex, change.cursor);
    restoreInputCursor(cursor);
  }, [restoreInputCursor, updateDraft]);

  /**
   * 括弧オートペア。値とキャレットは `applyTexBracketEditToTextarea` が同期で確定させ
   * (rAF で戻すと続けて打った文字が古い位置に入る)、ここでは下書きの同期だけを行う。
   */
  const applyTexBracketEdit = useCallback((input: HTMLTextAreaElement, edit: TexBracketEdit) => {
    updateDraft(applyTexBracketEditToTextarea(input, edit), edit.selectionEnd);
  }, [updateDraft]);

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const input = event.currentTarget;
    markUserInteraction();
    const cursor = input.selectionStart ?? input.value.length;
    const change = normalizeInlineMathTexFieldChange(input.value, cursor);
    updateDraft(change.tex, change.cursor);
    if (change.tex !== input.value || change.cursor !== cursor) {
      restoreInputCursor(change.cursor);
    }
  };

  const insertTexAtSelection = (input: HTMLTextAreaElement, insertedTex: string) => {
    applyInlineMathTexChange(insertInlineMathTexAtSelection(
      input.value,
      input.selectionStart ?? input.value.length,
      input.selectionEnd ?? input.selectionStart ?? input.value.length,
      insertedTex,
    ));
  };

  const commit = (element: EventTarget | null, action: "after" | "backspace" | "before" | "commit" = "commit") => {
    if (locked) {
      onCancel();
      return;
    }
    if (committedRef.current) {
      return;
    }
    committedRef.current = true;
    const input = element instanceof HTMLTextAreaElement ? element : inputRef.current;
    const nextTex = normalizeInlineMathTexLiteralInput(input?.value ?? draftTexRef.current);
    if (action === "after") {
      onReturnToTextAfter(nextTex);
    } else if (action === "before") {
      onReturnToTextBefore(nextTex);
    } else if (action === "backspace") {
      onDeleteBackwardFromStart(nextTex);
    } else {
      onCommit(nextTex);
    }
  };

  return (
    <InlineMathTexEditor
      ref={setInputElement}
      ariaDescribedBy={ariaDescribedBy}
      ariaLabel={ariaLabel}
      dataTestId={dataTestId}
      invalid={invalid}
      locked={locked}
      tex={draftTex}
      onClose={() => commit(inputRef.current)}
      onDone={() => commit(inputRef.current)}
      onInteractionPointerDown={onPointerDown}
      onInteractionMouseDown={onMouseDown}
      onInteractionKeyDown={onKeyDown}
      onCommandReferenceOpenChange={(open) => {
        commandReferenceOpenRef.current = open;
      }}
      textareaProps={{
        onFocus: (event) => {
          applyInitialCaret(event.currentTarget);
        },
        onPointerDown: (event) => {
          armedEdgeRef.current = null;
          markUserInteraction();
          onPointerDown(event);
        },
        onMouseDown,
        onKeyDownCapture: (event: KeyboardEvent) => {
          if (!shouldCommitInlineMathTexOnKeyDown(event)) {
            return;
          }

          event.preventDefault();
          event.stopPropagation();
          commit(event.currentTarget);
        },
        onKeyDown: (event: KeyboardEvent) => {
          const input = event.currentTarget as HTMLTextAreaElement;
          markUserInteraction();
          if (shouldInsertInlineMathLineBreak(event)) {
            event.preventDefault();
            event.stopPropagation();
            insertTexAtSelection(input, "\\\\");
            return;
          }

          if (isMathKeyboardReturnToTextShortcut(event)) {
            event.preventDefault();
            event.stopPropagation();
            commit(input, "after");
            return;
          }

          const cursorState = getInlineMathTexInputSelectionState(input);
          const prevArmedEdge = armedEdgeRef.current;
          armedEdgeRef.current = null;
          const arrowEdgeAction = resolveInlineMathArrowEdgeAction(event, cursorState, prevArmedEdge);
          if (arrowEdgeAction === "arm") {
            event.preventDefault();
            event.stopPropagation();
            armedEdgeRef.current = event.key === "ArrowRight" ? "right" : "left";
            return;
          }
          if (arrowEdgeAction === "exit") {
            event.preventDefault();
            event.stopPropagation();
            commit(input, event.key === "ArrowRight" ? "after" : "before");
            return;
          }

          if (shouldDeleteBeforeInlineMathOnBackspace(event, cursorState)) {
            event.preventDefault();
            event.stopPropagation();
            commit(input, "backspace");
            return;
          }

          const shortcut = getMathKeyboardMathShortcut(event);
          if (shortcut) {
            event.preventDefault();
            event.stopPropagation();
            const selectionStart = input.selectionStart ?? input.value.length;
            const selectionEnd = input.selectionEnd ?? selectionStart;
            const from = Math.min(selectionStart, selectionEnd);
            const to = Math.max(selectionStart, selectionEnd);
            insertTexAtSelection(input, createInlineMathTexFromMathKeyboardShortcut(shortcut, input.value.slice(from, to)));
            return;
          }

          // 括弧のオートペア。Ctrl 系ショートカットより後に見るので、Ctrl+[ などは奪われない。
          const bracketEdit = resolveTexBracketEdit(event, {
            selectionEnd: input.selectionEnd ?? input.value.length,
            selectionStart: input.selectionStart ?? input.value.length,
            value: input.value,
          });
          if (bracketEdit) {
            event.preventDefault();
            event.stopPropagation();
            applyTexBracketEdit(input, bracketEdit);
            return;
          }

          onKeyDown(event);
          if (!shouldCommitInlineMathTexOnKeyDown(event)) {
            return;
          }
          event.preventDefault();
          commit(event.currentTarget);
        },
        onBlur: (event) => {
          if (commandReferenceOpenRef.current) {
            return;
          }
          commit(event.target);
        },
        onChange: handleChange,
        onSelect: (event) => {
          const input = event.currentTarget;
          onInputRef.current(input.value, input.selectionStart ?? input.value.length);
        },
      }}
    />
  );
}

function InlineMathLiveField({
  ariaDescribedBy,
  ariaLabel,
  className,
  dataTestId,
  invalid = false,
  locked,
  tex,
  mathEnvironment,
  initialCursorPosition,
  initialPlaceholderIndex,
  initialLatexCommandTrigger,
  onInput,
  onCancel,
  onCommit,
  onDeleteBackwardFromStart,
  onReturnToTextAfter,
  onReturnToTextBefore,
  onPointerDown,
  onMouseDown,
  onKeyDown,
}: {
  ariaDescribedBy?: string;
  ariaLabel?: string;
  className?: string;
  dataTestId?: string;
  invalid?: boolean;
  locked: boolean;
  tex: string;
  /** 描画環境。NodeView は React ツリーの外で mount するので context では届かない。 */
  mathEnvironment: MathRenderEnvironment;
  /** クリックされた placeholder の序数 (無ければ null)。 */
  initialPlaceholderIndex: number | null;
  initialCursorPosition: InlineMathCursorPosition;
  initialLatexCommandTrigger: InlineMathLatexCommandTrigger | null;
  onInput: (tex: string, cursor?: number) => void;
  onCancel: () => void;
  onCommit: (tex: string) => void;
  onDeleteBackwardFromStart: (tex: string) => void;
  onReturnToTextAfter: (tex: string) => void;
  onReturnToTextBefore: (tex: string) => void;
  onPointerDown: (event: PointerEvent) => void;
  onMouseDown: (event: ReactMouseEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
}) {
  const fieldId = useId();
  const onInputRef = useRef(onInput);
  const pendingLatexCommandRef = useRef<PendingInlineMathLatexCommand | null>(null);
  const pendingLatexCommandTimeoutRef = useRef(0);
  const committedRef = useRef(false);
  const armedEdgeRef = useRef<"left" | "right" | null>(null);

  useEffect(() => {
    onInputRef.current = onInput;
  }, [onInput]);

  const clearPendingLatexCommand = useCallback(() => {
    if (pendingLatexCommandTimeoutRef.current) {
      window.clearTimeout(pendingLatexCommandTimeoutRef.current);
      pendingLatexCommandTimeoutRef.current = 0;
    }
    pendingLatexCommandRef.current = null;
  }, []);

  const insertPendingLatexCommandDisplay = useCallback((mathField: InlineMathFieldElement, trigger: InlineMathLatexCommandTrigger): number => {
    const startOffset = getInlineMathFieldPosition(mathField);
    if (trigger === "\\") {
      return startOffset;
    }

    mathField.insert(trigger, {
      focus: true,
      mode: "math",
      selectionMode: "after",
    });
    onInputRef.current(syncInlineMathFieldLineBreaks(mathField));
    return startOffset;
  }, []);

  const insertPendingLatexCommandCharacter = useCallback((mathField: InlineMathFieldElement, character: string) => {
    mathField.insert(character, { focus: true, mode: "math", selectionMode: "after" });
    onInputRef.current(syncInlineMathFieldLineBreaks(mathField));
  }, []);

  const replacePendingLatexCommandDisplay = useCallback((
    mathField: InlineMathFieldElement,
    pending: PendingInlineMathLatexCommand,
    replacement: string,
    options: { format?: "latex" } = {},
  ) => {
    const endOffset = Math.max(pending.startOffset, getInlineMathFieldPosition(mathField));
    mathField.selection = {
      direction: "forward",
      ranges: [[pending.startOffset, endOffset]],
    };
    mathField.insert(replacement, {
      focus: true,
      ...(options.format ? { format: options.format } : {}),
      mode: "math",
      selectionMode: options.format === "latex" ? "placeholder" : "after",
    });
    onInputRef.current(syncInlineMathFieldLineBreaks(mathField));
  }, []);

  const insertInlineMathRowSeparator = useCallback((mathField: InlineMathFieldElement) => {
    mathField.insert("\\\\", { focus: true, mode: "math" });
    onInputRef.current(syncInlineMathFieldLineBreaks(mathField));
  }, []);

  const insertInlineMathText = useCallback((mathField: InlineMathFieldElement, text: string) => {
    mathField.insert(text, { focus: true, format: "latex", mode: "math", selectionMode: "after" });
    onInputRef.current(syncInlineMathFieldLineBreaks(mathField));
  }, []);

  const flushPendingLatexCommand = useCallback((mathField: InlineMathFieldElement): boolean => {
    const pending = pendingLatexCommandRef.current;
    if (!pending) {
      return false;
    }

    if (pending.trigger === "\\" && !pending.text) {
      clearPendingLatexCommand();
      return false;
    }

    const nextTex = resolvePendingInlineMathLatexCommand(pending, { force: true });
    clearPendingLatexCommand();
    if (nextTex) {
      replacePendingLatexCommandDisplay(mathField, pending, nextTex, { format: "latex" });
      return true;
    }

    return false;
  }, [clearPendingLatexCommand, replacePendingLatexCommandDisplay]);

  const schedulePendingLatexCommandFlush = useCallback((mathField: InlineMathFieldElement) => {
    if (pendingLatexCommandTimeoutRef.current) {
      window.clearTimeout(pendingLatexCommandTimeoutRef.current);
    }
    pendingLatexCommandTimeoutRef.current = window.setTimeout(
      () => flushPendingLatexCommand(mathField),
      INLINE_MATH_LATEX_COMMAND_TIMEOUT_MS,
    );
  }, [flushPendingLatexCommand]);

  const rememberPendingLatexCommand = useCallback((trigger: InlineMathLatexCommandTrigger, mathField: InlineMathFieldElement) => {
    clearPendingLatexCommand();
    const startOffset = insertPendingLatexCommandDisplay(mathField, trigger);
    pendingLatexCommandRef.current = { startOffset, text: "", trigger };
    if (trigger === "/") {
      schedulePendingLatexCommandFlush(mathField);
    }
  }, [clearPendingLatexCommand, insertPendingLatexCommandDisplay, schedulePendingLatexCommandFlush]);

  useEffect(() => {
    return () => clearPendingLatexCommand();
  }, [clearPendingLatexCommand]);

  useEffect(() => {
    let cancelled = false;
    let focusFrame = 0;
    let focusTimeout = 0;
    let mathField: InlineMathFieldElement | null = null;
    let initialLatexCommandApplied = false;
    const handleMathFieldInput = () => {
      if (!mathField || locked) {
        return;
      }
      onInputRef.current(syncInlineMathFieldLineBreaks(mathField));
    };
    const handleMathFieldBlur = () => {
      if (!mathField || !pendingLatexCommandRef.current) {
        return;
      }
      flushPendingLatexCommand(mathField);
    };
    const handleMathFieldKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!mathField || locked) {
        return;
      }
      const eventPath = event.composedPath();
      if (!eventPath.includes(mathField)) {
        return;
      }

      const shiftDigit7Text = getInlineMathShiftDigit7Text(event);
      if (shiftDigit7Text) {
        event.preventDefault();
        event.stopImmediatePropagation();
        clearPendingLatexCommand();
        insertInlineMathText(mathField, shiftDigit7Text);
        return;
      }

      const pendingCommand = pendingLatexCommandRef.current;
      if (pendingCommand) {
        if (pendingCommand.trigger === "\\" && pendingCommand.text === "" && isInlineMathBackslashKey(event)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          clearPendingLatexCommand();
          insertInlineMathRowSeparator(mathField);
          return;
        }

        if (isInlineMathLatexCommandCharacterKey(event)) {
          const nextText = `${pendingCommand.text}${event.key}`.toLowerCase();
          if (pendingCommand.trigger !== "\\" && !hasInlineMathLatexCommandCandidate(nextText)) {
            clearPendingLatexCommand();
            return;
          }

          event.preventDefault();
          event.stopImmediatePropagation();
          pendingLatexCommandRef.current = { ...pendingCommand, text: nextText };
          insertPendingLatexCommandCharacter(mathField, event.key);
          const nextTex = resolveInlineMathLatexCommand(nextText, { allowImmediate: pendingCommand.trigger !== "\\" });
          if (nextTex) {
            clearPendingLatexCommand();
            replacePendingLatexCommandDisplay(mathField, pendingLatexCommandRef.current ?? { ...pendingCommand, text: nextText }, nextTex, { format: "latex" });
          } else if (pendingCommand.trigger === "/") {
            schedulePendingLatexCommandFlush(mathField);
          }
          return;
        }

        if (
          shouldCommitInlineMathOnKeyDown(event) ||
          isMathKeyboardReturnToTextShortcut(event) ||
          event.key === "ArrowRight" ||
          event.key === "ArrowLeft" ||
          event.key === "Backspace"
        ) {
          flushPendingLatexCommand(mathField);
          // document captureでは止めず、math-field側の確定・移動処理へ伝播させる。
        }

        if (shouldFlushPendingInlineMathLatexCommand(event)) {
          const flushed = flushPendingLatexCommand(mathField);
          if (event.key === " ") {
            if (flushed) {
              event.preventDefault();
              event.stopImmediatePropagation();
            }
            return;
          }
        } else if (shouldClearPendingInlineMathLatexCommand(event)) {
          clearPendingLatexCommand();
        }
      }

      const latexCommandTrigger = getInlineMathLatexCommandTrigger(event);
      if (latexCommandTrigger) {
        event.preventDefault();
        event.stopImmediatePropagation();
        rememberPendingLatexCommand(latexCommandTrigger, mathField);
      }
    };

    void import("mathlive").then(() => {
      const element = document.querySelector(`[data-inline-math-field-id="${CSS.escape(fieldId)}"]`);
      if (cancelled || !(element instanceof HTMLElement)) {
        return;
      }

      mathField = element as InlineMathFieldElement;
      configureInlineMathField(mathField, mathEnvironment);
      // `--text-font-family: inherit` はカスタムプロパティ自身を継承してしまい、
      // この要素の計算後 `font-family` にはならない。実際の本文フォントを写し取って、
      // 編集中の `\text{...}` が静的プレビューと同じ書体で出るようにする。
      const inheritedTextFontFamily = mathField.ownerDocument.defaultView
        ?.getComputedStyle(mathField).fontFamily;
      if (inheritedTextFontFamily) {
        mathField.style.setProperty("--text-font-family", inheritedTextFontFamily);
      }
      mathField.readOnly = locked;
      // クリックされた placeholder に入るには、無名の `\placeholder{}` に一時的な id を振る。
      mathField.value = initialPlaceholderIndex === null
        ? tex
        : indexAnonymousInlineMathPlaceholders(tex);
      mathField.addEventListener("input", handleMathFieldInput);
      mathField.addEventListener("blur", handleMathFieldBlur);
      mathField.ownerDocument.addEventListener("keydown", handleMathFieldKeyDown, true);
      const mountedMathField = mathField;
      const focusMathField = () => {
        if (cancelled || locked) {
          return;
        }
        configureInlineMathField(mountedMathField, mathEnvironment);
        mountedMathField.focus({ preventScroll: true });
        if (!focusInlineMathPlaceholder(mountedMathField, initialPlaceholderIndex)) {
          mountedMathField.executeCommand?.(initialCursorPosition === "start" ? "moveToMathfieldStart" : "moveToMathfieldEnd");
        }
        if (initialLatexCommandTrigger && !initialLatexCommandApplied) {
          initialLatexCommandApplied = true;
          rememberPendingLatexCommand(initialLatexCommandTrigger, mountedMathField);
        }
      };
      focusFrame = window.requestAnimationFrame(focusMathField);
      focusTimeout = window.setTimeout(focusMathField, 50);
    });

    return () => {
      cancelled = true;
      if (focusFrame) {
        window.cancelAnimationFrame(focusFrame);
      }
      if (focusTimeout) {
        window.clearTimeout(focusTimeout);
      }
      mathField?.removeEventListener("input", handleMathFieldInput);
      mathField?.removeEventListener("blur", handleMathFieldBlur);
      mathField?.ownerDocument.removeEventListener("keydown", handleMathFieldKeyDown, true);
    };
  }, [
    clearPendingLatexCommand,
    fieldId,
    initialPlaceholderIndex,
    mathEnvironment,
    flushPendingLatexCommand,
    initialCursorPosition,
    initialLatexCommandTrigger,
    insertInlineMathText,
    insertPendingLatexCommandCharacter,
    insertInlineMathRowSeparator,
    locked,
    rememberPendingLatexCommand,
    replacePendingLatexCommandDisplay,
    schedulePendingLatexCommandFlush,
    tex,
  ]);

  const commit = (element: EventTarget | null, action: "after" | "backspace" | "before" | "commit" = "commit") => {
    if (locked) {
      onCancel();
      return;
    }
    if (committedRef.current) {
      return;
    }
    committedRef.current = true;
    const mathField = element as InlineMathFieldElement | null;
    // クリックで入るために振った一時 id は、確定時に必ず落とす (文書に残さない)。
    const nextTex = removeInlineMathClickPlaceholderIds(
      normalizeInlineMathLineBreakInput(mathField?.value ?? "", {
        forceLatexCommands: true,
      }),
    );
    if (action === "after") {
      onReturnToTextAfter(nextTex);
    } else if (action === "before") {
      onReturnToTextBefore(nextTex);
    } else if (action === "backspace") {
      onDeleteBackwardFromStart(nextTex);
    } else {
      onCommit(nextTex);
    }
  };

  return React.createElement("math-field", {
    "aria-describedby": ariaDescribedBy,
    "aria-invalid": invalid ? "true" : undefined,
    "aria-label": ariaLabel,
    "data-testid": dataTestId,
    "data-inline-math-field-id": fieldId,
    // 初期属性も `configureInlineMathField` と同じ出典から。ここだけ直値だと、
    // マウント直後の 1 フレームが文書の組版スタイルと違う組版で描かれる。
    "default-mode": mathFieldDefaultMode(mathEnvironment.typesetStyle),
    "environment-popover-policy": "off",
    "math-mode-space": MATHLIVE_MATH_MODE_SPACE,
    "math-virtual-keyboard-policy": "manual",
    "popover-policy": "auto",
    autocapitalize: "none",
    autocorrect: "off",
    // math-fieldはカスタム要素なのでclassNameを渡すと、ReactのcamelCase→DOM
    // 属性マッピングがReact 18とReact 19で食い違う(React 18は文字通り
    // "classname"属性になり.inline-math-fieldのCSSが全て死ぬ、React 19は
    // "class"になる)。両方で同じ挙動にするため素の"class"キーで渡す。
    class: ["inline-math-field", className].filter(Boolean).join(" "),
    inputmode: "text",
    lang: "ja",
    "read-only": locked ? "true" : undefined,
    spellcheck: "false",
    onPointerDown: (event: PointerEvent) => {
      armedEdgeRef.current = null;
      onPointerDown(event);
    },
    onMouseDown,
    onKeyDownCapture: (event: KeyboardEvent) => {
      if (!shouldCommitInlineMathOnKeyDown(event)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      commit(event.currentTarget, event.key === "Enter" ? "after" : "commit");
    },
    onKeyDown: (event: KeyboardEvent) => {
      const mathField = event.currentTarget as InlineMathFieldElement;
      if (shouldInsertInlineMathLineBreak(event)) {
        event.preventDefault();
        event.stopPropagation();
        mathField.insert("\\\\", { focus: true, mode: "math" });
        onInput(syncInlineMathFieldLineBreaks(mathField));
        return;
      }

      const shiftDigit7Text = getInlineMathShiftDigit7Text(event);
      if (shiftDigit7Text) {
        event.preventDefault();
        event.stopPropagation();
        mathField.insert(shiftDigit7Text, { focus: true, format: "latex", mode: "math", selectionMode: "after" });
        onInput(syncInlineMathFieldLineBreaks(mathField));
        return;
      }

      if (isMathKeyboardReturnToTextShortcut(event)) {
        event.preventDefault();
        event.stopPropagation();
        commit(mathField, "after");
        return;
      }

      const prevArmedEdge = armedEdgeRef.current;
      armedEdgeRef.current = null;
      const arrowEdgeAction = resolveInlineMathArrowEdgeAction(event, mathField, prevArmedEdge);
      if (arrowEdgeAction === "arm") {
        event.preventDefault();
        event.stopPropagation();
        armedEdgeRef.current = event.key === "ArrowRight" ? "right" : "left";
        return;
      }
      if (arrowEdgeAction === "exit") {
        event.preventDefault();
        event.stopPropagation();
        commit(mathField, event.key === "ArrowRight" ? "after" : "before");
        return;
      }

      if (shouldDeleteBeforeInlineMathOnBackspace(event, mathField)) {
        event.preventDefault();
        event.stopPropagation();
        commit(mathField, "backspace");
        return;
      }

      if (handleMathKeyboardMathShortcut(event, mathField)) {
        onInput(getMathfieldLatex(mathField));
        return;
      }

      onKeyDown(event);
      if (!shouldCommitInlineMathOnKeyDown(event)) {
        return;
      }
      event.preventDefault();
      commit(event.currentTarget);
    },
    onBlur: (event: Event) => {
      commit(event.target);
    },
    onInput: (event: Event) => {
      onInput(syncInlineMathFieldLineBreaks(event.target as InlineMathFieldElement));
    },
  });
}

function getInlineMathTexInputSelectionState(input: HTMLTextAreaElement): InlineMathSelectionState {
  const selectionStart = input.selectionStart ?? input.value.length;
  const selectionEnd = input.selectionEnd ?? selectionStart;
  return {
    lastOffset: input.value.length,
    position: selectionStart,
    selectionIsCollapsed: selectionStart === selectionEnd,
  };
}

function insertInlineMathTexAtSelection(
  tex: string,
  selectionStart: number,
  selectionEnd: number,
  insertedTex: string,
): InlineMathTexFieldChange {
  const start = clampInlineMathTexCursor(selectionStart, tex);
  const end = clampInlineMathTexCursor(selectionEnd, tex);
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  const firstPlaceholderIndex = insertedTex.indexOf("#?");
  const cleanInsertedTex = insertedTex.replace(/#\?/g, "");
  const nextTex = `${tex.slice(0, from)}${cleanInsertedTex}${tex.slice(to)}`;
  const cursor = from + (firstPlaceholderIndex >= 0 ? firstPlaceholderIndex : cleanInsertedTex.length);
  return { cursor, tex: nextTex };
}

function normalizeInlineMathTexFieldChange(tex: string, cursor: number): InlineMathTexFieldChange {
  return { cursor: clampInlineMathTexCursor(cursor, tex), tex };
}

function normalizeInlineMathLatexAliasesWithCursor(
  tex: string,
  cursor: number,
  options: NormalizeInlineMathLatexAliasOptions = {},
): InlineMathTexFieldChange {
  const pattern = options.includeEnd
    ? /\\([a-zA-Z]+)(?=$|[^a-zA-Z])/g
    : /\\([a-zA-Z]+)(?=[^a-zA-Z])/g;
  let nextTex = "";
  let lastIndex = 0;
  let nextCursor = clampInlineMathTexCursor(cursor, tex);
  let changed = false;

  for (const match of tex.matchAll(pattern)) {
    const index = match.index ?? 0;
    const matchedText = match[0] ?? "";
    const input = match[1] ?? "";
    const replacement = resolveInlineMathRawTexAlias(input);
    if (!replacement || replacement === matchedText) {
      continue;
    }

    changed = true;
    nextTex += tex.slice(lastIndex, index);
    nextTex += replacement;
    if (index < nextCursor) {
      nextCursor += replacement.length - matchedText.length;
    }
    lastIndex = index + matchedText.length;
  }

  if (!changed) {
    return { cursor: nextCursor, tex };
  }

  nextTex += tex.slice(lastIndex);
  return {
    cursor: clampInlineMathTexCursor(nextCursor, nextTex),
    tex: nextTex,
  };
}

function resolveInlineMathRawTexAlias(input: string): string | null {
  // TeX command names are case-sensitive. Short aliases such as `\al` may expand to
  // `\alpha`, but an explicitly capitalized command such as `\Gamma` must stay intact.
  if (input !== input.toLowerCase()) {
    return null;
  }

  const command = resolveInlineMathLatexCommand(input, { force: true });
  if (!command || command.includes("#?")) {
    return null;
  }

  return command;
}

function syncInlineMathFieldLineBreaks(mathField: InlineMathFieldElement): string {
  const rawTex = getMathfieldLatex(mathField) || mathField.value;
  const nextTex = normalizeInlineMathLineBreakInput(rawTex);
  if (nextTex !== rawTex || nextTex !== mathField.value) {
    mathField.value = nextTex;
    mathField.executeCommand?.("moveToMathfieldEnd");
  }
  return nextTex;
}

function canInsertInlineMathAtSelection(selection: Selection): boolean {
  return selection.$from.sameParent(selection.$to) &&
    selection.$from.parent.inlineContent &&
    !selection.$from.parent.type.spec.code;
}

function getInlineMathFieldPosition(mathField: InlineMathFieldElement): number {
  return typeof mathField.position === "number" ? mathField.position : 0;
}

function resolvePendingInlineMathLatexCommand(
  pending: PendingInlineMathLatexCommand,
  options: { allowImmediate?: boolean; force?: boolean } = {},
): string | null {
  const tex = resolveInlineMathLatexCommand(pending.text, options);
  if (tex) {
    return tex;
  }

  return pending.trigger === "\\" && pending.text ? `\\${pending.text}` : null;
}

function normalizeInlineMathLatexCommandSpacing(tex: string, options: NormalizeInlineMathInputOptions): string {
  return tex.replace(/(^|[^\\])\\\s+([a-zA-Z]+)/g, (match, prefix: string, input: string) => {
    const command = resolveInlineMathLatexCommand(input, { force: options.forceLatexCommands });
    return command ? `${prefix}${command}` : match;
  });
}

function configureInlineMathField(
  mathField: InlineMathFieldElement,
  environment: MathRenderEnvironment,
) {
  configureInlineMathLiveField(mathField, environment);
}

export const InlineMathExtension = Node.create<MathNodeOptions>({
  name: "mathInline",
  group: "inline",
  inline: true,
  atom: true,
  marks: "_",
  selectable: true,

  addOptions(): MathNodeOptions {
    return {
      enableDelimiters: false,
      mathEnvironment: DEFAULT_MATH_RENDER_ENVIRONMENT,
    };
  },

  addAttributes() {
    return {
      id: {
        default: null,
      },
      tex: {
        default: "",
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span[data-sigma-doc-math-inline]",
        getAttrs: (element) => {
          if (!(element instanceof HTMLElement)) {
            return false;
          }

          return {
            id: element.getAttribute("data-id"),
            tex: element.getAttribute("data-tex") ?? element.textContent?.replace(/^\$|\$$/g, "") ?? "",
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const tex = typeof HTMLAttributes.tex === "string" ? HTMLAttributes.tex : "";
    const id = typeof HTMLAttributes.id === "string" ? HTMLAttributes.id : undefined;

    // クラスと属性は数式 DOM の共通出典から (`inline-math-frame.ts`)。ここは貼り付け用の
    // HTML と schema の直列化が通る道で、ノードビュー・静的レンダラと**同じ形**でなければ
    // ならない (`text-flow-static-parity.test.tsx` が突き合わせている)。
    // `tex` / `id` はノード属性で、素の属性として出す意味は無いので落とす。
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: inlineMathNodeClassName(),
        ...inlineMathNodeDataAttributes({ id, tex }),
        id: null,
        tex: null,
      }),
      createMathHtmlElement(tex, false, this.options.mathEnvironment),
    ];
  },

  renderText({ node }) {
    const tex = String(node.attrs.tex ?? "");
    return tex ? `$${tex}$` : "";
  },

  addCommands() {
    return {
      insertMathInline:
        (attrs) =>
        ({ commands }) => {
          const inserted = commands.insertContent({
            type: this.name,
            attrs: {
              id: attrs.id,
              tex: attrs.tex,
            },
          });

          if (inserted && attrs.startEditing) {
            requestInlineMathEdit(attrs.id);
          }

          return inserted;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        view: (view) => {
          const ownerDocument = view.dom.ownerDocument;
          const handleMouseDown = (event: MouseEvent) => {
            startInlineMathTrailingBoundarySelection(view, event, this.type);
          };
          ownerDocument.addEventListener("mousedown", handleMouseDown, true);
          return {
            destroy: () => ownerDocument.removeEventListener("mousedown", handleMouseDown, true),
          };
        },
        props: {
          decorations: (state) => createInlineMathSelectionDecorations(state.doc, state.selection),
          handleKeyDown: (view, event) => {
            const cursorPosition = getInlineMathKeyboardCursorPosition(event);
            if (cursorPosition && view.state.selection.empty) {
              markInlineMathKeyboardEditIntent(cursorPosition);
            }

            if (shouldStartInlineMathOnBackslash(event) && canInsertInlineMathAtSelection(view.state.selection)) {
              event.preventDefault();
              event.stopPropagation();

              const id = createId("m_inline");
              const startsWithRawBackslash = getInlineMathInputMode() === "tex";
              const node = this.type.create({ id, tex: startsWithRawBackslash ? "\\" : "" });
              view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
              requestInlineMathEdit(id, "end", startsWithRawBackslash ? {} : {
                pendingLatexCommandTrigger: "\\",
              });
              return true;
            }

            const shortcut = getMathKeyboardMathShortcut(event);
            if (shortcut && insertMathKeyboardShortcutInlineMathAtSelection(view.state, this.type, shortcut, view.dispatch)) {
              event.preventDefault();
              event.stopPropagation();
              return true;
            }

            if (!isMathKeyboardMathModeShortcut(event)) {
              return false;
            }

            event.preventDefault();
            event.stopPropagation();

            const id = createId("m_inline");
            const node = this.type.create({ id, tex: "" });
            view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
            requestInlineMathEdit(id);
            return true;
          },
          transformPasted: (slice) => refreshMathInlineIdsInSlice(slice),
          handlePaste: (view, event) => {
            const clipboardData = event.clipboardData;
            if (!clipboardData) {
              return false;
            }

            const payload = readEditorClipboardPayload(clipboardData);
            if (payload?.kind === "tiptapSlice") {
              try {
                const slice = refreshMathInlineIdsInSlice(Slice.fromJSON(view.state.schema, payload.slice));
                const transaction = shouldInsertClosedBlockSliceAfterCurrentBlock(slice)
                  ? view.state.tr.insert(topLevelInsertPosition(view.state.selection.$from), slice.content)
                  : view.state.tr.replaceSelection(slice);
                event.preventDefault();
                view.dispatch(transaction.scrollIntoView());
                return true;
              } catch {
                return false;
              }
            }

            const tex = payload?.kind === "inlineMath"
              ? payload.tex
              : extractSingleInlineMathText(clipboardData.getData("text/plain"));
            if (!tex) {
              return false;
            }

            event.preventDefault();
            const node = this.type.create({ id: createId("m_inline"), tex });
            view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
            return true;
          },
          handleDOMEvents: {
            copy: (view, event) => {
              const clipboardEvent = event as ClipboardEvent;
              const { selection } = view.state;
              if (!clipboardEvent.clipboardData) {
                return false;
              }

              if (selection instanceof NodeSelection && selection.node.type.name === this.name) {
                const tex = String(selection.node.attrs.tex ?? "");
                clipboardEvent.preventDefault();
                writeEditorClipboardData(clipboardEvent.clipboardData, createInlineMathClipboardPayload(tex));
                return true;
              }

              if (selection.empty) {
                return false;
              }

              const slice = selection.content();
              if (slice.content.size === 0 || !sliceHasMathInline(slice)) {
                return false;
              }

              clipboardEvent.preventDefault();
              writeEditorClipboardData(
                clipboardEvent.clipboardData,
                createTiptapSliceClipboardPayload(slice.toJSON(), sliceTextForClipboard(slice)),
              );
              return true;
            },
          },
        },
      }),
    ];
  },

  addInputRules() {
    if (!this.options.enableDelimiters) {
      return [];
    }

    return [
      nodeInputRule({
        find: /(?:^|[^$])\$([^$]+)\$$/,
        type: this.type,
        getAttributes: (match) => ({
          id: createId("m_inline"),
          tex: match[1],
        }),
      }),
    ];
  },

  addPasteRules() {
    if (!this.options.enableDelimiters) {
      return [];
    }

    return [
      nodePasteRule({
        find: /\$([^$]+)\$/g,
        type: this.type,
        getAttributes: (match) => ({
          id: createId("m_inline"),
          tex: match[1],
        }),
      }),
    ];
  },

  addNodeView() {
    const mathEnvironment = this.options.mathEnvironment;
    // React のノードビューではなく素の ProseMirror NodeView。表示は静的 DOM で、
    // 編集を始めた 1 つだけが自前の React ルートを建てる (`InlineMathNodeView`)。
    return (props) => new InlineMathNodeView({
      decorations: props.decorations,
      editor: props.editor as Editor,
      getPos: () => {
        const position = props.getPos();
        return typeof position === "number" ? position : undefined;
      },
      node: props.node,
    }, { mathEnvironment });
  },
});

export function createInlineMathSelectionDecorations(doc: ProseMirrorNode, selection: Selection): DecorationSet {
  if (selection.empty) {
    return DecorationSet.empty;
  }

  const decorations: Decoration[] = [];
  doc.nodesBetween(selection.from, selection.to, (childNode, pos) => {
    if (childNode.type.name !== "mathInline") {
      return true;
    }

    const nodeTo = pos + childNode.nodeSize;
    if (selection.from <= pos && selection.to >= nodeTo) {
      decorations.push(Decoration.node(pos, nodeTo, { class: "text-selected" }));
    }
    return false;
  });

  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

/**
 * テキスト選択の装飾 (`text-selected`) は ProseMirror がノードビューの DOM に直接付ける。
 *
 * 以前は React 版が props から読んで内側の span に付け直していた: ノードビューの外枠が
 * Tiptap の `.react-renderer` で、CSS が見るのは内側の `.inline-math-node` だったため。
 * 素の NodeView では外枠がその `.inline-math-node` そのものなので、付け直しは要らない。
 */

export function hasInlineMathEditGuardDecoration(
  decorations: ReadonlyArray<unknown>,
): boolean {
  // `Decoration` の `type` は公開型に出ていない (装飾の種類ごとの内部クラス) ので、
  // 属性は構造で読む。読む先は 1 つだけ: AI 編集ロックが atom に付ける印。
  return decorations.some((decoration) => {
    const attrs = (decoration as { type?: { attrs?: Record<string, unknown> } }).type?.attrs;
    return attrs?.["data-edit-guard-atom"] === "true";
  });
}

function markInlineMathKeyboardEditIntent(cursorPosition: InlineMathCursorPosition) {
  pendingInlineMathKeyboardEditIntent = {
    cursorPosition,
    until: Date.now() + INLINE_MATH_KEYBOARD_EDIT_WINDOW_MS,
  };
}

function consumeInlineMathKeyboardEditIntent(): { cursorPosition: InlineMathCursorPosition } | null {
  if (!pendingInlineMathKeyboardEditIntent || Date.now() > pendingInlineMathKeyboardEditIntent.until) {
    pendingInlineMathKeyboardEditIntent = null;
    return null;
  }

  const intent = pendingInlineMathKeyboardEditIntent;
  pendingInlineMathKeyboardEditIntent = null;
  return { cursorPosition: intent.cursorPosition };
}

export function getInlineMathKeyboardCursorPosition(event: InlineMathKeyboardEventLike): InlineMathCursorPosition | null {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || event.keyCode === 229) {
    return null;
  }

  if (event.key === "ArrowRight") {
    return "start";
  }

  if (event.key === "ArrowLeft") {
    return "end";
  }

  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    return "end";
  }

  return null;
}

export function shouldExitInlineMathOnArrowRight(
  event: InlineMathKeyboardEventLike,
  mathField: InlineMathSelectionState,
): boolean {
  if (event.key !== "ArrowRight" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return false;
  }

  if (event.isComposing || event.keyCode === 229 || mathField.selectionIsCollapsed === false) {
    return false;
  }

  if (typeof mathField.position !== "number" || typeof mathField.lastOffset !== "number") {
    return false;
  }

  return mathField.position >= mathField.lastOffset;
}

export function shouldExitInlineMathOnArrowLeft(
  event: InlineMathKeyboardEventLike,
  mathField: InlineMathSelectionState,
): boolean {
  if (event.key !== "ArrowLeft" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return false;
  }

  return isCollapsedInlineMathCursorAtStart(event, mathField);
}

export type InlineMathArrowEdgeAction = "exit" | "arm" | "none";

/**
 * Resolves how an arrow key at the edge of inline math should behave. Reaching
 * the edge first "arms" (the caret stays inside the math), and a second arrow
 * press in the same direction while still at the edge "exits" to the body text.
 */
export function resolveInlineMathArrowEdgeAction(
  event: InlineMathKeyboardEventLike,
  cursorState: InlineMathSelectionState,
  armedEdge: "left" | "right" | null,
): InlineMathArrowEdgeAction {
  if (shouldExitInlineMathOnArrowRight(event, cursorState)) {
    return armedEdge === "right" ? "exit" : "arm";
  }

  if (shouldExitInlineMathOnArrowLeft(event, cursorState)) {
    return armedEdge === "left" ? "exit" : "arm";
  }

  return "none";
}

export function shouldDeleteBeforeInlineMathOnBackspace(
  event: InlineMathKeyboardEventLike,
  mathField: InlineMathSelectionState,
): boolean {
  if (event.key !== "Backspace" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return false;
  }

  return isCollapsedInlineMathCursorAtStart(event, mathField);
}

function isCollapsedInlineMathCursorAtStart(
  event: InlineMathKeyboardEventLike,
  mathField: InlineMathSelectionState,
): boolean {
  if (event.isComposing || event.keyCode === 229 || mathField.selectionIsCollapsed === false) {
    return false;
  }

  return typeof mathField.position === "number" && mathField.position <= 0;
}

function normalizeInlineMathCursorPosition(value: unknown): InlineMathCursorPosition | undefined {
  return value === "start" || value === "end" ? value : undefined;
}

function normalizeInlineMathLatexCommandTrigger(value: unknown): InlineMathLatexCommandTrigger | undefined {
  return value === "\\" || value === "/" ? value : undefined;
}

function clampInlineMathTexCursor(cursor: number, tex: string): number {
  if (!Number.isFinite(cursor)) {
    return tex.length;
  }

  return clamp(Math.round(cursor), 0, tex.length);
}

export function getInlineMathDragSelectionAnchor(
  position: number,
  nodeSize: number,
  startPoint: { x: number; y: number },
  currentPoint: { x: number; y: number },
): number {
  const deltaX = currentPoint.x - startPoint.x;
  const deltaY = currentPoint.y - startPoint.y;
  if (Math.abs(deltaY) > Math.abs(deltaX)) {
    return deltaY >= 0 ? position : position + nodeSize;
  }

  return deltaX >= 0 ? position : position + nodeSize;
}

function startInlineMathTrailingBoundarySelection(
  view: EditorView,
  event: MouseEvent,
  mathInlineType: NodeType,
): boolean {
  if (event.button !== 0 || event.defaultPrevented) {
    return false;
  }

  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("[data-sigma-doc-math-inline]")) {
    return false;
  }

  const startPosition = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
  if (typeof startPosition !== "number") {
    return false;
  }

  const $start = view.state.doc.resolve(startPosition);
  const nodeBefore = $start.nodeBefore;
  if (!nodeBefore || nodeBefore.type !== mathInlineType) {
    return false;
  }

  const nodePosition = startPosition - nodeBefore.nodeSize;
  const nodeDom = view.nodeDOM(nodePosition);
  const nodeElement = nodeDom instanceof Element
    ? nodeDom
    : nodeDom?.parentElement ?? null;
  if (!nodeElement) {
    return false;
  }

  const nodeRect = nodeElement.getBoundingClientRect();
  const onSameLine = event.clientY >= nodeRect.top - 4 && event.clientY <= nodeRect.bottom + 4;
  const justAfterMath = event.clientX >= nodeRect.right && event.clientX <= nodeRect.right + 64;
  if (!onSameLine || !justAfterMath) {
    return false;
  }

  event.preventDefault();
  const ownerWindow = view.dom.ownerDocument.defaultView ?? window;
  const anchor = clampTextSelectionPositionForView(view, startPosition);
  const startPoint = { x: event.clientX, y: event.clientY };
  let dragged = false;

  const dispatchSelection = (clientX: number, clientY: number) => {
    const head = getTextSelectionPositionAtClientPointForView(view, clientX, clientY);
    if (head === null) {
      return;
    }
    view.focus();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, head)).scrollIntoView());
  };

  const handleMouseMove = (moveEvent: globalThis.MouseEvent) => {
    const moved =
      Math.abs(moveEvent.clientX - startPoint.x) > INLINE_MATH_DRAG_SELECTION_THRESHOLD_PX ||
      Math.abs(moveEvent.clientY - startPoint.y) > INLINE_MATH_DRAG_SELECTION_THRESHOLD_PX;
    if (!moved) {
      return;
    }
    dragged = true;
    moveEvent.preventDefault();
    dispatchSelection(moveEvent.clientX, moveEvent.clientY);
  };

  const handleMouseUp = (upEvent: globalThis.MouseEvent) => {
    ownerWindow.removeEventListener("mousemove", handleMouseMove);
    upEvent.preventDefault();
    if (dragged) {
      dispatchSelection(upEvent.clientX, upEvent.clientY);
      return;
    }
    view.focus();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor)));
  };

  ownerWindow.addEventListener("mousemove", handleMouseMove);
  ownerWindow.addEventListener("mouseup", handleMouseUp, { once: true });
  return true;
}

function findAdjacentInlineMath(
  editor: NodeViewProps["editor"],
  position: number,
  nodeSize: number,
  direction: "after" | "before",
): { id: string } | null {
  if (editor.isDestroyed) {
    return null;
  }

  const targetPosition = direction === "after" ? position + nodeSize : position;
  if (direction === "after") {
    const nodeAfter = editor.state.doc.nodeAt(targetPosition);
    const id = nodeAfter?.type.name === "mathInline" ? nodeAfter.attrs.id : null;
    return typeof id === "string" && id ? { id } : null;
  }

  const $position = editor.state.doc.resolve(targetPosition);
  const nodeBefore = $position.nodeBefore;
  const id = nodeBefore?.type.name === "mathInline" ? nodeBefore.attrs.id : null;
  if (!nodeBefore || typeof id !== "string" || !id) {
    return null;
  }

  return { id };
}

function focusTextSelection(editor: NodeViewProps["editor"], position: number) {
  const applyTextSelection = () => {
    if (editor.isDestroyed) {
      return;
    }

    editor
      .chain()
      .focus()
      .setTextSelection(clampTextSelectionPosition(editor, position))
      .run();
  };

  applyTextSelection();
  window.requestAnimationFrame(applyTextSelection);
}

function getTextSelectionPositionAtClientPoint(editor: NodeViewProps["editor"], clientX: number, clientY: number): number | null {
  return getTextSelectionPositionAtClientPointForView(editor.view, clientX, clientY);
}

function getTextSelectionPositionAtClientPointForView(view: EditorView, clientX: number, clientY: number): number | null {
  const rect = view.dom.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }

  const left = clamp(clientX, rect.left + 1, rect.right - 1);
  const top = clamp(clientY, rect.top + 1, rect.bottom - 1);
  const position = view.posAtCoords({ left, top })?.pos;
  return typeof position === "number" ? clampTextSelectionPositionForView(view, position) : null;
}

function deleteBackwardFromTextSelection(editor: NodeViewProps["editor"], position: number) {
  window.requestAnimationFrame(() => {
    if (editor.isDestroyed) {
      return;
    }

    const selectionPosition = clampTextSelectionPosition(editor, position);
    const { state, view } = editor;
    const $position = state.doc.resolve(selectionPosition);
    const textBefore = $position.nodeBefore?.isText ? $position.nodeBefore.text ?? "" : "";
    view.focus();

    if (textBefore) {
      const previousCharacter = Array.from(textBefore).at(-1);
      const deleteFrom = selectionPosition - (previousCharacter?.length ?? 1);
      view.dispatch(state.tr.delete(deleteFrom, selectionPosition).scrollIntoView());
      return;
    }

    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, selectionPosition)));
    chainCommands(deleteSelection, joinBackward, selectNodeBackward)(view.state, view.dispatch, view);
  });
}

function deleteInlineMathNode(editor: NodeViewProps["editor"], position: number, nodeSize: number) {
  window.requestAnimationFrame(() => {
    if (editor.isDestroyed) {
      return;
    }

    const from = clampTextSelectionPosition(editor, position);
    const to = Math.min(from + nodeSize, editor.state.doc.content.size);
    const { state, view } = editor;
    const transaction = state.tr.delete(from, to);
    const selectionPosition = Math.min(from, transaction.doc.content.size);
    view.focus();
    view.dispatch(
      transaction
        .setSelection(TextSelection.create(transaction.doc, selectionPosition))
        .scrollIntoView(),
    );
  });
}

function isEmptyInlineMathTex(tex: string): boolean {
  return tex.trim().length === 0;
}

function clampTextSelectionPosition(editor: NodeViewProps["editor"], position: number): number {
  return clampTextSelectionPositionForView(editor.view, position);
}

function clampTextSelectionPositionForView(view: EditorView, position: number): number {
  return Math.max(0, Math.min(position, view.state.doc.content.size));
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

function updateInlineMathNodeTex(editor: NodeViewProps["editor"], id: string, tex: string): boolean {
  if (!id || editor.isDestroyed) {
    return false;
  }

  let matchAttrs: Record<string, unknown> | null = null;
  let matchPos = -1;
  editor.state.doc.descendants((childNode, pos) => {
    if (childNode.type.name === "mathInline" && childNode.attrs.id === id) {
      matchAttrs = childNode.attrs;
      matchPos = pos;
      return false;
    }

    return true;
  });

  if (!matchAttrs || matchPos < 0) {
    return false;
  }

  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(matchPos, undefined, {
      ...(matchAttrs as Record<string, unknown>),
      tex,
    }),
  );
  return true;
}

function findInlineMathBlockId(editor: NodeViewProps["editor"], id: string): string | undefined {
  if (!id || editor.isDestroyed) {
    return undefined;
  }

  let blockId: string | undefined;
  editor.state.doc.descendants((childNode, _pos, parentNode) => {
    if (childNode.type.name !== "mathInline" || childNode.attrs.id !== id) {
      return true;
    }

    const parentId = parentNode?.attrs.sigmaDocId;
    blockId = typeof parentId === "string" ? parentId : undefined;
    return false;
  });
  return blockId;
}

export function extractSingleInlineMathText(text: string): string | null {
  const match = text.trim().match(SINGLE_INLINE_MATH_TEXT);
  return match?.[1]?.trim() || null;
}

export function refreshMathInlineIdsInSlice(slice: Slice): Slice {
  return new Slice(refreshMathInlineIdsInFragment(slice.content), slice.openStart, slice.openEnd);
}

function refreshMathInlineIdsInFragment(fragment: Fragment): Fragment {
  const nodes: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    nodes.push(refreshMathInlineIdsInNode(node));
  });
  return Fragment.fromArray(nodes);
}

function refreshMathInlineIdsInNode(node: ProseMirrorNode): ProseMirrorNode {
  const content = node.content.size > 0 ? refreshMathInlineIdsInFragment(node.content) : node.content;
  if (node.type.name === "mathInline") {
    return node.type.create(
      {
        ...node.attrs,
        id: createId("m_inline"),
      },
      content,
      node.marks,
    );
  }

  return content === node.content ? node : node.copy(content);
}

function shouldInsertClosedBlockSliceAfterCurrentBlock(slice: Slice): boolean {
  return (
    slice.openStart === 0 &&
    slice.openEnd === 0 &&
    slice.content.childCount > 0 &&
    Boolean(slice.content.firstChild?.isBlock)
  );
}

function topLevelInsertPosition($from: ResolvedPos): number {
  return $from.depth > 0 ? $from.after(1) : $from.pos;
}

function sliceHasMathInline(slice: Slice): boolean {
  return fragmentHasMathInline(slice.content);
}

function fragmentHasMathInline(fragment: Fragment): boolean {
  let hasMath = false;
  fragment.forEach((node) => {
    if (!hasMath && nodeHasMathInline(node)) {
      hasMath = true;
    }
  });
  return hasMath;
}

function nodeHasMathInline(node: ProseMirrorNode): boolean {
  return node.type.name === "mathInline" || (node.content.size > 0 && fragmentHasMathInline(node.content));
}

export function sliceTextForClipboard(slice: Slice): string {
  return fragmentTextForClipboard(slice.content);
}

function fragmentTextForClipboard(fragment: Fragment): string {
  let text = "";
  let previousWasBlock = false;
  fragment.forEach((node) => {
    const nodeText = nodeTextForClipboard(node);
    if (!nodeText) {
      return;
    }
    if (text && (previousWasBlock || node.isBlock)) {
      text += "\n";
    }
    text += nodeText;
    previousWasBlock = node.isBlock;
  });
  return text;
}

function nodeTextForClipboard(node: ProseMirrorNode): string {
  if (node.isText) {
    return node.text ?? "";
  }

  if (node.type.name === "mathInline") {
    return `$${String(node.attrs.tex ?? "")}$`;
  }

  if (node.content.size === 0) {
    return "";
  }

  return fragmentTextForClipboard(node.content);
}
