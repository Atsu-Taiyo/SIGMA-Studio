import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

import {
  BOXED_TEXT_CLASS_NAME,
  getEffectiveZoom,
  INLINE_MATH_NODE_VIEW_ATTRIBUTE,
} from "@/features/rendering/adapters";
import {
  computeBoxedRunLineConnections,
  computeBoxedRunLineTargets,
  getBoxedInlineStyleKey,
  hasVisibleInlineText,
  scaleBoxedRunRects,
  type BoxedRunMeasurement,
  type BoxedRunRect,
} from "@/features/rendering/core";

import { countDecorationBlockWalk } from "./decoration-walk-metrics";
import { createSettlingMeasureScheduler } from "./settling-measure-scheduler";

export {
  boxedRunExtraPaddingBottom,
  boxedRunExtraPaddingTop,
  computeBoxedRunLineConnections,
  computeBoxedRunLineTargets,
  splitBoxedRunRectsIntoLines,
  type BoxedRunLineConnection,
  type BoxedRunLineTarget,
  type BoxedRunMeasurement,
  type BoxedRunRect,
} from "@/features/rendering/core";

const BOXED_TEXT_SELECTOR = `.${BOXED_TEXT_CLASS_NAME}`;

const INLINE_CONTAINER_SELECTOR = "p,h1,h2,h3,h4,h5,h6,li";
/** Marks the element a boxed-run height decoration is applied to. */
const HEIGHT_TARGET_ATTRIBUTE = "data-boxed-run-height-target";
const IGNORABLE_ELEMENT_SELECTOR = "img.ProseMirror-separator";
const HEIGHT_TARGET_TOLERANCE_PX = 0.5;
/** Frame edges are drawn, so they are compared far more tightly than heights. */
const RUN_FRAME_EPSILON_PX = 0.02;
/** Segments of one run touch; a bigger horizontal gap means a separate frame. */
const RUN_FRAME_JOIN_TOLERANCE_PX = 1.5;
/** Tops this close belong to the same visual line. */
const RUN_FRAME_LINE_TOLERANCE_PX = 1;
const CSS_PIXEL_PRECISION = 100;
const boxedTextRunHeightPluginKey = new PluginKey<BoxedRunHeightState>("boxedTextRunHeight");

export interface BoxedRunHeightState {
  blockTargets: Record<string, number>;
  inlineTargets: BoxedRunInlineTarget[];
  /** One drawn rectangle per connected run, per container. See `readRenderedRunFrames`. */
  frames: Record<string, BoxedRunFrame[]>;
  /**
   * The document shape each container had when it was measured, keyed exactly like
   * everything else here. This is what makes the measurements above invalidatable:
   * see `reconcileBoxedRunHeightState`.
   */
  signatures: Record<string, string>;
}

/** A frame to draw, in coordinates relative to its container's padding box. */
interface BoxedRunFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  variant: string | null;
  tone: string | null;
}

interface BoxedRunInlineTarget {
  connectLeft: boolean;
  connectRight: boolean;
  /** The container this target was measured in, so it can be invalidated with it. */
  containerKey: string;
  extraPaddingBottom: number;
  extraPaddingTop: number;
  from: number;
  ownHeight: number;
  targetHeight: number;
  to: number;
}

export interface BoxedRunDomTarget {
  element?: HTMLElement;
  from?: number;
  styleKey?: string;
  to?: number;
}

/**
 * Keyed by `sigmaDocId`, which is an unconstrained string in the persisted document
 * (`sigma-doc-schema.ts`). On a plain object a block called `constructor` would make
 * `frames[key]` hand back `Object.prototype.constructor`, and the decoration pass would call
 * `.map` on a function while rendering — the whole editor tree goes with it.
 */
function emptyKeyedRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

const emptyBoxedRunHeightState: BoxedRunHeightState = {
  blockTargets: emptyKeyedRecord(),
  inlineTargets: [],
  frames: emptyKeyedRecord(),
  signatures: emptyKeyedRecord(),
};

export interface BoxedTextRunHeightOptions {
  /**
   * Draw one rectangle per connected run instead of letting each segment paint its own border.
   *
   * Only surfaces whose static twin draws the same rectangle may turn this on. The overlay text
   * shape and table cells swap a Tiptap editor for a static renderer the moment they lose focus,
   * and that renderer has no frame layer — drawing one here would make the box jump on every
   * focus change, which is the divergence this whole area exists to remove. The document body
   * has no static twin (it is always the editor), so it keeps the exact single frame.
   *
   * The split is deliberate and verified, not a gap waiting to be closed: the seamless
   * alternative for the other surfaces — merge a run's pieces into one span and let its own line
   * box be the frame, so nothing has to be measured — was measured end to end and is blocked on
   * the editing surface, because ProseMirror keeps one mark span open only where the mark is
   * equal and every math atom's boxed mark carries `math: true`. `document-surface.css` (above
   * `.boxed-run-framed …`) records the measurements and the full reasoning;
   * `boxed-text-run-height.spec.ts` pins the resulting contract.
   */
  drawRunFrames: boolean;
}

export const BoxedTextRunHeightExtension = Extension.create<BoxedTextRunHeightOptions>({
  name: "boxedTextRunHeight",

  addOptions() {
    return { drawRunFrames: true };
  },

  addProseMirrorPlugins() {
    const { drawRunFrames } = this.options;
    return [
      new Plugin<BoxedRunHeightState>({
        key: boxedTextRunHeightPluginKey,
        state: {
          init: () => emptyBoxedRunHeightState,
          apply: (transaction, previous) => {
            const next = transaction.getMeta(boxedTextRunHeightPluginKey) as BoxedRunHeightState | undefined;
            if (next) {
              return next;
            }
            return transaction.docChanged ? reconcileBoxedRunHeightState(previous, transaction) : previous;
          },
        },
        props: {
          decorations: (state) => {
            const heights = boxedTextRunHeightPluginKey.getState(state) ?? emptyBoxedRunHeightState;
            // 囲みランを 1 つも測っていない = 装飾は 1 つも出ない。囲み文字が無い編集器
            // (ほとんどの編集器がそう) はここで終わり、文書を歩かない。
            if (!hasMeasurements(heights)) {
              return DecorationSet.empty;
            }
            const decorations: Decoration[] = [];

            // 高さ揃えと枠は同じ入れ物 (段落/見出し) に付くので 1 回の走査で両方出す。
            // textblock の中身 (テキスト・数式) は見る必要がないので降りない。
            countDecorationBlockWalk();
            state.doc.descendants((node, pos) => {
              if (node.type.name !== "paragraph" && node.type.name !== "heading") {
                return !node.isTextblock && !node.isLeaf;
              }

              const key = getBlockHeightTargetKey(node.attrs, pos);
              const targetHeight = heights.blockTargets[key];
              if (targetHeight) {
                decorations.push(Decoration.node(pos, pos + node.nodeSize, {
                  "data-boxed-run-aligned": "true",
                  style: getDecoratedBlockStyle(node.attrs, targetHeight),
                }));
              }

              const containerFrames = heights.frames[key];
              if (containerFrames && containerFrames.length > 0) {
                // The frames are positioned against this container, so it has to be one.
                decorations.push(Decoration.node(pos, pos + node.nodeSize, {
                  class: "boxed-run-framed",
                }));
                decorations.push(Decoration.widget(
                  pos + 1,
                  () => createBoxedRunFrameLayer(containerFrames),
                  { key: `boxed-run-frames-${boxedRunFrameKey(containerFrames)}`, side: -3 },
                ));
              }
              return false;
            });

            for (const target of heights.inlineTargets) {
              decorations.push(Decoration.inline(target.from, target.to, {
                ...(target.connectLeft ? { "data-boxed-run-connect-left": "true" } : {}),
                ...(target.connectRight ? { "data-boxed-run-connect-right": "true" } : {}),
                [HEIGHT_TARGET_ATTRIBUTE]: "true",
                style: getDecoratedInlineStyle(target),
              }));
            }

            return DecorationSet.create(state.doc, decorations);
          },
        },
        view: (view) => {
          const observer = observeBoxedTextRunHeightTargets(view.dom, view, drawRunFrames, (targets) => {
            const current = boxedTextRunHeightPluginKey.getState(view.state) ?? emptyBoxedRunHeightState;
            if (sameHeightTargets(current, targets)) {
              return;
            }
            view.dispatch(view.state.tr.setMeta(boxedTextRunHeightPluginKey, targets));
          });

          return {
            // Refresh on every update on purpose. Gating this on
            // `view.state.doc !== prevState.doc` (or on this plugin's own state
            // changing) breaks the connect-left/right assertions in
            // tests/e2e/boxed-text-run-height.spec.ts on load: some layout
            // settling arrives without a doc change and without a signal the
            // observers below pick up. The cheap path is the early-out in
            // measureBoxedRunHeightTargets instead.
            //
            // 唯一の絞り込みは「この編集器に囲み文字があるか」。無ければ測っても必ず空
            // (measureBoxedRunHeightTargets の早期 return と同じ条件) なので、2 フレームの
            // 計測窓を毎 update 開くだけ無駄になる。**docChanged では絞らない** — 上のとおり
            // それをやると読み込み時の連結判定が落ちる。直前まで測れていた場合 (囲みを消した
            // 直後) は、空へ更新させるために回す。
            update: () => {
              if (
                hasAnyBoxedRunTarget(view.dom)
                || hasMeasurements(boxedTextRunHeightPluginKey.getState(view.state) ?? emptyBoxedRunHeightState)
              ) {
                observer.refresh();
              }
            },
            destroy: () => {
              observer.destroy();
            },
          };
        },
      }),
    ];
  },
});

/** 囲みランを測ったのに、その入れ物の枠がまだ読めていない = 装飾が入った後にもう 1 パス要る。 */
function hasUnframedBoxedRun(targets: BoxedRunHeightState): boolean {
  return targets.inlineTargets.some((target) => targets.frames[target.containerKey] === undefined);
}

function observeBoxedTextRunHeightTargets(
  root: ParentNode,
  view: EditorView | undefined,
  drawRunFrames: boolean,
  onMeasure: (targets: BoxedRunHeightState) => void,
): { refresh: () => void; destroy: () => void } {
  if (typeof window === "undefined") {
    return { refresh: () => undefined, destroy: () => undefined };
  }

  // 枠は「1 パス目の装飾が入った DOM」からしか読めない (下の `reconcileBoxedRunHeightState`
  // の説明を参照) ので、囲みランを見つけたのに枠がまだ無いパスの後には必ずもう 1 パス要る。
  // その 2 パス目を呼ぶ合図 (自分の dispatch と、それが起こす DOM 変化) は必ず計測窓の内側に
  // 着くので、スケジューラに「もう 1 パス要る」と申告する。
  const scheduler = createSettlingMeasureScheduler(() => {
    const targets = measureBoxedRunHeightTargets(root, view, drawRunFrames);
    onMeasure(targets);
    return drawRunFrames && hasUnframedBoxedRun(targets);
  });
  const scheduleRefresh = scheduler.refresh;
  const resizeObserver = typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver(scheduleRefresh);
  const mutationObserver = typeof MutationObserver === "undefined"
    ? null
    : new MutationObserver(scheduleRefresh);
  const intervalId = resizeObserver || mutationObserver
    ? null
    : window.setInterval(scheduleRefresh, 500);

  if (root instanceof Element) {
    resizeObserver?.observe(root);
    mutationObserver?.observe(root, {
      attributes: true,
      attributeFilter: ["class", "data-sigma-doc-boxed-padding-y", "data-sigma-doc-boxed-variant", "data-sigma-doc-boxed-tone", "data-sigma-doc-boxed-math"],
      childList: true,
      characterData: true,
      subtree: true,
    });
  }
  window.addEventListener("resize", scheduleRefresh);
  scheduleRefresh();

  return {
    refresh: scheduleRefresh,
    destroy: () => {
      scheduler.destroy();
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
      window.removeEventListener("resize", scheduleRefresh);
    },
  };
}

/**
 * A measurement survives a document change only while the container it came from still holds
 * the same boxed runs, and only while its positions can be mapped honestly.
 *
 * Mapping alone cannot express that. A frame is pure geometry with no document position to
 * map, and an undo is a `setContent` — one ReplaceStep over the whole document — where every
 * interior position collapses onto an edge. Mapping through that produced two visible wrongs
 * at once: the frame of a paragraph whose boxed mark had just been undone kept being drawn (a
 * border around text that is no longer boxed), and its inline target widened into ONE
 * decoration spanning the entire document, which put `data-boxed-run-height-target` on all
 * inline content and had the next pass measure a frame for every paragraph in it.
 *
 * So two conditions, each aimed at one of those:
 *
 * 1. The container's signature — which runs it holds, not where they sit — must be unchanged.
 *    Deliberately position-free: typing inside a run must NOT invalidate it. Measured, the
 *    round trip back to a drawn frame takes two measure passes (a frame can only be read off
 *    an already-decorated DOM) and that is ~12 frames of per-segment borders — the very flash
 *    the original "keep the old geometry" comment was avoiding.
 * 2. Every one of the container's positions must survive mapping without passing through a
 *    deleted range. Ordinary editing maps exactly, including edits inside the run; a
 *    whole-document replace does not, and that is exactly the case that must be dropped.
 *
 * Dropping a container's entry does not make its box disappear: without `frames` the container
 * loses `boxed-run-framed`, `document-surface.css` stops neutralising the segment borders, and
 * the run is painted by its own segments again until the next measure lands.
 */
export function reconcileBoxedRunHeightState(
  state: BoxedRunHeightState,
  transaction: Transaction,
): BoxedRunHeightState {
  const signatures = Object.entries(state.signatures);
  if (signatures.length === 0) {
    // Nothing verifiable is held, so there is nothing to walk the document for. Most
    // editors in a document never contain boxed text and take this path on every change.
    return hasMeasurements(state) ? emptyBoxedRunHeightState : state;
  }

  const expected = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [key, signature] of signatures) {
    const mappedKey = mapTargetKey(key, transaction);
    if (mappedKey === undefined) {
      continue;
    }
    // Two `pos:` keys inside one deleted range map onto the same position. Validating either
    // against the other's signature would let a container inherit a frame it never had.
    if (expected.has(mappedKey)) {
      ambiguous.add(mappedKey);
    }
    expected.set(mappedKey, signature);
  }

  const seen = new Set<string>();
  const surviving = new Set<string>();
  // 入れ物 (段落/見出し) の同一性だけを見るので、その中身へは降りない。
  countDecorationBlockWalk();
  transaction.doc.descendants((node, pos) => {
    if (node.type.name === "paragraph" || node.type.name === "heading") {
      const key = getBlockHeightTargetKey(node.attrs, pos);
      if (expected.has(key) && !ambiguous.has(key)) {
        if (seen.has(key)) {
          // A duplicated id makes the key meaningless; the decoration pass would draw the
          // same frame on both containers.
          ambiguous.add(key);
          surviving.delete(key);
        } else {
          seen.add(key);
          if (expected.get(key) === boxedRunContainerSignature(node, pos)) {
            surviving.add(key);
          }
        }
      }
      return false;
    }
    // Never descend into inline content: this runs on every document change, and an
    // unbounded walk here is the known typing-cost hazard in this file.
    return !(node.isTextblock || node.isLeaf);
  });

  const mapped: BoxedRunInlineTarget[] = [];
  for (const target of state.inlineTargets) {
    const containerKey = mapTargetKey(target.containerKey, transaction);
    if (containerKey === undefined || !surviving.has(containerKey)) {
      continue;
    }
    const from = transaction.mapping.mapResult(target.from, -1);
    const to = transaction.mapping.mapResult(target.to, 1);
    // `deletedAcross`, not `deleted`: the latter also fires when the character immediately
    // outside the run is removed (backspace next to a box, joining the paragraph below), and
    // that maps perfectly well. What must be refused is a position the step replaced from
    // both sides — which is every position inside a whole-document ReplaceStep.
    if (from.deletedAcross || to.deletedAcross || to.pos <= from.pos) {
      // The run was replaced rather than edited around, so the mapped range describes
      // nothing. Take the whole container down with it: a frame without its height targets
      // would be drawn on top of the segment borders it exists to replace.
      surviving.delete(containerKey);
      continue;
    }
    mapped.push({ ...target, containerKey, from: from.pos, to: to.pos });
  }

  const keepSurviving = <T>(record: Record<string, T>): Record<string, T> => {
    const kept = emptyKeyedRecord<T>();
    for (const [key, value] of Object.entries(record)) {
      const mappedKey = mapTargetKey(key, transaction);
      if (mappedKey !== undefined && surviving.has(mappedKey)) {
        kept[mappedKey] = value;
      }
    }
    return kept;
  };

  return {
    blockTargets: keepSurviving(state.blockTargets),
    frames: keepSurviving(state.frames),
    inlineTargets: mapped.filter((target) => surviving.has(target.containerKey)),
    signatures: keepSurviving(state.signatures),
  };
}

/**
 * Which boxed runs a container holds — not where they sit.
 *
 * Offsets are left out on purpose. Including them would invalidate the container on every
 * keystroke typed inside its own run, and the way back to a drawn frame is slow enough
 * (two measure passes) that the box visibly falls back to per-segment borders while it
 * happens. Positions are the mapping's job; this only has to notice runs appearing,
 * disappearing, or changing style — the things a kept rectangle cannot survive.
 */
export function boxedRunContainerSignature(node: ProseMirrorNode, pos: number): string {
  const targets = collectBoxedRunDocTargetsForTextBlock(node, pos);
  return `${targets.length}#${targets.map((target) => target.styleKey ?? "").join(";")}`;
}

function hasMeasurements(state: BoxedRunHeightState): boolean {
  return state.inlineTargets.length > 0
    || Object.keys(state.blockTargets).length > 0
    || Object.keys(state.frames).length > 0;
}

/**
 * Positions live in `pos:` keys only (`getBlockHeightTargetKey`), so those are the only
 * keys a document change can move.
 */
function mapTargetKey(key: string, transaction: Transaction): string | undefined {
  if (!key.startsWith("pos:")) {
    return key;
  }
  const pos = Number(key.slice(4));
  if (!Number.isFinite(pos)) {
    return undefined;
  }
  return `pos:${transaction.mapping.map(pos, 1)}`;
}

function measureBoxedRunHeightTargets(
  root: ParentNode,
  view: EditorView | undefined,
  drawRunFrames: boolean,
): BoxedRunHeightState {
  // Only elements matching BOXED_TEXT_SELECTOR can ever produce a non-empty
  // target (see assignBoxedRunTargets / computeBoxedRunLineTargets — loose
  // rects never carry a boxedTarget). Most editors in a document have no boxed
  // text at all, so skip the "add measuring class, walk every inline
  // container, force layout" dance entirely; the result is identical to the
  // full walk (empty state) but without the forced synchronous layout or the
  // classList churn that invalidates style for the whole editor subtree.
  if (!hasAnyBoxedRunTarget(root)) {
    return emptyBoxedRunHeightState;
  }

  const rootElement = root instanceof HTMLElement ? root : null;
  // 入れ物ごとに文書を歩いて id を探すと、囲みを含む文書で「入れ物の数 × 文書の大きさ」に
  // なる。索引は 1 パスにつき 1 回だけ作る。
  const blocksById = view ? collectContainerBlocksById(view.state.doc) : undefined;
  // Read the frames from the rendered run BEFORE the frame is neutralised for measuring.
  const renderedFrames = drawRunFrames ? readRenderedRunFrames(root, view, blocksById) : {};
  rootElement?.classList.add("boxed-run-measuring");

  try {
    const targets: BoxedRunHeightState = {
      blockTargets: emptyKeyedRecord(),
      inlineTargets: [],
      frames: emptyKeyedRecord(),
      signatures: emptyKeyedRecord(),
    };
    for (const container of getInlineContainers(root)) {
      const key = getContainerHeightTargetKey(container, view, blocksById);
      if (!key) {
        continue;
      }

      // Resolved once and threaded through: the document targets and the signature both
      // need it, and looking it up by id is a document walk.
      const block = view ? getContainerDocBlock(container, view, blocksById) : undefined;

      const containerTargets = measureContainerBoxedRunTargets(container, key, block, view);
      if (containerTargets.targetHeight) {
        targets.blockTargets[key] = containerTargets.targetHeight;
      }
      targets.inlineTargets.push(...containerTargets.inlineTargets);

      const containerFrames = renderedFrames[key];
      // A frame is only real if this pass measured a run to hang it on. Otherwise it was
      // read off a decoration that outlived the mark that created it, and storing it would
      // reintroduce the border-with-no-boxed-text this reconciliation exists to remove.
      if (containerFrames && containerTargets.inlineTargets.length > 0 && block) {
        targets.frames[key] = containerFrames;
      }
      if (containerTargets.targetHeight || containerTargets.inlineTargets.length > 0) {
        // A space when the block cannot be resolved: no computed signature can equal it, so
        // the measurement is treated as unverifiable and dropped on the next document change
        // instead of silently matching an empty container. Such a container gets no frame
        // above either — an unverifiable rectangle is indistinguishable from a ghost one.
        targets.signatures[key] = block ? boxedRunContainerSignature(block.node, block.pos) : " ";
      }
    }
    return targets;
  } finally {
    rootElement?.classList.remove("boxed-run-measuring");
  }
}

function measureContainerBoxedRunTargets(
  container: HTMLElement,
  containerKey: string,
  block: { node: ProseMirrorNode; pos: number } | undefined,
  view?: EditorView,
): { inlineTargets: BoxedRunInlineTarget[]; targetHeight?: number } {
  const measurements = collectInlineMeasurements(container, block, view);
  const lineTargets = computeBoxedRunLineTargets(measurements);
  const lineConnections = computeBoxedRunLineConnections(measurements);
  const targetHeight = Math.max(0, ...Array.from(lineTargets.values()).map((target) => target.targetHeight));
  const inlineTargets: BoxedRunInlineTarget[] = [];

  for (const [target, lineTarget] of lineTargets) {
    if (target.from === undefined || target.to === undefined || target.to <= target.from) {
      continue;
    }

    const roundedTargetHeight = roundCssPx(lineTarget.targetHeight);
    const roundedOwnHeight = roundCssPx(lineTarget.ownHeight);
    const connection = lineConnections.get(target);
    inlineTargets.push({
      connectLeft: connection?.connectLeft ?? false,
      connectRight: connection?.connectRight ?? false,
      containerKey,
      extraPaddingBottom: roundCssPx(lineTarget.extraPaddingBottom),
      extraPaddingTop: roundCssPx(lineTarget.extraPaddingTop),
      from: target.from,
      ownHeight: roundedOwnHeight,
      targetHeight: roundedTargetHeight,
      to: target.to,
    });
  }

  return {
    inlineTargets,
    targetHeight: targetHeight > 0 ? roundCssPx(targetHeight) : undefined,
  };
}

/**
 * The rectangle each connected run actually occupies, ready to be drawn as ONE border.
 *
 * Aligning per-segment borders by padding cannot be made exact: padding only grows a box,
 * so the segment that defines the run's height has nothing to adjust, and padding its
 * neighbours shifts their baselines relative to it. A third of a pixel of that shows as a
 * sliver of border poking out under the frame next to a `\frac`.
 *
 * So the border is not drawn by the segments at all. This measures where the run ended up
 * and the frame is painted there — one rectangle, one set of edges, nothing to disagree.
 * It cannot feed back either: the frame is positioned out of flow, so it cannot move the
 * text it was measured from.
 */
function readRenderedRunFrames(
  root: ParentNode,
  view?: EditorView,
  blocksById?: ContainerBlocksById,
): Record<string, BoxedRunFrame[]> {
  const frames = emptyKeyedRecord<BoxedRunFrame[]>();
  if (typeof window === "undefined") {
    return frames;
  }

  for (const container of getInlineContainers(root)) {
    const key = getContainerHeightTargetKey(container, view, blocksById);
    if (!key) {
      continue;
    }
    const segments = Array.from(container.querySelectorAll<HTMLElement>(`[${HEIGHT_TARGET_ATTRIBUTE}]`));
    if (segments.length === 0) {
      continue;
    }

    const containerRect = container.getBoundingClientRect();
    const containerStyle = window.getComputedStyle(container);
    const originLeft = containerRect.left + (Number.parseFloat(containerStyle.borderLeftWidth) || 0);
    const originTop = containerRect.top + (Number.parseFloat(containerStyle.borderTopWidth) || 0);
    const zoom = getEffectiveZoom(container);
    const containerFrames: BoxedRunFrame[] = [];

    let run: { left: number; top: number; right: number; bottom: number; source: HTMLElement } | null = null;
    const flush = () => {
      if (!run) {
        return;
      }
      const mark = run.source.closest<HTMLElement>(BOXED_TEXT_SELECTOR) ?? run.source;
      containerFrames.push({
        left: roundCssPx(run.left),
        top: roundCssPx(run.top),
        width: roundCssPx(run.right - run.left),
        height: roundCssPx(run.bottom - run.top),
        variant: mark.getAttribute("data-sigma-doc-boxed-variant"),
        tone: mark.getAttribute("data-sigma-doc-boxed-tone"),
      });
      run = null;
    };

    for (const segment of segments) {
      // A segment that wraps reports a union box spanning both lines, which is not a
      // rectangle anyone can draw. Its individual line boxes are, so use those.
      for (const rect of Array.from(segment.getClientRects())) {
        const left = (rect.left - originLeft) / zoom;
        const top = (rect.top - originTop) / zoom;
        const right = left + rect.width / zoom;
        const bottom = top + rect.height / zoom;
        const continues = run !== null &&
          Math.abs(top - run.top) <= RUN_FRAME_LINE_TOLERANCE_PX &&
          left - run.right <= RUN_FRAME_JOIN_TOLERANCE_PX;
        if (continues && run) {
          run.left = Math.min(run.left, left);
          run.top = Math.min(run.top, top);
          run.right = Math.max(run.right, right);
          run.bottom = Math.max(run.bottom, bottom);
        } else {
          flush();
          run = { left, top, right, bottom, source: segment };
        }
      }
    }
    flush();

    if (containerFrames.length > 0) {
      frames[key] = containerFrames;
    }
  }

  return frames;
}

function sameFrames(a: Record<string, BoxedRunFrame[]>, b: Record<string, BoxedRunFrame[]>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) {
    return false;
  }
  return aKeys.every((key) => {
    const left = a[key];
    const right = b[key];
    return right !== undefined && left.length === right.length && left.every((frame, index) => {
      const other = right[index];
      return sameAlignmentPx(frame.left, other.left) &&
        sameAlignmentPx(frame.top, other.top) &&
        sameAlignmentPx(frame.width, other.width) &&
        sameAlignmentPx(frame.height, other.height) &&
        frame.variant === other.variant &&
        frame.tone === other.tone;
    });
  });
}

function sameAlignmentPx(a: number, b: number): boolean {
  return Math.abs(a - b) <= RUN_FRAME_EPSILON_PX;
}

function sameSignatures(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  return aKeys.length === Object.keys(b).length && aKeys.every((key) => a[key] === b[key]);
}

function sameHeightTargets(a: BoxedRunHeightState, b: BoxedRunHeightState): boolean {
  const aKeys = Object.keys(a.blockTargets);
  const bKeys = Object.keys(b.blockTargets);
  if (aKeys.length !== bKeys.length || !aKeys.every((key) => sameCssPx(a.blockTargets[key], b.blockTargets[key]))) {
    return false;
  }
  if (a.inlineTargets.length !== b.inlineTargets.length) {
    return false;
  }
  if (!sameFrames(a.frames, b.frames)) {
    return false;
  }
  if (!sameSignatures(a.signatures, b.signatures)) {
    return false;
  }
  return a.inlineTargets.every((target, index) => {
    const other = b.inlineTargets[index];
    return other !== undefined &&
      target.connectLeft === other.connectLeft &&
      target.connectRight === other.connectRight &&
      target.containerKey === other.containerKey &&
      sameCssPx(target.extraPaddingBottom, other.extraPaddingBottom) &&
      sameCssPx(target.extraPaddingTop, other.extraPaddingTop) &&
      target.from === other.from &&
      sameCssPx(target.ownHeight, other.ownHeight) &&
      sameCssPx(target.targetHeight, other.targetHeight) &&
      target.to === other.to;
  });
}

function sameCssPx(a: number, b: number): boolean {
  return Math.abs(a - b) <= HEIGHT_TARGET_TOLERANCE_PX;
}

function getDecoratedBlockStyle(attrs: Record<string, unknown>, targetHeight: number): string {
  const styles: string[] = [];
  if (typeof attrs.textAlign === "string") {
    styles.push(`text-align: ${attrs.textAlign}`);
  }
  if (typeof attrs.lineHeight === "string") {
    styles.push(`line-height: ${attrs.lineHeight}`);
  }
  styles.push(`--boxed-run-target-height: ${targetHeight}px`);
  return styles.join("; ");
}

/**
 * The drawn frames for one container: absolutely positioned, so they take no part in
 * layout and cannot disturb the run they were measured from.
 */
function createBoxedRunFrameLayer(frames: BoxedRunFrame[]): HTMLElement {
  const layer = document.createElement("span");
  layer.className = "boxed-run-frame-layer";
  layer.contentEditable = "false";
  layer.setAttribute("aria-hidden", "true");
  for (const frame of frames) {
    const element = document.createElement("span");
    element.className = "boxed-run-frame";
    if (frame.variant) {
      element.setAttribute("data-sigma-doc-boxed-variant", frame.variant);
    }
    if (frame.tone) {
      element.setAttribute("data-sigma-doc-boxed-tone", frame.tone);
    }
    element.style.left = `${frame.left}px`;
    element.style.top = `${frame.top}px`;
    element.style.width = `${frame.width}px`;
    element.style.height = `${frame.height}px`;
    layer.appendChild(element);
  }
  return layer;
}

function boxedRunFrameKey(frames: BoxedRunFrame[]): string {
  return frames
    .map((frame) => `${frame.left},${frame.top},${frame.width},${frame.height},${frame.variant ?? ""},${frame.tone ?? ""}`)
    .join("|");
}

function getDecoratedInlineStyle(target: BoxedRunInlineTarget): string {
  return [
    `--boxed-run-extra-padding-bottom: ${target.extraPaddingBottom}px`,
    `--boxed-run-extra-padding-top: ${target.extraPaddingTop}px`,
    `--boxed-run-own-height: ${target.ownHeight}px`,
    `--boxed-run-target-height: ${target.targetHeight}px`,
  ].join("; ");
}

function getBlockHeightTargetKey(attrs: Record<string, unknown>, pos: number): string {
  return typeof attrs.sigmaDocId === "string" ? attrs.sigmaDocId : `pos:${pos}`;
}

function getContainerHeightTargetKey(
  container: HTMLElement,
  view: EditorView | undefined,
  blocksById?: ContainerBlocksById,
): string | undefined {
  const id = container.getAttribute("data-sigma-doc-id");
  if (id) {
    return id;
  }
  if (!view) {
    return undefined;
  }
  const block = getContainerDocBlock(container, view, blocksById);
  return block ? `pos:${block.pos}` : undefined;
}

function hasAnyBoxedRunTarget(root: ParentNode): boolean {
  if (root instanceof Element && root.matches(BOXED_TEXT_SELECTOR)) {
    return true;
  }
  return root.querySelector(BOXED_TEXT_SELECTOR) !== null;
}

function getInlineContainers(root: ParentNode): HTMLElement[] {
  const containers = Array.from(root.querySelectorAll<HTMLElement>(INLINE_CONTAINER_SELECTOR));
  if (root instanceof HTMLElement && root.matches(INLINE_CONTAINER_SELECTOR)) {
    return [root, ...containers];
  }
  return containers;
}

/**
 * How many document targets a single `.boxed-text` span stands in for.
 *
 * ProseMirror coalesces adjacent inline content that shares the same mark into a
 * single mark span. Inline math nodes are atoms, so several boxed math nodes end
 * up inside one `.boxed-text` while staying distinct document targets (each
 * rendered as its own node view). Text styling can wrap those
 * node views below the boxed mark span, so count owned descendants rather than
 * direct children. Return one segment per node view so every coalesced run member
 * maps to its own document target instead of the trailing members being dropped
 * (which made them fall back to standalone boxes — see boxed-text-run-height.spec /
 * boxed-run mapping tests).
 */
export function boxedRunSegmentCount(element: Element): number {
  return collectOwnedBoxedRunSegments(element).length;
}

/**
 * The elements to measure for a mark span, one per document target it stands in for.
 *
 * Counting the segments and measuring them has to come from the same walk. When they
 * did not, every coalesced member was measured as the whole span: two adjacent boxed
 * maths (`\sum` then `\frac12`) share one mark span, so both reported the span's union
 * height, both computed zero extra padding, and the shorter one then rendered at its
 * natural height — a notch in what should be one continuous frame.
 *
 * A span with no node views stands for itself, which is the plain-text case.
 */
export function collectOwnedBoxedRunSegments(element: Element): Element[] {
  const nodeViews: Element[] = [];
  const visit = (current: Element) => {
    for (const child of Array.from(current.children)) {
      if (matchesSelector(child, BOXED_TEXT_SELECTOR)) {
        continue;
      }
      // 数式は 1 つ 1 つが独立した文書ターゲット。**編集面のノードビューだけ**を数える
      // (静的レンダラが出す数式にはこの印が無く、印刷側は span 全体を 1 つとして測る —
      // React ノードビューだった頃に `.react-renderer` が果たしていた役目)。
      if (child.hasAttribute(INLINE_MATH_NODE_VIEW_ATTRIBUTE)) {
        nodeViews.push(child);
        continue;
      }
      visit(child);
    }
  };
  visit(element);
  // Node views when the span holds any, the span itself otherwise. Both exist
  // independently of the decoration, which matters: an earlier version preferred the
  // decorated spans, and since those only appear after the first pass the measured set
  // changed between passes and the layout never settled.
  //
  // Measuring the mark for every member is what notched the frame — `\sum` followed by
  // `\frac12` coalesce into one mark span, so both took the span's union height and the
  // shorter one stayed at its natural size. The measuring pass strips the frame from the
  // mark as well, so node views and marks are measured on the same (frameless) basis.
  // Split only when the span really stands in for several targets. A span with a single
  // member is measured whole, which is how the overlay text-shape path (whose frame sits
  // on the span itself) stays self-consistent.
  return nodeViews.length > 1 ? nodeViews : [element];
}

function matchesSelector(element: Element, selector: string): boolean {
  return typeof element.matches === "function" && element.matches(selector);
}

function collectInlineMeasurements(
  container: HTMLElement,
  block: { node: ProseMirrorNode; pos: number } | undefined,
  view?: EditorView,
): Array<BoxedRunMeasurement<BoxedRunDomTarget>> {
  return assignBoxedRunTargets(
    collectBoxedRunWalkItems(container, view),
    block ? collectBoxedRunDocTargetsForTextBlock(block.node, block.pos) : [],
  );
}

/** One ordered chunk of the inline walk: either loose (unboxed) rects, or a boxed
 *  mark span that stands in for `segmentCount` document targets. */
export type BoxedRunWalkItem =
  | { kind: "loose"; rects: BoxedRunRect[] }
  /** `segments[i]` are the rects of the i-th document target this span stands in for. */
  | { kind: "boxed"; segments: BoxedRunRect[][]; resolveFallback: () => BoxedRunDomTarget };

/**
 * Pair the boxed boxes from an inline walk with their document targets, in order.
 *
 * This is the part that regresses whenever the boxed-run markup changes: a single
 * `.boxed-text` span can stand in for several document targets (coalesced math
 * atoms), so it must consume `segmentCount` target slots — not one. Kept pure (no
 * DOM) so the slot bookkeeping is unit tested without a browser/editor view.
 */
export function assignBoxedRunTargets(
  items: BoxedRunWalkItem[],
  documentTargets: BoxedRunDomTarget[],
): Array<BoxedRunMeasurement<BoxedRunDomTarget>> {
  const measurements: Array<BoxedRunMeasurement<BoxedRunDomTarget>> = [];
  let documentTargetIndex = 0;
  for (const item of items) {
    if (item.kind === "loose") {
      measurements.push(...item.rects);
      continue;
    }
    for (const segmentRects of item.segments) {
      const boxedTarget = documentTargets[documentTargetIndex] ?? item.resolveFallback();
      documentTargetIndex += 1;
      measurements.push(...segmentRects.map((rect) => ({ ...rect, boxedTarget })));
    }
  }
  return measurements;
}

function collectBoxedRunWalkItems(container: HTMLElement, view?: EditorView): BoxedRunWalkItem[] {
  const items: BoxedRunWalkItem[] = [];
  // Measured rects are zoom-scaled (`.page-stack { zoom }`); divide them back to the
  // element's own coordinate space so applied heights don't grow by zoom². See
  // getEffectiveZoom.
  const zoom = getEffectiveZoom(container);
  const visit = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (isVisibleTextBreak(child.textContent ?? "") && child instanceof Text) {
          items.push({ kind: "loose", rects: scaleBoxedRunRects(getTextNodeRects(child), zoom) });
        }
        continue;
      }

      if (!(child instanceof HTMLElement)) {
        continue;
      }

      if (isIgnorableElement(child)) {
        continue;
      }

      if (child.matches(BOXED_TEXT_SELECTOR)) {
        items.push({
          kind: "boxed",
          segments: collectOwnedBoxedRunSegments(child)
            .map((segment) => scaleBoxedRunRects(getElementRects(segment), zoom)),
          resolveFallback: () => getBoxedRunDomTarget(child, view),
        });
        continue;
      }

      if (child.tagName === "BR") {
        continue;
      }

      if (child.querySelector(BOXED_TEXT_SELECTOR)) {
        visit(child);
        continue;
      }

      if (hasVisibleContent(child)) {
        items.push({ kind: "loose", rects: scaleBoxedRunRects(getElementRects(child), zoom) });
      }
    }
  };

  visit(container);

  return items;
}

export function collectBoxedRunDocTargetsForTextBlock(node: ProseMirrorNode, pos: number): BoxedRunDomTarget[] {
  if (node.type.name !== "paragraph" && node.type.name !== "heading") {
    return [];
  }

  const targets: BoxedRunDomTarget[] = [];
  node.forEach((child, offset) => {
    if (!child.isInline) {
      return;
    }

    const boxedMark = child.marks.find((mark) => mark.type.name === "boxed");
    if (!boxedMark) {
      return;
    }

    targets.push({
      from: pos + 1 + offset,
      styleKey: getBoxedInlineStyleKey(boxedMark.attrs),
      to: pos + 1 + offset + child.nodeSize,
    });
  });

  return targets;
}

type ContainerBlocksById = ReadonlyMap<string, { node: ProseMirrorNode; pos: number }>;

/** 段落/見出しの id → ノードの索引。1 計測パスにつき 1 回だけ作る。 */
function collectContainerBlocksById(doc: ProseMirrorNode): ContainerBlocksById {
  const blocks = new Map<string, { node: ProseMirrorNode; pos: number }>();
  countDecorationBlockWalk();
  doc.descendants((node, pos) => {
    if (node.type.name !== "paragraph" && node.type.name !== "heading") {
      // 中身に入れ物は入っていない。textblock と葉には降りない。
      return !node.isTextblock && !node.isLeaf;
    }
    const id = node.attrs?.sigmaDocId;
    // 先勝ち: 元の実装も最初に見つけたものを返していた (id 重複は文書側の壊れ)。
    if (typeof id === "string" && id && !blocks.has(id)) {
      blocks.set(id, { node, pos });
    }
    return false;
  });
  return blocks;
}

function getContainerDocBlock(
  container: HTMLElement,
  view: EditorView,
  blocksById?: ContainerBlocksById,
): { node: ProseMirrorNode; pos: number } | undefined {
  const id = container.getAttribute("data-sigma-doc-id");
  if (id) {
    const found = (blocksById ?? collectContainerBlocksById(view.state.doc)).get(id);
    if (found) {
      return found;
    }
  }

  try {
    const pos = Math.max(0, view.posAtDOM(container, 0) - 1);
    const node = view.state.doc.nodeAt(pos);
    if (node && (node.type.name === "paragraph" || node.type.name === "heading")) {
      return { node, pos };
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function getBoxedRunDomTarget(element: HTMLElement, view?: EditorView): BoxedRunDomTarget {
  if (!view) {
    return { element };
  }

  try {
    return {
      element,
      from: view.posAtDOM(element, 0),
      styleKey: getBoxedRunDomStyleKey(element),
      to: view.posAtDOM(element, element.childNodes.length),
    };
  } catch {
    return { element, styleKey: getBoxedRunDomStyleKey(element) };
  }
}

function getBoxedRunDomStyleKey(element: HTMLElement): string {
  return getBoxedInlineStyleKey({
    boxedPaddingY: element.getAttribute("data-sigma-doc-boxed-padding-y"),
    boxedTone: element.getAttribute("data-sigma-doc-boxed-tone"),
    boxedVariant: element.getAttribute("data-sigma-doc-boxed-variant"),
  });
}

function getTextNodeRects(node: Text): BoxedRunRect[] {
  const range = node.ownerDocument.createRange();
  range.selectNodeContents(node);
  const rects = getClientRects(range);
  range.detach();
  return rects;
}

function getElementRects(element: Element): BoxedRunRect[] {
  const rects = getClientRects(element);
  if (rects.length > 0) {
    return rects;
  }
  return toBoxedRunRect(element.getBoundingClientRect());
}

function getClientRects(target: Element | Range): BoxedRunRect[] {
  return Array.from(target.getClientRects())
    .flatMap(toBoxedRunRect);
}

function toBoxedRunRect(rect: DOMRect | DOMRectReadOnly): BoxedRunRect[] {
  if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom) || !Number.isFinite(rect.height) || rect.height <= 0) {
    return [];
  }
  return [{
    top: rect.top,
    bottom: rect.bottom,
    height: rect.height,
  }];
}

function isVisibleTextBreak(text: string): boolean {
  return hasVisibleInlineText(text);
}

function isIgnorableElement(element: HTMLElement): boolean {
  return element.matches(IGNORABLE_ELEMENT_SELECTOR) ||
    element.getAttribute("aria-hidden") === "true" ||
    element.hidden;
}

function hasVisibleContent(element: HTMLElement): boolean {
  if (element.querySelector(BOXED_TEXT_SELECTOR)) {
    return false;
  }
  if (element.tagName === "BR") {
    return true;
  }
  return hasVisibleInlineText(element.textContent ?? "") ||
    element.getBoundingClientRect().width > 0 ||
    element.getBoundingClientRect().height > 0;
}

function roundCssPx(value: number): number {
  return Math.round(value * CSS_PIXEL_PRECISION) / CSS_PIXEL_PRECISION;
}
