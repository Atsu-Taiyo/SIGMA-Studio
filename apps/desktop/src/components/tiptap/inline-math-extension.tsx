"use client";

import { mergeAttributes, Node, nodeInputRule, nodePasteRule, type Editor, type JSONContent } from "@tiptap/core";
import { chainCommands, deleteSelection, joinBackward, selectNodeBackward } from "@tiptap/pm/commands";
import { Fragment, Slice, type Node as ProseMirrorNode, type NodeType } from "@tiptap/pm/model";
import { Plugin, TextSelection, type EditorState, type Selection, type Transaction } from "@tiptap/pm/state";
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
import { startAtomPointerSelection } from "@/components/tiptap/atom-pointer-selection";
import { readMathTextFormat, writeMathTextFormat } from "@/lib/math-text-format";
import { registerInlineMathDraftCommit } from "./inline-math-draft-commit";
import { InlineMathTexEditor } from "@/components/tiptap/inline-math-tex-editor";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { readEditorClipboardPayload } from "@/lib/editor-clipboard";
import { createId } from "@/lib/id";
import { countPerformanceEvent } from "@/lib/performance";
import { getInlineMathInputMode, useInlineMathInputMode } from "@/lib/inline-math-mode";
import { boxCommandToInlineNodes, parseTexBoxCommand } from "@/lib/tex-box-command";
import { inlineNodesToTiptapNodes } from "@/lib/tiptap-adapter";
import { MathEnvironmentValueProvider } from "@/features/rendering/adapters/react";
import { mathFieldDefaultMode } from "@/features/rendering/core";
import { getScriptBranchArrowDirection, moveBetweenScriptBranches } from "@/lib/mathlive-script-navigation";
import {
  DEFAULT_MATH_RENDER_ENVIRONMENT,
  type MathRenderEnvironment,
} from "@/lib/math-environment";
import { configureInlineMathLiveField, MATHLIVE_MATH_MODE_SPACE, type InlineMathLiveFieldElement } from "@/lib/mathlive-config";
import { isPhysicsTexCommand, physicsFenceInputTemplate } from "@/lib/physics-tex";
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
  focusMathFractionDenominator,
  getMathfieldLatex,
  getMathKeyboardMathShortcut,
  handleMathKeyboardMathShortcut,
  insertMathKeyboardMathTemplate,
  isMathKeyboardMathModeShortcut,
  isMathKeyboardReturnToTextShortcut,
  type MathKeyboardMathShortcut,
  type MathKeyboardMathfieldLike,
} from "@/lib/math-keyboard-shortcuts";
import type { MathFractionSizing } from "@/features/document";
import {
  holdInlineMathTypeAhead,
  INSERT_INLINE_MATH_TEMPLATE_EVENT,
  isHoldingInlineMathTypeAhead,
  queueInlineMathTemplate,
  releaseInlineMathTypeAhead,
  replayInlineMathTypeAhead,
  toInlineMathTypeAheadKey,
  type InlineMathTypeAheadKey,
  type InsertInlineMathTemplateDetail,
} from "@/components/tiptap/inline-math-type-ahead";
import {
  APPLY_INLINE_MATH_FONT_EVENT,
  applyFontToMathFieldSelection,
  isInlineMathFontMenuElement,
  watchInlineMathFontMenuFocus,
  type ApplyInlineMathFontDetail,
} from "@/components/tiptap/inline-math-font";

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

type InlineMathFieldElement = InlineMathLiveFieldElement & Omit<MathKeyboardMathfieldLike, "getValue"> & {
  // MathLive の範囲指定の値と prompt API (クリックした placeholder に直接入る機能で使う)。
  getValue?: (start?: number, end?: number, format?: "latex") => string;
  getPromptRange?: (id: string) => [number, number] | null;
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
  options: {
    pendingLatexCommandTrigger?: InlineMathLatexCommandTrigger;
    /**
     * キーボードで開くときに渡す。入力欄が焦点を取るまでの打鍵を預かって入力欄へ流す
     * (渡したキーはその先頭に積む)。
     */
    typeAhead?: readonly InlineMathTypeAheadKey[];
  } = {},
) {
  if (!id || typeof window === "undefined") {
    return;
  }

  if (options.typeAhead) {
    holdInlineMathTypeAhead(id, options.typeAhead);
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
  if (options.typeAhead) {
    // どのノードビューも拾わなかった (数式の挿入が止められたなど)。預かったキーを本文へ返す。
    window.setTimeout(() => {
      if (pendingInlineMathEditRequests.get(id) === request) {
        releaseInlineMathTypeAhead(id);
      }
    }, 300);
  }
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

/**
 * `placeholderIndex` 番目の placeholder を選ぶ (数式の中で空欄へ Tab で移ったのと同じ状態)。
 *
 * 空欄に一時 id を振って prompt にすると、MathLive では左右に余白のある枠になり、打った文字が
 * `\placeholder{7}` のまま保存される。なので id は振らず、原子を順に見て空欄の位置を探す。
 */
export function focusInlineMathPlaceholder(
  mathField: InlineMathFieldElement,
  placeholderIndex: number | null,
): boolean {
  if (placeholderIndex === null || typeof mathField.getValue !== "function") {
    return false;
  }

  try {
    const lastOffset = mathField.lastOffset ?? 0;
    let seen = 0;
    for (let offset = 1; offset <= lastOffset; offset += 1) {
      const atom = mathField.getValue(offset - 1, offset, "latex");
      const placeholder = /^\\placeholder(?:\[([^\]]*)\])?\{/.exec(atom);
      if (!placeholder) {
        continue;
      }
      if (seen !== placeholderIndex) {
        seen += 1;
        continue;
      }
      // 名前付きの prompt (`\placeholder[answer]{}`) は、その中身の範囲を選ぶ。
      const promptRange = placeholder[1] ? mathField.getPromptRange?.(placeholder[1]) : null;
      mathField.selection = promptRange ?? { direction: "forward", ranges: [[offset - 1, offset]] };
      return true;
    }
    return false;
  } catch {
    // MathLive can briefly reject selection writes while the custom element mounts.
    return false;
  }
}

/**
 * 中身の入った名前なしの空欄 `\placeholder{x}` を中身 `{x}` に戻す。0.511.0 は本文から押した
 * Ctrl+L・Ctrl+/ や空欄クリックで打った文字をこの形で保存しており、空欄の枠の余白で左右が広がって
 * 見える。名前付きの prompt と空の空欄はそのまま残す。
 */
export function unwrapFilledInlineMathPlaceholders(tex: string): string {
  const marker = "\\placeholder{";
  let result = "";
  let index = 0;
  for (let start = tex.indexOf(marker); start >= 0; start = tex.indexOf(marker, index)) {
    const open = start + marker.length - 1;
    let depth = 0;
    let close = -1;
    for (let cursor = open; cursor < tex.length; cursor += 1) {
      const character = tex[cursor];
      if (character === "\\") {
        cursor += 1;
      } else if (character === "{") {
        depth += 1;
      } else if (character === "}" && --depth === 0) {
        close = cursor;
        break;
      }
    }
    if (close < 0) {
      break;
    }
    const body = tex.slice(open + 1, close);
    result += tex.slice(index, start) + (body.trim() ? `{${unwrapFilledInlineMathPlaceholders(body)}}` : `${marker}}`);
    index = close + 1;
  }
  return result + tex.slice(index);
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
  shortcutKey: InlineMathTypeAheadKey,
  dispatch?: (tr: Transaction) => void,
): boolean {
  if (!canInsertInlineMathAtSelection(state.selection)) {
    return false;
  }

  const id = createId("m_inline");
  const selectedText = state.selection.empty
    ? ""
    : state.doc.textBetween(state.selection.from, state.selection.to, "");
  // 選んだ文字を中身にするショートカット (Ctrl+Alt+2 の二乗) だけは、その式をそのまま作る。
  // それ以外は空の数式を開き、押されたショートカットを入力欄へそのまま流す。本文から押しても
  // 「Ctrl+M で数式に入ってから押した」のと同じ挿入・空欄・キャレットになる。
  const wrapsSelection = Boolean(shortcut.wrapsSelection && selectedText);
  const node = mathInlineType.create({
    id,
    tex: wrapsSelection ? createInlineMathTexFromMathKeyboardShortcut(shortcut, selectedText) : "",
  });
  dispatch?.(state.tr.replaceSelectionWith(node).scrollIntoView());
  requestInlineMathEdit(id, "end", { typeAhead: wrapsSelection ? [] : [shortcutKey] });
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
      .then((result) => {
        if (!result.ok && !result.skipped) {
          // 英語の入力ソースが無い・OS が拒んだなど。数式は全角のまま確定しうる (確定した文字は
          // `mathlive-half-width-input.ts` が半角へ戻す) ので、利用者には出さず開発中だけ記録する。
          warnInputSourceSwitchFailure(result.error);
        }
        return result.ok && result.restoreToken ? result.restoreToken : null;
      })
      .catch((error: unknown) => {
        warnInputSourceSwitchFailure(error);
        return null;
      }),
  };
}

function warnInputSourceSwitchFailure(reason: unknown) {
  if (process.env.NODE_ENV === "production") {
    return;
  }
  console.warn("Failed to switch to the ASCII input source for math editing", reason);
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
  private unregisterDraftCommit: (() => void) | null = null;
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
    this.dom = createInlineMathFrameElement(writeMathTextFormat(this.tex, this.node.marks), {
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
    const previousRenderTex = writeMathTextFormat(this.tex, this.node.marks);
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
    const renderTex = writeMathTextFormat(nextTex, node.marks);
    if (nextTex === this.tex && renderTex === previousRenderTex) {
      // 打鍵で文書が作り直されても、TeX と太字・斜体が同じ数式は DOM を触らない。
      // 例外はロックの付け外し (入力欄が props で受け取っているので描き直しが要る)。
      if (editGuardChanged && this.editing) {
        this.renderEditingField();
      }
      return true;
    }

    countPerformanceEvent("InlineMathNodeView.rerender");
    const texChanged = nextTex !== this.tex;
    this.tex = nextTex;
    this.dom.setAttribute("data-tex", renderTex);
    this.dom.setAttribute("title", renderTex);
    if (this.editing) {
      if (texChanged) this.editingTex = nextTex;
      this.renderEditingField();
    } else if (this.body) {
      setInlineMathBodyTex(this.body, renderTex, { environment: this.mathEnvironment });
    }
    if (this.selected) {
      // 選択中の数式が undo/redo や AI 適用で書き変わったら、数式パネルへ知らせ直す。
      // 知らせないとパネルは古い TeX を編集し続ける (旧 React 版は tex を deps に持っていた)。
      this.dispatchSelection(this.editingTex ?? nextTex);
    }
    return true;
  }

  selectNode(): void {
    this.selected = true;
    this.dom.classList.add("selected");
    const keyboardEditIntent = consumeInlineMathKeyboardEditIntent();
    if (keyboardEditIntent && typeof window !== "undefined") {
      // 矢印キーで入った直後の打鍵は、入力欄ができるまで預かる。本文へ届くと、選択中の
      // この数式ごと打った文字に置き換わってしまう。
      if (!isHoldingInlineMathTypeAhead(this.id)) {
        holdInlineMathTypeAhead(this.id);
      }
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
    this.unregisterDraftCommit?.();
    this.unregisterDraftCommit = null;
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
        getCanonicalTex: (tex = this.editingTex ?? this.tex) => writeMathTextFormat(tex, this.node.marks),
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
      releaseInlineMathTypeAhead(this.id);
      return;
    }
    pendingInlineMathEditRequests.delete(this.id);
    nextTex = unwrapFilledInlineMathPlaceholders(nextTex);
    let template: string | null = null;
    if (!this.editing) {
      this.editing = true;
      // The input steals DOM focus, so retain exactly this atom for formatting
      // rather than a previous paragraph selection or the blurred-block fallback.
      const position = this.getPos();
      if (typeof position === "number" && !this.editor.isDestroyed) {
        this.editor.view.dispatch(this.editor.state.tr.setSelection(
          TextSelection.create(this.editor.state.doc, position, position + this.node.nodeSize),
        ));
      }
      this.inputSourceSession = requestDesktopAsciiInputSource();
      // クリックなどで開いてから入力欄が焦点を取るまでの打鍵も、入力欄へ流す。
      if (!isHoldingInlineMathTypeAhead(this.id)) {
        holdInlineMathTypeAhead(this.id);
      }
      // 数式パレットのテンプレート (`#?` 入り) は空の入力欄に、数式の中でショートカットを押したのと
      // 同じ挿入で入れる。値として渡すと、キャレットが空欄の外 (末尾) に出て枠も追従しない。
      if (nextTex.includes("#?")) {
        template = nextTex;
        queueInlineMathTemplate(this.id, template);
      }
    }
    this.editingTex = template === null ? nextTex : "";
    this.unregisterDraftCommit ??= registerInlineMathDraftCommit(this.editor, () => {
      if (this.editing && !this.editGuarded) this.commitMath(this.editingTex ?? this.tex);
    });
    this.initialCursorPosition = cursorPosition;
    this.initialPlaceholderIndex = options.placeholderIndex ?? null;
    this.initialLatexCommandTrigger = options.pendingLatexCommandTrigger ?? null;
    this.renderEditingField();
    this.dispatchSelection(this.editingTex, cursorPosition === "start" ? 0 : this.editingTex.length);
  }

  private finishEditing(): void {
    if (!this.editing) {
      return;
    }
    this.unregisterDraftCommit?.();
    this.unregisterDraftCommit = null;
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
      setInlineMathBodyTex(this.body, writeMathTextFormat(this.tex, this.node.marks), { environment: this.mathEnvironment });
      return;
    }
    const body = createInlineMathBodyElement(writeMathTextFormat(this.tex, this.node.marks), { environment: this.mathEnvironment });
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
      const body = createInlineMathBodyElement(writeMathTextFormat(editingTex, this.node.marks), { environment: this.mathEnvironment });
      if (typeof body !== "string") {
        this.body = body;
        this.dom.prepend(body);
      }
    }
    if (this.body) {
      setInlineMathBodyTex(this.body, writeMathTextFormat(editingTex, this.node.marks), { environment: this.mathEnvironment });
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
        onInitialFocus={(field) => replayInlineMathTypeAhead(this.id, field)}
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
      setInlineMathBodyTex(this.body, writeMathTextFormat(nextTex, this.node.marks), { environment: this.mathEnvironment });
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

    const startPoint = { x: event.clientX, y: event.clientY };
    const openAtPressedPoint = () => {
      // 押してから離すまでにノードビューが作り直されたら開かない (破棄済みのビューで編集を
      // 始めると、入力ソースを取ったまま返さなくなる)。
      if (!this.dom.isConnected || this.editor.isDestroyed) {
        return;
      }
      // 押した位置に placeholder があれば、そこへ直接入る。静的プレビューは prompt id を
      // 持たないので、序数を編集用の math-field へ持ち越す。
      this.beginEditing(this.tex, "end", {
        placeholderIndex: this.body
          ? getInlineMathPlaceholderIndexAtPoint(this.body, startPoint.x, startPoint.y)
          : null,
      });
    };
    // 本文の連なりの中では、ドラッグを編集面の追跡へ渡す。ここで伸ばすと自分の編集面の中に
    // 閉じ、隣のユニット (問題文・次のチャンク) まで選べない (`atom-pointer-selection.ts`)。
    if (startAtomPointerSelection(this.editor, {
      event,
      from: position,
      to: position + this.node.nodeSize,
      onClick: openAtPressedPoint,
    })) {
      event.stopPropagation();
      return;
    }

    event.preventDefault();
    event.stopPropagation();

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
        openAtPressedPoint();
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
  onInitialFocus,
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
  /** 開いた入力欄へ最初に焦点を渡し、キャレットを置いた直後に 1 回呼ぶ。 */
  onInitialFocus?: (field: HTMLElement) => void;
  onInput: (tex: string, cursor?: number) => void;
  onCancel: () => void;
  onCommit: (tex: string) => void;
  /**
   * 先頭 (空欄を含む) で Backspace を押したとき、数式を確定して手前を消す (本文の数式用)。
   * 渡さなければ先頭の Backspace は何もしない。設定欄のように「手前」が無い入力欄では渡さない
   * (渡すと、全部消した直後の Backspace で入力欄が閉じ、続けて打った文字がどこにも入らない)。
   */
  onDeleteBackwardFromStart?: (tex: string) => void;
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
        onInitialFocus={onInitialFocus}
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
      onInitialFocus={onInitialFocus}
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
  onInitialFocus,
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
  onInitialFocus?: (field: HTMLElement) => void;
  onInput: (tex: string, cursor?: number) => void;
  onCancel: () => void;
  onCommit: (tex: string) => void;
  onDeleteBackwardFromStart?: (tex: string) => void;
  onReturnToTextAfter: (tex: string) => void;
  onReturnToTextBefore: (tex: string) => void;
  onPointerDown: (event: PointerEvent) => void;
  onMouseDown: (event: ReactMouseEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const onInputRef = useRef(onInput);
  const onInitialFocusRef = useRef(onInitialFocus);
  const draftTexRef = useRef(tex);
  const committedRef = useRef(false);
  const commandReferenceOpenRef = useRef(false);
  const armedEdgeRef = useRef<"left" | "right" | null>(null);
  const [draftTex, setDraftTex] = useState(tex);

  useEffect(() => {
    onInputRef.current = onInput;
    onInitialFocusRef.current = onInitialFocus;
  }, [onInitialFocus, onInput]);

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
    // Select-all can arrive through accessibility or a native edit action
    // before any pointer/key/change event. A delayed initial-focus retry must
    // preserve that selection rather than turn replacement input into append.
    if (input.selectionStart !== input.selectionEnd) {
      userInteractedRef.current = true;
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

  // textarea は `autoFocus` で焦点を取ることが多い (下の予約より先に、popover の中へ後から現れる)。
  // どちらの経路でも、最初に焦点が入ったときに 1 回だけ知らせる。
  const initialFocusNotifiedRef = useRef(false);
  const notifyInitialFocus = useCallback((input: HTMLTextAreaElement) => {
    if (initialFocusNotifiedRef.current || locked) {
      return;
    }
    initialFocusNotifiedRef.current = true;
    onInitialFocusRef.current?.(input);
  }, [locked]);

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
      notifyInitialFocus(input);
    };

    focusFrame = window.requestAnimationFrame(focusInput);
    focusTimeout = window.setTimeout(focusInput, 50);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.clearTimeout(focusTimeout);
    };
  }, [applyInitialCaret, locked, notifyInitialFocus]);

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

  // 数式パレットのテンプレートは、Ctrl のショートカット (`insertTexAtSelection`) と同じ挿入で入れる。
  useEffect(() => {
    const handleTemplate = (event: Event) => {
      const input = inputRef.current;
      if (!input || event.target !== input || locked) {
        return;
      }
      event.preventDefault();
      markUserInteraction();
      const change = insertInlineMathTexAtSelection(
        input.value,
        input.selectionStart ?? input.value.length,
        input.selectionEnd ?? input.selectionStart ?? input.value.length,
        (event as CustomEvent<InsertInlineMathTemplateDetail>).detail.tex,
      );
      // React の打鍵処理の外 (先打ちの流し込み) から来るので、値を同期で描いてからキャレットを置く。
      // 描く前に次のフレームのキャレット設定が走ると、空の値に置かれて末尾へずれる。
      flushSync(() => applyInlineMathTexChange(change));
    };
    document.addEventListener(INSERT_INLINE_MATH_TEMPLATE_EVENT, handleTemplate);
    return () => document.removeEventListener(INSERT_INLINE_MATH_TEMPLATE_EVENT, handleTemplate);
  }, [applyInlineMathTexChange, locked, markUserInteraction]);

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
      onDeleteBackwardFromStart?.(nextTex);
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
          // textarea は popover の中に後から現れるので、forwardRef 経由の参照が空のことがある。
          // 焦点を得た実物を覚えておく (テンプレートの受け口・確定がこれを使う)。
          inputRef.current = event.currentTarget;
          applyInitialCaret(event.currentTarget);
          notifyInitialFocus(event.currentTarget);
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
          // Cmd/Ctrl+Enter・Escape は「数式を確定して本文へ戻る」操作なので、MathLive 側と同じく
          // キャレットを数式の直後へ置く。
          commit(event.currentTarget, "after");
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

          if (onDeleteBackwardFromStart && shouldDeleteBeforeInlineMathOnBackspace(event, cursorState)) {
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
          commit(event.currentTarget, "after");
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
  onInitialFocus,
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
  onInitialFocus?: (field: HTMLElement) => void;
  onInput: (tex: string, cursor?: number) => void;
  onCancel: () => void;
  onCommit: (tex: string) => void;
  onDeleteBackwardFromStart?: (tex: string) => void;
  onReturnToTextAfter: (tex: string) => void;
  onReturnToTextBefore: (tex: string) => void;
  onPointerDown: (event: PointerEvent) => void;
  onMouseDown: (event: ReactMouseEvent) => void;
  onKeyDown: (event: KeyboardEvent) => void;
}) {
  const fieldId = useId();
  const onInputRef = useRef(onInput);
  const onInitialFocusRef = useRef(onInitialFocus);
  const pendingLatexCommandRef = useRef<PendingInlineMathLatexCommand | null>(null);
  const pendingLatexCommandTimeoutRef = useRef(0);
  const committedRef = useRef(false);
  const armedEdgeRef = useRef<"left" | "right" | null>(null);
  const tabNavigationEventRef = useRef<globalThis.KeyboardEvent | null>(null);
  /** フォントメニューへ焦点が移って確定を待っている間の見張り (`watchInlineMathFontMenuFocus`)。 */
  const stopFontMenuWatchRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    onInputRef.current = onInput;
    onInitialFocusRef.current = onInitialFocus;
  }, [onInitialFocus, onInput]);

  useEffect(() => () => {
    stopFontMenuWatchRef.current?.();
    stopFontMenuWatchRef.current = null;
  }, []);

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
    // `/frac` と打って出した分数も、ショートカットやパレットの分数と同じく分母から入れる。
    if (options.format === "latex") {
      focusMathFractionDenominator(mathField, replacement);
    }
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
    let initialFocusApplied = false;
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
    // 数式パレットのテンプレートは、Ctrl のショートカット (`handleMathKeyboardMathShortcut`) と同じ挿入で入れる。
    const handleMathFieldTemplate = (event: Event) => {
      if (!mathField || locked) {
        return;
      }
      event.preventDefault();
      clearPendingLatexCommand();
      insertMathKeyboardMathTemplate(mathField, (event as CustomEvent<InsertInlineMathTemplateDetail>).detail.tex);
      onInputRef.current(getMathfieldLatex(mathField));
    };
    // ツールバーのフォントを、選んだ範囲だけに付ける (`inline-math-font.ts`)。
    const handleMathFieldFont = (event: Event) => {
      if (!mathField || locked) {
        return;
      }
      const { fontFamily } = (event as CustomEvent<ApplyInlineMathFontDetail>).detail;
      if (!applyFontToMathFieldSelection(mathField, fontFamily)) {
        return;
      }
      event.preventDefault();
      clearPendingLatexCommand();
      onInputRef.current(getMathfieldLatex(mathField));
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

        // TeX ignores space after a control word. Keep a built-in physics
        // command pending until its delimiter arrives, instead of flushing an
        // incomplete command into MathLive on Space.
        if (event.key === " " && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing
          && isPhysicsTexCommand(pendingCommand.text)
          && !mathEnvironment.macroSet.physicsOverrides?.has(pendingCommand.text)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }

        // Physics delimiters need the next token to choose their fence. Resolve
        // the pair here, before MathLive sees an incomplete unknown \qty command.
        // Keep this in the existing key-command path; rewriting an input event's
        // whole field value would reset the caret and interrupt IME composition.
        const physicsTemplate = !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing
          ? physicsFenceInputTemplate(pendingCommand.text, event.key, mathEnvironment.macroSet.physicsOverrides)
          : null;
        if (physicsTemplate) {
          event.preventDefault();
          event.stopImmediatePropagation();
          clearPendingLatexCommand();
          replacePendingLatexCommandDisplay(mathField, pendingCommand, physicsTemplate, { format: "latex" });
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
      mathField.value = normalizeMathTextRuns(tex);
      mathField.addEventListener("input", handleMathFieldInput);
      mathField.addEventListener("blur", handleMathFieldBlur);
      mathField.addEventListener(INSERT_INLINE_MATH_TEMPLATE_EVENT, handleMathFieldTemplate);
      mathField.addEventListener(APPLY_INLINE_MATH_FONT_EVENT, handleMathFieldFont);
      mathField.ownerDocument.addEventListener("keydown", handleMathFieldKeyDown, true);
      const mountedMathField = mathField;
      const focusMathField = () => {
        if (cancelled || locked || initialFocusApplied) {
          return;
        }
        configureInlineMathField(mountedMathField, mathEnvironment);
        mountedMathField.focus({ preventScroll: true });
        if (!focusInlineMathPlaceholder(mountedMathField, initialPlaceholderIndex)) {
          mountedMathField.executeCommand?.(initialCursorPosition === "start" ? "moveToMathfieldStart" : "moveToMathfieldEnd");
        }
        initialFocusApplied = true;
        if (initialLatexCommandTrigger && !initialLatexCommandApplied) {
          initialLatexCommandApplied = true;
          rememberPendingLatexCommand(initialLatexCommandTrigger, mountedMathField);
        }
        onInitialFocusRef.current?.(mountedMathField);
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
      mathField?.removeEventListener(INSERT_INLINE_MATH_TEMPLATE_EVENT, handleMathFieldTemplate);
      mathField?.removeEventListener(APPLY_INLINE_MATH_FONT_EVENT, handleMathFieldFont);
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
      normalizeInlineMathLineBreakInput(mathField ? getMathfieldLatex(mathField) : "", {
        forceLatexCommands: true,
      }),
    );
    if (action === "after") {
      onReturnToTextAfter(nextTex);
    } else if (action === "before") {
      onReturnToTextBefore(nextTex);
    } else if (action === "backspace") {
      onDeleteBackwardFromStart?.(nextTex);
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
      if (event.key === "Tab") {
        tabNavigationEventRef.current = event.nativeEvent;
      }
      // 上付きと下付きを両方持つ原子 (∫_a^b・Σ) の中で ↓/↑ を押すと、上下の枠を行き来する。
      // MathLive は分数と配列でしか動かない (`mathlive-script-navigation.ts`)。MathLive の処理より前に行う。
      const scriptArrow = locked ? null : getScriptBranchArrowDirection({
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        isComposing: event.nativeEvent.isComposing,
        key: event.key,
        keyCode: event.keyCode,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      });
      if (scriptArrow && moveBetweenScriptBranches(event.currentTarget, scriptArrow)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!shouldCommitInlineMathOnKeyDown(event)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      // Enter でも Escape でも、確定したあとはキャレットを数式の直後へ置く。Escape だけ位置を
      // 動かさないと、フォーカスが本文から外れて「数式の直後にキャレットが出ない」状態になる。
      commit(event.currentTarget, "after");
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

      if (onDeleteBackwardFromStart && shouldDeleteBeforeInlineMathOnBackspace(event, mathField)) {
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
      stopFontMenuWatchRef.current?.();
      stopFontMenuWatchRef.current = null;
      // フォントメニューの検索欄へ移っただけなら閉じない。閉じると選んでいた範囲が消え、
      // 検索して選んだフォントを付ける先が無くなる。メニューの外へ出たら、そこで確定する。
      if (isInlineMathFontMenuElement((event as FocusEvent).relatedTarget)) {
        const mathField = event.currentTarget as InlineMathFieldElement;
        stopFontMenuWatchRef.current = watchInlineMathFontMenuFocus(mathField, () => {
          stopFontMenuWatchRef.current = null;
          commit(mathField);
        });
        return;
      }
      const mathField = event.currentTarget as InlineMathFieldElement;
      // Pointer-driven selection can unmount an overlay editor immediately.
      // Preserve its synchronous commit; only defer an active Tab command.
      // A capture-listener microtask can run before MathLive's target listener.
      // The native event stays in a dispatch phase until that listener returns,
      // then becomes NONE without a timer leaking into a later pointer gesture.
      const tabEvent = tabNavigationEventRef.current;
      if (!tabEvent || tabEvent.eventPhase === Event.NONE) {
        commit(mathField);
        return;
      }
      // MathLive's Tab command focuses its next target, then finishes using its
      // model. A synchronous commit here unmounts the field and disposes that
      // model before the command returns (including stopCoalescingUndo).
      queueMicrotask(() => {
        if (mathField.isConnected && mathField.ownerDocument.activeElement !== mathField) commit(mathField);
      });
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

export function insertInlineMathTexAtSelection(
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
  // 命令 (`\pi`・`\leqq`) で終わるときは区切りの空白を足す。足さないと続けて打った文字が
  // `\pix` のように命令名へ繋がり、存在しない命令になる (MathLive 側は原子で入るので起きない)。
  const cleanInsertedTex = insertedTex.replace(/#\?/g, "").replace(/(\\[a-zA-Z]+)$/, "$1 ");
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
    // Wrapping Japanese characters in \text{} changes their mode, not their
    // atom offsets. Keep the cursor inside its box/fraction instead of moving
    // subsequent spaces and characters to the end of the entire formula.
    const selection = nextTex === normalizeMathTextRuns(rawTex) ? mathField.selection : undefined;
    mathField.value = nextTex;
    if (selection !== undefined) {
      mathField.selection = selection;
    } else {
      mathField.executeCommand?.("moveToMathfieldEnd");
    }
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
    const tex = writeMathTextFormat(String(node.attrs.tex ?? ""), node.marks);
    return tex ? `$${tex}$` : "";
  },

  addCommands() {
    return {
      insertMathInline:
        (attrs) =>
        ({ commands }) => {
          const inserted = commands.insertContent(inlineNodesToTiptapNodes([
            { type: "mathInline", id: attrs.id, tex: attrs.tex, display: "inline" },
          ]) as JSONContent[]);

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
              requestInlineMathEdit(id, "end", startsWithRawBackslash ? { typeAhead: [] } : {
                pendingLatexCommandTrigger: "\\",
                typeAhead: [],
              });
              return true;
            }

            const shortcut = getMathKeyboardMathShortcut(event);
            if (shortcut && insertMathKeyboardShortcutInlineMathAtSelection(
              view.state,
              this.type,
              shortcut,
              toInlineMathTypeAheadKey(event),
              view.dispatch,
            )) {
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
            requestInlineMathEdit(id, "end", { typeAhead: [] });
            return true;
          },
          transformPasted: (slice) => refreshMathInlineIdsInSlice(slice),
          // 数式 1 つだけの貼り付け。範囲コピーは本文と同じ payload / HTML で往復するので、ここは
          // 数式単独 (`inlineMath` payload と、プレーンテキストの `$tex$` 1 つ) だけを受ける。
          handlePaste: (view, event) => {
            const clipboardData = event.clipboardData;
            if (!clipboardData) {
              return false;
            }

            const payload = readEditorClipboardPayload(clipboardData);
            const tex = payload?.kind === "inlineMath"
              ? payload.tex
              : extractSingleInlineMathText(clipboardData.getData("text/plain"));
            if (!tex) {
              return false;
            }

            event.preventDefault();
            const node = view.state.schema.nodeFromJSON(inlineNodesToTiptapNodes([
              { type: "mathInline", id: createId("m_inline"), tex, display: "inline" },
            ])[0]);
            view.dispatch(view.state.tr.replaceSelectionWith(node).scrollIntoView());
            return true;
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
    // Viewer HTML carries canonical TeX; editor HTML may already carry marks.
    // Normalize both through the same format reader, preserving unrelated marks.
    const format = readMathTextFormat(String(node.attrs.tex ?? ""));
    let marks = node.marks;
    for (const name of ["bold", "italic"] as const) {
      const type = node.type.schema.marks[name];
      if (format[name] && type) marks = type.create().addToSet(marks);
    }
    const canSplit = (!format.bold || node.type.schema.marks.bold) && (!format.italic || node.type.schema.marks.italic);
    return node.type.create(
      {
        ...node.attrs,
        id: createId("m_inline"),
        tex: canSplit ? format.tex : node.attrs.tex,
      },
      content,
      marks,
    );
  }

  return content === node.content ? node : node.copy(content);
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
    return `$${writeMathTextFormat(String(node.attrs.tex ?? ""), node.marks)}$`;
  }

  if (node.content.size === 0) {
    return "";
  }

  return fragmentTextForClipboard(node.content);
}
