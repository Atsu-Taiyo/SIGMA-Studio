import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

import { countDecorationBlockWalk } from "./decoration-walk-metrics";
import type { TextContentReservation } from "@/features/text-editing";
import { resolveEditGuardSpans, transactionTouchesEditGuardSpans } from "./edit-guard-ranges";

/**
 * A semantic fragment inside a guarded text-flow block. The contract is
 * intentionally editor-owned: features may highlight a whole block, an exact
 * text range, or one inline-math atom without coupling the editor to the
 * feature that requested the guard.
 */
export type TextFlowGuardHighlightScope =
  | { kind: "block"; blockId: string }
  | { kind: "text"; blockId: string; from: number; to: number }
  | { kind: "inlineMath"; blockId: string; mathInlineId: string };

export interface TextFlowEditGuardPresentation {
  highlightedBlockClassName: string;
  partialBlockClassName?: string;
  readOnlyBlockClassName: string;
  characterClassName: string;
  atomClassName: string;
  characterIndexCssProperty?: string;
}

export interface TextFlowEditGuardAction {
  label: string;
  busyLabel: string;
  failureTitle: string;
  buttonClassName: string;
  iconClassName?: string;
  title?: string;
  request: () => Promise<{ ok: boolean }>;
}

/**
 * Feature-neutral editing policy for one SigmaDoc text-flow block.
 *
 * `guardId` groups several blocks that share one action. Only the primary
 * block receives the action widget; when it disappears, the first surviving
 * guarded block is promoted so the user never loses the escape hatch.
 */
export interface TextFlowEditGuard {
  blockId: string;
  guardId: string;
  isPrimaryActionTarget: boolean;
  blockedMessage: string;
  presentation: TextFlowEditGuardPresentation;
  highlight: boolean;
  highlightScopes?: readonly TextFlowGuardHighlightScope[];
  /** Omitted reserves the whole block; otherwise only these fragments are read-only. */
  contentReservations?: readonly TextContentReservation[];
  action?: TextFlowEditGuardAction;
}

export interface TextFlowEditPolicy {
  guards: readonly TextFlowEditGuard[];
  /** Applies a read-only guard to every block rendered by this editor. */
  lockAll?: Omit<TextFlowEditGuard, "blockId" | "isPrimaryActionTarget">;
}

interface EditGuardOptions {
  getGuards: () => ReadonlyMap<string, TextFlowEditGuard>;
  onBlockedAttempt: (blockId: string) => void;
}

export const editGuardKey = new PluginKey("textFlowEditGuard");

export const EditGuardExtension = Extension.create<EditGuardOptions>({
  name: "textFlowEditGuard",

  addOptions() {
    return {
      getGuards: () => new Map(),
      onBlockedAttempt: () => {},
    };
  },

  addProseMirrorPlugins() {
    const getGuards = () => this.options.getGuards();
    const onBlockedAttempt = (blockId: string) => this.options.onBlockedAttempt(blockId);
    return [
      new Plugin({
        key: editGuardKey,
        props: {
          decorations: (state) => createEditGuardDecorations(state.doc, getGuards()),
        },
        filterTransaction: (transaction, state) => {
          // `setContent(..., { emitUpdate: false })` marks canonical SigmaDoc -> editor view
          // synchronization with `preventUpdate`. It is not a user edit and must cross the guard;
          // otherwise applying one proposal while another proposal still locks the same block
          // updates SigmaDoc but leaves the derived Tiptap view permanently stale.
          if (!transaction.docChanged || transaction.getMeta("preventUpdate")) {
            return true;
          }
          const guards = getGuards();
          if (guards.size === 0) {
            return true;
          }
          const wholeBlockIds = new Set([...guards].filter(([, guard]) => !guard.contentReservations).map(([id]) => id));
          const touched = findTouchedGuardedBlockIds(state.doc, transaction.doc, wholeBlockIds);
          state.doc.forEach((node, offset) => {
            const id = node.attrs.sigmaDocId;
            const guard = guards.get(id);
            if (!guard?.contentReservations) return;
            const spans = resolveEditGuardSpans(node, offset + 1, guard.contentReservations);
            const nextNode = collectTopLevelBlocksById(transaction.doc, new Set([id])).get(id);
            if (!spans || !nextNode || node.type !== nextNode.type
              || JSON.stringify(node.attrs) !== JSON.stringify(nextNode.attrs)
              || transactionTouchesEditGuardSpans(transaction, spans)) touched.push(id);
          });
          if (touched.length === 0) {
            return true;
          }
          onBlockedAttempt(touched[0]);
          return false;
        },
      }),
    ];
  },
});

/**
 * 編集ガード装飾の再 dispatch を値で判定するためのキー。
 *
 * ガード表は `editPolicy` と表示中のブロック ID から打鍵のたびに組み直されるので、
 * Map の識別子で比べると打鍵 × ユニット数だけ装飾更新の transaction が飛ぶ。装飾は
 * `props.decorations` が最新のガードを毎回読むので、見た目を決める値だけを拾えばよい
 * (`action.request` の識別子は見た目に出ないので入れない)。
 */
export function getTextFlowEditGuardsSyncKey(
  guards: ReadonlyMap<string, TextFlowEditGuard>,
): string {
  if (guards.size === 0) {
    return "";
  }
  // 区切り文字での連結ではなく JSON: 値 (blockedMessage やアクションのラベル) に区切り文字が
  // 混じっても別のガード集合と同じキーにならない。並びは装飾側の走査順そのもの。
  return JSON.stringify([...guards.values()].map(getEditGuardSyncValue));
}

function getEditGuardSyncValue(guard: TextFlowEditGuard): unknown[] {
  return [
    guard.blockId,
    guard.guardId,
    guard.isPrimaryActionTarget,
    guard.highlight,
    guard.blockedMessage,
    // undefined (ブロック全体) と [] (範囲指定なし) は装飾が変わるので区別する。
    guard.highlightScopes?.map(getGuardHighlightScopeSyncValue) ?? null,
    guard.contentReservations ?? null,
    guard.action
      ? [
          guard.action.label,
          guard.action.busyLabel,
          guard.action.failureTitle,
          guard.action.buttonClassName,
          guard.action.iconClassName ?? null,
          guard.action.title ?? null,
        ]
      : null,
    [
      guard.presentation.highlightedBlockClassName,
      guard.presentation.partialBlockClassName ?? null,
      guard.presentation.readOnlyBlockClassName,
      guard.presentation.characterClassName,
      guard.presentation.atomClassName,
      guard.presentation.characterIndexCssProperty ?? null,
    ],
  ];
}

function getGuardHighlightScopeSyncValue(scope: TextFlowGuardHighlightScope): unknown[] {
  switch (scope.kind) {
    case "block":
      return [scope.kind, scope.blockId];
    case "text":
      return [scope.kind, scope.blockId, scope.from, scope.to];
    case "inlineMath":
      return [scope.kind, scope.blockId, scope.mathInlineId];
  }
}

export function refreshEditGuardDecorations(view: EditorView | null | undefined): void {
  if (!view) {
    return;
  }
  view.dispatch(view.state.tr.setMeta(editGuardKey, Date.now()));
}

export function createEditGuardDecorations(
  doc: ProseMirrorNode,
  guards: ReadonlyMap<string, TextFlowEditGuard>,
): DecorationSet {
  if (guards.size === 0) {
    return DecorationSet.empty;
  }

  const decorations: Decoration[] = [];
  const existingBlockIds = new Set<string>();
  countDecorationBlockWalk();
  doc.forEach((node) => {
    const id = typeof node.attrs?.sigmaDocId === "string" ? node.attrs.sigmaDocId : null;
    if (id) {
      existingBlockIds.add(id);
    }
  });

  const actionHostByGuardId = new Map<string, string>();
  for (const guard of guards.values()) {
    if (guard.action && guard.isPrimaryActionTarget && existingBlockIds.has(guard.blockId)) {
      actionHostByGuardId.set(guard.guardId, guard.blockId);
    }
  }
  for (const guard of guards.values()) {
    if (guard.action && !actionHostByGuardId.has(guard.guardId) && existingBlockIds.has(guard.blockId)) {
      actionHostByGuardId.set(guard.guardId, guard.blockId);
    }
  }

  doc.forEach((node, offset) => {
    const id = typeof node.attrs?.sigmaDocId === "string" ? node.attrs.sigmaDocId : null;
    if (!id) {
      return;
    }
    const guard = guards.get(id);
    if (!guard) {
      return;
    }

    const protectedSpans = guard.contentReservations
      ? resolveEditGuardSpans(node, offset + 1, guard.contentReservations) : null;
    const partialLock = protectedSpans !== null;
    const partialHighlight = guard.highlight
      && guard.highlightScopes !== undefined
      && !guard.highlightScopes.some((scope) => scope.kind === "block");
    const nodeClassName = guard.highlight
      ? [guard.presentation.highlightedBlockClassName, partialHighlight ? guard.presentation.partialBlockClassName : null]
          .filter(Boolean)
          .join(" ")
      : guard.presentation.readOnlyBlockClassName;
    decorations.push(
      Decoration.node(offset, offset + node.nodeSize, {
        class: nodeClassName,
        "data-edit-guard-id": guard.guardId,
        ...(partialLock ? {} : { contenteditable: "false", "aria-readonly": "true" }),
      }),
    );

    const contentFrom = offset + 1;
    if (partialLock) {
      for (const span of protectedSpans) {
        decorations.push(Decoration.inline(span.from, span.to, {
          "data-edit-guard-id": guard.guardId,
          "data-edit-guard-range": "true",
          "aria-readonly": "true",
        }));
      }
    }
    if (guard.highlight) {
      const allSpans = collectEditGuardHighlightSpans(node, contentFrom, partialLock ? undefined : guard.highlightScopes);
      const overlaps = (span: { from: number; to: number }) => protectedSpans?.some((range) => span.from < range.to && span.to > range.from);
      const spans = partialLock ? {
        charSpans: allSpans.charSpans.flatMap((span) => protectedSpans.flatMap((range) => {
          const from = Math.max(span.from, range.from);
          const to = Math.min(span.to, range.to);
          return from < to ? [{ ...span, from, to }] : [];
        })),
        atomSpans: allSpans.atomSpans.filter(overlaps),
      } : allSpans;
      for (const span of spans.charSpans) {
        const cssProperty = guard.presentation.characterIndexCssProperty ?? "--edit-guard-char-i";
        decorations.push(
          Decoration.inline(span.from, span.to, {
            class: guard.presentation.characterClassName,
            style: `${cssProperty}:${span.charIndex}`,
          }),
        );
      }
      for (const atom of spans.atomSpans) {
        decorations.push(Decoration.inline(atom.from, atom.to, {
          class: guard.presentation.atomClassName,
          "data-edit-guard-atom": "true",
        }));
      }
    }

    if (guard.action && actionHostByGuardId.get(guard.guardId) === id) {
      decorations.push(
        Decoration.widget(
          contentFrom,
          (view, getPos) => createEditGuardActionButton(guard, {
            onAccepted: () => {
              const pos = getPos();
              if (typeof pos === "number") {
                focusTextFlowPositionAfterGuardAction(view, pos);
              }
            },
          }),
          { side: -1, ignoreSelection: true, key: `edit-guard-action-${id}-${guard.guardId}` },
        ),
      );
    }
  });

  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

export type EditGuardActionState =
  | { status: "idle" }
  | { status: "busy" }
  | { status: "error" };

export async function handleEditGuardAction(
  currentState: EditGuardActionState,
  action: Pick<TextFlowEditGuardAction, "request">,
  callbacks: { onAccepted?: () => void } = {},
): Promise<EditGuardActionState> {
  if (currentState.status === "busy") {
    return currentState;
  }
  try {
    const result = await action.request();
    if (result.ok) {
      callbacks.onAccepted?.();
      return { status: "busy" };
    }
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}

export function createEditGuardActionButton(
  guard: TextFlowEditGuard,
  callbacks: { onAccepted?: () => void } = {},
): HTMLButtonElement {
  const action = guard.action;
  if (!action) {
    throw new Error("An edit-guard action button requires guard.action");
  }

  const button = document.createElement("button");
  button.type = "button";
  button.className = action.buttonClassName;
  button.contentEditable = "false";
  button.dataset.blockId = guard.blockId;
  button.dataset.guardId = guard.guardId;
  const label = document.createElement("span");
  button.append(label);
  if (action.iconClassName) {
    const icon = document.createElement("span");
    icon.className = action.iconClassName;
    icon.setAttribute("aria-hidden", "true");
    button.append(icon);
  }

  let state: EditGuardActionState = { status: "idle" };
  const render = () => {
    button.disabled = state.status === "busy";
    label.textContent = state.status === "busy" ? action.busyLabel : action.label;
    const title = state.status === "error" ? action.failureTitle : action.title ?? action.label;
    button.title = title;
    button.setAttribute("aria-label", title);
  };
  render();

  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void handleEditGuardAction(state, action, callbacks).then((nextState) => {
      state = nextState;
      render();
    });
  });
  return button;
}

/** Above this size, the remaining text uses one shared animation span. */
export const EDIT_GUARD_MAX_ANIMATED_CHARS = 500;

export interface EditGuardHighlightSpans {
  charSpans: Array<{ from: number; to: number; charIndex: number }>;
  atomSpans: Array<{ from: number; to: number }>;
}

export function collectEditGuardHighlightSpans(
  blockNode: ProseMirrorNode,
  contentFrom: number,
  scopes?: readonly TextFlowGuardHighlightScope[],
): EditGuardHighlightSpans {
  const charSpans: EditGuardHighlightSpans["charSpans"] = [];
  const atomSpans: EditGuardHighlightSpans["atomSpans"] = [];
  let charIndex = 0;
  let overflowSpan: EditGuardHighlightSpans["charSpans"][number] | null = null;
  let plainTextOffset = 0;
  const wholeBlock = scopes === undefined || scopes.some((scope) => scope.kind === "block");
  const textScopes = scopes?.filter((scope): scope is Extract<TextFlowGuardHighlightScope, { kind: "text" }> => (
    scope.kind === "text"
  )) ?? [];
  const inlineMathIds = new Set(scopes
    ?.filter((scope): scope is Extract<TextFlowGuardHighlightScope, { kind: "inlineMath" }> => scope.kind === "inlineMath")
    .map((scope) => scope.mathInlineId) ?? []);
  const overlapsTextScope = (from: number, to: number) => (
    textScopes.some((scope) => Math.max(from, scope.from) < Math.min(to, scope.to))
  );
  const addCharSpan = (from: number, to: number) => {
    if (charIndex < EDIT_GUARD_MAX_ANIMATED_CHARS) {
      charSpans.push({ from, to, charIndex });
      overflowSpan = null;
    } else if (overflowSpan && overflowSpan.to === from) {
      overflowSpan.to = to;
    } else {
      overflowSpan = { from, to, charIndex: EDIT_GUARD_MAX_ANIMATED_CHARS };
      charSpans.push(overflowSpan);
    }
    charIndex += 1;
  };

  blockNode.descendants((node, pos) => {
    const from = contentFrom + pos;
    if (node.isText) {
      const text = node.text ?? "";
      for (let index = 0; index < text.length; index += 1) {
        if (wholeBlock || overlapsTextScope(plainTextOffset + index, plainTextOffset + index + 1)) {
          addCharSpan(from + index, from + index + 1);
        }
      }
      plainTextOffset += text.length;
      return false;
    }
    if (node.isLeaf) {
      const isInlineMath = node.type.name === "mathInline";
      const tex = isInlineMath && typeof node.attrs.tex === "string" ? node.attrs.tex : "";
      const plainLength = isInlineMath ? (tex ? tex.length + 2 : 1) : 0;
      const mathInlineId = isInlineMath && typeof node.attrs.id === "string" ? node.attrs.id : null;
      if (wholeBlock || (isInlineMath && (
        overlapsTextScope(plainTextOffset, plainTextOffset + plainLength)
        || (mathInlineId !== null && inlineMathIds.has(mathInlineId))
      ))) {
        atomSpans.push({ from, to: from + node.nodeSize });
        charIndex += 1;
      }
      plainTextOffset += plainLength;
      return false;
    }
    return true;
  });
  return { charSpans, atomSpans };
}

export function findTouchedGuardedBlockIds(
  oldDoc: ProseMirrorNode,
  newDoc: ProseMirrorNode,
  guardedBlockIds: ReadonlySet<string>,
): string[] {
  if (guardedBlockIds.size === 0 || oldDoc === newDoc) {
    return [];
  }
  const oldOrder = collectTopLevelBlockOrder(oldDoc);
  const newOrder = collectTopLevelBlockOrder(newDoc);
  const oldById = collectTopLevelBlocksById(oldDoc, guardedBlockIds);
  if (oldById.size === 0) {
    return [];
  }
  const newById = collectTopLevelBlocksById(newDoc, guardedBlockIds);
  // 索引で引く。`includes` / `indexOf` は 1 件ごとに並びを舐め直すので、ブロック数の
  // 二乗になる (この関数は全 transaction の filterTransaction から呼ばれる)。
  const newIds = new Set(newOrder);
  const commonIds = new Set(oldOrder.filter((id) => newIds.has(id)));
  const oldCommonOrder = oldOrder.filter((id) => commonIds.has(id));
  const newCommonOrder = newOrder.filter((id) => commonIds.has(id));
  const oldCommonIndex = indexByFirstOccurrence(oldCommonOrder);
  const newCommonIndex = indexByFirstOccurrence(newCommonOrder);
  const touched: string[] = [];
  for (const id of guardedBlockIds) {
    const oldNode = oldById.get(id);
    if (!oldNode) {
      continue;
    }
    const newNode = newById.get(id);
    if (!newNode || !oldNode.eq(newNode)) {
      touched.push(id);
      continue;
    }
    const oldIndex = oldCommonIndex.get(id) ?? -1;
    const newIndex = newCommonIndex.get(id) ?? -1;
    if (
      oldIndex >= 0
      && newIndex >= 0
      && (oldCommonOrder[oldIndex - 1] !== newCommonOrder[newIndex - 1]
        || oldCommonOrder[oldIndex + 1] !== newCommonOrder[newIndex + 1])
    ) {
      touched.push(id);
    }
  }
  return touched;
}

/** `indexOf` と同じ「最初に出てきた位置」を返す索引 (id が重複しても挙動を変えない)。 */
function indexByFirstOccurrence(ids: readonly string[]): Map<string, number> {
  const index = new Map<string, number>();
  ids.forEach((id, position) => {
    if (!index.has(id)) {
      index.set(id, position);
    }
  });
  return index;
}

function collectTopLevelBlockOrder(doc: ProseMirrorNode): string[] {
  const ids: string[] = [];
  doc.forEach((node) => {
    const id = node.attrs?.sigmaDocId;
    if (typeof id === "string" && id) {
      ids.push(id);
    }
  });
  return ids;
}

function collectTopLevelBlocksById(
  doc: ProseMirrorNode,
  ids: ReadonlySet<string>,
): Map<string, ProseMirrorNode> {
  const map = new Map<string, ProseMirrorNode>();
  doc.forEach((node) => {
    const id = node.attrs?.sigmaDocId;
    if (typeof id === "string" && ids.has(id)) {
      map.set(id, node);
    }
  });
  return map;
}

function focusTextFlowPositionAfterGuardAction(view: EditorView, pos: number): void {
  const clamped = Math.max(1, Math.min(pos, view.state.doc.content.size));
  try {
    const selection = TextSelection.near(view.state.doc.resolve(clamped), 1);
    view.dispatch(view.state.tr.setSelection(selection));
  } catch {
    // The document may have changed while the async action was running.
  }
  view.focus();
}
