import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

import type { BoxFrameSpec } from "@/features/document";
import { boxFrameHasSubtitle, resolveBoxFrame } from "@/lib/box-blocks";
import { createTranslator, getAppLocale } from "@/lib/i18n";

/**
 * 2 欄の見出し (`titleSplit`) の境界つまみ。段組みの列の境界と同じく、ドラッグで 2 欄の幅の比を変える。
 *
 * ドラッグ中は箱の CSS 変数だけを書き換え (文書は触らない)、離した 1 回だけ `subtitleShare` を
 * 箱の枠へ書き戻す。つまみは見た目の左右 (`order`) に関わらず境界の位置に立つので、
 * ここで「ポインタの位置 → 左の欄の割合 → サブタイトルの割合」と向きを解く。
 */

const MIN_SHARE = 0.05;
const MAX_SHARE = 0.95;
const KEY_STEP = 0.01;
const KEY_STEP_LARGE = 0.05;

export const boxSplitHandleKey = new PluginKey("boxSplitHandle");

type SplitOrder = "subtitleFirst" | "titleFirst";

/** ポインタの位置 (内容の左端からの px) から、左の欄が見出し幅に占める割合を決める。 */
export function resolveFirstCellShare(input: {
  pointerX: number;
  contentWidth: number;
  gapPx: number;
}): number {
  const usable = Math.max(1, input.contentWidth - input.gapPx);
  const raw = (input.pointerX - input.gapPx / 2) / usable;
  return Math.round(Math.min(MAX_SHARE, Math.max(MIN_SHARE, raw)) * 100) / 100;
}

/** 左の欄の割合を、保存する `subtitleShare` (サブタイトルの割合) へ直す。 */
export function subtitleShareFromFirstShare(firstShare: number, order: SplitOrder): number {
  const share = order === "subtitleFirst" ? firstShare : 1 - firstShare;
  return Math.round(Math.min(MAX_SHARE, Math.max(MIN_SHARE, share)) * 100) / 100;
}

function firstShareOf(subtitleShare: number, order: SplitOrder): number {
  return order === "subtitleFirst" ? subtitleShare : 1 - subtitleShare;
}

interface SplitState {
  boxPos: number;
  node: ProseMirrorNode;
  order: SplitOrder;
  gapPx: number;
  subtitleShare: number;
}

function readSplitState(view: EditorView, getPos: () => number | undefined): SplitState | null {
  const position = getPos();
  if (position === undefined) {
    return null;
  }
  const $pos = view.state.doc.resolve(position);
  const node = $pos.parent;
  if (node.type.name !== "boxBlock") {
    return null;
  }
  const styleId = typeof node.attrs.styleId === "string" ? node.attrs.styleId : "fancybox";
  const frame = resolveBoxFrame({
    styleId,
    frame: node.attrs.frame && typeof node.attrs.frame === "object" ? node.attrs.frame as BoxFrameSpec : undefined,
  });
  const split = frame.decorations?.find((decoration) => decoration.type === "titleSplit");
  if (!split || split.type !== "titleSplit") {
    return null;
  }
  return {
    boxPos: $pos.before(),
    node,
    order: split.order ?? "subtitleFirst",
    gapPx: split.gapPx ?? 0,
    subtitleShare: split.subtitleShare ?? 1 / 6,
  };
}

/** 枠の `titleSplit` だけを差し替えて書き戻す。枠が既定のままの箱も、解決済みの装飾を持たせる。 */
function commitSubtitleShare(view: EditorView, state: SplitState, subtitleShare: number): void {
  if (Math.abs(subtitleShare - state.subtitleShare) < 0.005) {
    return;
  }
  const styleId = typeof state.node.attrs.styleId === "string" ? state.node.attrs.styleId : "fancybox";
  const current = state.node.attrs.frame && typeof state.node.attrs.frame === "object"
    ? state.node.attrs.frame as BoxFrameSpec
    : undefined;
  const resolved = resolveBoxFrame({ styleId, frame: current });
  const decorations = (resolved.decorations ?? []).map((decoration) => (
    decoration.type === "titleSplit" ? { ...decoration, subtitleShare } : decoration
  ));
  view.dispatch(view.state.tr.setNodeMarkup(state.boxPos, undefined, {
    ...state.node.attrs,
    frame: { ...(current ?? {}), decorations },
  }));
}

function createHandle(view: EditorView, getPos: () => number | undefined): HTMLElement {
  const t = createTranslator(getAppLocale(), "editor");
  const handle = document.createElement("button");
  handle.type = "button";
  handle.contentEditable = "false";
  handle.className = "sigma-doc-box-split-handle";
  handle.setAttribute("aria-label", t("box.resizeSplit"));
  handle.title = t("box.resizeSplit");

  // ボタンへ焦点が移ると、エディタの焦点変化に連なる再描画でつまみごと作り直され、ドラッグが途切れる。
  handle.addEventListener("mousedown", (event) => event.preventDefault());

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    const state = readSplitState(view, getPos);
    const content = handle.parentElement;
    if (!state || !content) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const rect = content.getBoundingClientRect();
    const scale = content.offsetWidth > 0 && rect.width > 0 ? rect.width / content.offsetWidth : 1;
    let firstShare = firstShareOf(state.subtitleShare, state.order);
    handle.setPointerCapture(event.pointerId);
    handle.dataset.dragging = "true";

    // ドラッグ中に動かすのはつまみだけ。箱の DOM (style) を書き換えると ProseMirror が箱を描き直し、
    // つまみごと作り直されてポインタを見失う。欄の幅は離したときの 1 回の書き込みで変わる。
    const onMove = (moveEvent: PointerEvent) => {
      firstShare = resolveFirstCellShare({
        pointerX: (moveEvent.clientX - rect.left) / scale,
        contentWidth: content.offsetWidth,
        gapPx: state.gapPx,
      });
      handle.style.left = `${firstShare * (content.offsetWidth - state.gapPx) + state.gapPx / 2}px`;
    };
    const finish = (commit: boolean) => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onCancel);
      delete handle.dataset.dragging;
      handle.style.removeProperty("left");
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
      const latest = readSplitState(view, getPos);
      if (commit && latest) {
        commitSubtitleShare(view, latest, subtitleShareFromFirstShare(firstShare, latest.order));
      }
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onCancel);
  });

  handle.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    const state = readSplitState(view, getPos);
    if (!state) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const nextFirst = firstShareOf(state.subtitleShare, state.order) + (event.key === "ArrowRight" ? step : -step);
    commitSubtitleShare(view, state, subtitleShareFromFirstShare(nextFirst, state.order));
  });

  return handle;
}

/** サブタイトル欄を持つ箱ごとに、欄のすぐ後ろへ境界つまみを 1 つ置く。 */
export function createBoxSplitHandlePlugin(): Plugin {
  return new Plugin({
    key: boxSplitHandleKey,
    props: {
      decorations: (state) => {
        const decorations: Decoration[] = [];
        state.doc.descendants((node, pos) => {
          if (node.isTextblock) {
            return false;
          }
          if (node.type.name !== "boxBlock") {
            return true;
          }
          const title = node.firstChild;
          const subtitle = node.maybeChild(1);
          const styleId = typeof node.attrs.styleId === "string" ? node.attrs.styleId : "fancybox";
          const frame = resolveBoxFrame({
            styleId,
            frame: node.attrs.frame && typeof node.attrs.frame === "object" ? node.attrs.frame as BoxFrameSpec : undefined,
          });
          if (title && subtitle?.type.name === "boxBlockSubtitle" && boxFrameHasSubtitle(frame)) {
            decorations.push(Decoration.widget(
              pos + 1 + title.nodeSize + subtitle.nodeSize,
              (view, getPos) => createHandle(view, getPos),
              {
                key: `box-split-handle:${String(node.attrs.sigmaDocId)}`,
                side: -1,
                stopEvent: () => true,
                ignoreSelection: true,
              },
            ));
          }
          return true;
        });
        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}
