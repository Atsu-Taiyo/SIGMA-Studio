import type {
  ProbeChromeBox,
  ProbeColumn,
  ProbeInk,
  ProbeInnerBreak,
  ProbeNode,
  ProbeRect,
  ProbeTree,
  ProbeUnit,
} from "@/features/rendering/core";

/**
 * 本文フローの**自然配置**を読む。
 *
 * ページ割りは本文を動かさない: ユニットと最上位ブロックへの配置は、兄弟のレイアウトに影響しない
 * 相対配置のずらし (`position: relative` の `top` / `left`) で与え、同じ量を `data-flow-dx` /
 * `data-flow-dy` に書く。ここでは読んだ矩形から
 * その量を差し引くので、結果はページ割りの答えに依存しない (= 計測→配置は開ループ)。
 * 以前の「隙間 (spacer / margin) を入れた DOM を読み、適用済みの隙間を推定で引く」閉ループは、
 * margin の相殺や計測のタイミングで推定がずれ、答えが往復して誤った配置で凍結していた。
 */

export const FLOW_DX_ATTRIBUTE = "data-flow-dx";
export const FLOW_DY_ATTRIBUTE = "data-flow-dy";
export const FLOW_BREAK_BEFORE_ATTRIBUTE = "data-flow-break-before";
export const FLOW_SPAN_ATTRIBUTE = "data-flow-span";
/**
 * 本文ブロックの後ろに機能が差し込む要素 (フロー内の拡張ノード)。値はページ全体で一意な id。
 * 本文と同じく行として測り、ページ・段の境目では行の間で切る。
 */
export const FLOW_EXTENSION_NODE_ATTRIBUTE = "data-flow-extension-node-id";
/** 拡張ノードの中身の版。高さが同じでも、これが変われば行を測り直す。 */
export const FLOW_MEASURE_REVISION_ATTRIBUTE = "data-flow-measure-revision";
/**
 * ページ・段の境目で切れた拡張ノードの続き (複製) が持つ、元の拡張ノードの id。複製はフローの外の
 * 層にあり、計測は読まない (正本だけが `FLOW_EXTENSION_NODE_ATTRIBUTE` を持つ)。
 */
export const FLOW_EXTENSION_REPLICA_ATTRIBUTE = "data-flow-extension-replica";

const BODY_NODE_SELECTOR = `.ProseMirror > [data-sigma-doc-id], [${FLOW_EXTENSION_NODE_ATTRIBUTE}]`;
const EXTENSION_NODE_SELECTOR = `[${FLOW_EXTENSION_NODE_ATTRIBUTE}]`;

/** 紙面に出ない編集用の要素。行として数えない。 */
const EDITOR_ONLY_SELECTOR = [
  "[data-formatting-mark]",
  ".text-formatting-mark",
  ".ProseMirror-separator",
  ".sigma-doc-block-action-button",
  ".sigma-doc-box-corner",
  ".page-break-marker",
  ".page-break-spacer",
  "math-field",
  ".katex-mathml",
  "[data-editor-only]",
  "button",
].join(",");

/**
 * 拡張ノードの中で行に数えないもの。拡張ノードは紙面に描かれる部品 (操作のボタンなど) も
 * 中身なので、編集面の飾りを除く規則 (`EDITOR_ONLY_SELECTOR`) は使わない。
 */
const EXTENSION_EXCLUDED_SELECTOR = [".katex-mathml", "[data-editor-only]"].join(",");

interface ContentMeasureRules {
  excluded: string;
  /** スクロール・クリップする子孫の外にはみ出した描画を数えない (拡張ノードだけ。style を引くので重い)。 */
  clipToOverflow: boolean;
}

const BLOCK_CONTENT_RULES: ContentMeasureRules = { excluded: EDITOR_ONLY_SELECTOR, clipToOverflow: false };
const EXTENSION_CONTENT_RULES: ContentMeasureRules = { excluded: EXTENSION_EXCLUDED_SELECTOR, clipToOverflow: true };

/** 分割できない行内要素。子孫の矩形ではなく全体を 1 つの矩形として読む。 */
const INLINE_ATOM_SELECTOR = ".inline-math-node, .boxed-run-frame, .math-preview";
/** 分割できないブロック要素 (区切り線・画像など)。 */
const OBJECT_TAGS = new Set(["HR", "IMG", "SVG", "CANVAS", "VIDEO", "IFRAME", "OBJECT", "EMBED"]);
/** 上下に見える縁を持つ入れ物。 */
const CHROME_SELECTOR = ".sigma-doc-box-block, pre";
/** 中に本文ブロックを持たない最上位ブロック。入れ子の手動改ページを探さない。 */
const TEXT_LEAF_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "PRE", "HR"]);

interface NodeCacheEntry {
  element: HTMLElement;
  revision: string;
  width: number;
  height: number;
  /** ブロック上端からの相対値。 */
  ink: ProbeInk[];
  chrome: ProbeChromeBox[];
}

export interface FlowProbeCache {
  epoch: number;
  nodes: Map<string, NodeCacheEntry>;
}

export function createFlowProbeCache(): FlowProbeCache {
  return { epoch: 0, nodes: new Map() };
}

export interface FlowProbeOptions {
  zoomFactor: number;
  /** 手動改ページを持つブロック id。紙面の印ではなく文書から渡す (PDF 面には印が無い)。 */
  breakIds: ReadonlySet<string>;
  /**
   * 子孫に手動改ページを持つブロック id (`collectManualBreakHostIds`)。渡すと、この中の最上位
   * ブロックだけで入れ子の区切りを探す。渡さなければ中身を持つすべての最上位ブロックで探す。
   */
  breakHostIds?: ReadonlySet<string>;
  cache?: FlowProbeCache;
  /** フォントの差し替えなど、見た目の寸法が変わりうる合図。変われば行の計測を捨てる。 */
  cacheEpoch?: number;
}

interface Displacement {
  dx: number;
  dy: number;
}

export function readFlowDisplacement(element: Element): Displacement {
  const dx = Number(element.getAttribute(FLOW_DX_ATTRIBUTE) ?? 0);
  const dy = Number(element.getAttribute(FLOW_DY_ATTRIBUTE) ?? 0);
  return { dx: Number.isFinite(dx) ? dx : 0, dy: Number.isFinite(dy) ? dy : 0 };
}

export function probeFlow(flow: HTMLElement, options: FlowProbeOptions): ProbeTree {
  const zoom = options.zoomFactor > 0 ? options.zoomFactor : 1;
  const flowRect = flow.getBoundingClientRect();
  const cache = options.cache;
  if (cache && options.cacheEpoch !== undefined && cache.epoch !== options.cacheEpoch) {
    cache.epoch = options.cacheEpoch;
    cache.nodes.clear();
  }
  const seenNodeIds = new Set<string>();

  const toRect = (rect: DOMRect, acc: Displacement): ProbeRect => ({
    top: (rect.top - flowRect.top) / zoom - acc.dy,
    bottom: (rect.bottom - flowRect.top) / zoom - acc.dy,
    left: (rect.left - flowRect.left) / zoom - acc.dx,
    width: rect.width / zoom,
  });
  const toY = (clientY: number, acc: Displacement) => (clientY - flowRect.top) / zoom - acc.dy;

  const probeNode = (element: HTMLElement, unitAcc: Displacement): ProbeNode | null => {
    if (element.parentElement?.closest(EXTENSION_NODE_SELECTOR)) {
      // 拡張ノードの中身 (表示用のコピーなど) は拡張ノードの行として測る。本文のブロックではない。
      return null;
    }
    const extensionId = element.getAttribute(FLOW_EXTENSION_NODE_ATTRIBUTE);
    const isExtension = extensionId !== null;
    const id = isExtension ? extensionId : element.getAttribute("data-sigma-doc-id");
    if (!id) return null;
    const own = readFlowDisplacement(element);
    const acc = { dx: unitAcc.dx + own.dx, dy: unitAcc.dy + own.dy };
    const rect = toRect(element.getBoundingClientRect(), acc);
    const height = rect.bottom - rect.top;
    // 閉じた (中身の無い) 拡張ノードは行を持たない。
    if (isExtension && height <= 0.5) return null;
    seenNodeIds.add(id);
    // 編集面の版は面 (ProseMirror) が、拡張ノードの版は要素自身が持つ。
    const revision = (isExtension
      ? element.getAttribute(FLOW_MEASURE_REVISION_ATTRIBUTE)
      : element.closest<HTMLElement>(".ProseMirror")?.dataset.flowMeasureRevision) ?? "0";
    const cached = cache?.nodes.get(id);
    let inkRelative: ProbeInk[];
    let chromeRelative: ProbeChromeBox[];
    if (
      cached
      && cached.element === element
      && cached.revision === revision
      && Math.abs(cached.width - rect.width) < 0.01
      && Math.abs(cached.height - height) < 0.01
    ) {
      inkRelative = cached.ink;
      chromeRelative = cached.chrome;
    } else {
      const measured = measureNodeContent(
        element,
        (clientY) => toY(clientY, acc) - rect.top,
        isExtension ? EXTENSION_CONTENT_RULES : BLOCK_CONTENT_RULES,
      );
      inkRelative = measured.ink;
      chromeRelative = measured.chrome;
      cache?.nodes.set(id, { element, revision, width: rect.width, height, ink: inkRelative, chrome: chromeRelative });
    }
    const innerBreaks = isExtension
      || TEXT_LEAF_TAGS.has(element.tagName.toUpperCase())
      || (options.breakHostIds !== undefined && !options.breakHostIds.has(id))
      ? []
      : measureInnerBreaks(element, options.breakIds, (clientY) => toY(clientY, acc));
    return {
      id,
      ...(isExtension ? { kind: "extension" as const } : {}),
      rect,
      ink: inkRelative.map((ink) => ({ ...ink, top: ink.top + rect.top, bottom: ink.bottom + rect.top })),
      chrome: chromeRelative.map((box) => ({ ...box, top: box.top + rect.top, bottom: box.bottom + rect.top })),
      breakBefore: !isExtension && options.breakIds.has(id),
      ...(innerBreaks.length > 0 ? { innerBreaks } : {}),
    };
  };

  /** 編集面の最上位ブロックと拡張ノードを文書順に。 */
  const probeEditorNodes = (root: Element, unitAcc: Displacement): ProbeNode[] => {
    const nodes: ProbeNode[] = [];
    root.querySelectorAll<HTMLElement>(BODY_NODE_SELECTOR).forEach((element) => {
      const node = probeNode(element, unitAcc);
      if (node) nodes.push(node);
    });
    return nodes;
  };

  const units: ProbeUnit[] = [];
  flow.querySelectorAll<HTMLElement>(":scope > [data-flow-unit-id]").forEach((unitElement) => {
    const id = unitElement.getAttribute("data-flow-unit-id");
    if (!id) return;
    const acc = readFlowDisplacement(unitElement);
    const rect = toRect(unitElement.getBoundingClientRect(), acc);
    const span = unitElement.getAttribute(FLOW_SPAN_ATTRIBUTE) === "full" ? "full" : "column";
    const breakBefore = unitElement.getAttribute(FLOW_BREAK_BEFORE_ATTRIBUTE) === "true";

    if (unitElement.querySelector("[data-large-paste-deferred]")) {
      units.push({ id, rect, span, breakBefore, nodes: [], attachments: [], placeholder: true });
      return;
    }

    // 独立段組のユニット自身の列だけ。箱の中の段組 (同じ class を使う) を拾うと、そのユニットの
    // 本文ブロックを丸ごと見失う。
    const columnElements = Array.from(unitElement.querySelectorAll<HTMLElement>(
      ":scope > .layout-section-paper-body > .layout-section-independent-columns > .layout-section-independent-column[data-layout-column-index]",
    ));
    let nodes: ProbeNode[] = [];
    let columns: ProbeColumn[] | undefined;
    if (columnElements.length > 0) {
      columns = columnElements.map((columnElement) => ({
        index: Number(columnElement.getAttribute("data-layout-column-index") ?? 0),
        rect: toRect(columnElement.getBoundingClientRect(), acc),
        nodes: probeEditorNodes(columnElement, acc),
      }));
    } else {
      nodes = probeEditorNodes(unitElement, acc);
    }

    const attachments: ProbeInk[] = [];
    unitElement.querySelectorAll<HTMLElement>(".problem-number-marker").forEach((marker) => {
      // 拡張ノードの中身は拡張ノードの行。ユニットの付属物にしない。
      if (marker.closest(EXTENSION_NODE_SELECTOR)) return;
      const markerRect = marker.getBoundingClientRect();
      if (markerRect.height > 0.5) {
        attachments.push({ top: toY(markerRect.top, acc), bottom: toY(markerRect.bottom, acc), kind: "atom" });
      }
    });

    let frame: ProbeUnit["frame"];
    if (unitElement.classList.contains("with-frame")) {
      const problemId = unitElement.getAttribute("data-problem-id") ?? id;
      const frameStyle = getComputedStyle(unitElement);
      frame = {
        borderLeft: Number.parseFloat(frameStyle.borderLeftWidth) || 0,
        borderTop: Number.parseFloat(frameStyle.borderTopWidth) || 0,
        key: `${problemId}:frame`,
        first: unitElement.classList.contains("first-frame-area"),
        last: unitElement.classList.contains("last-frame-area"),
        top: rect.top,
        bottom: rect.bottom,
      };
    }

    let reservation: ProbeUnit["reservation"];
    const minHeight = Number.parseFloat(unitElement.style.minHeight || "0");
    if (minHeight > 0) {
      const contentElement = unitElement.querySelector<HTMLElement>(
        ":scope > .problem-area-paper-content, :scope > .layout-section-paper-body",
      );
      if (contentElement) {
        // 中身の下に置かれた拡張ノード (問題の後ろの差し込み) も中身。予約はその下から。
        const contentBottom = Math.max(
          toY(contentElement.getBoundingClientRect().bottom, acc),
          ...nodes.filter((node) => node.kind === "extension").map((node) => node.rect.bottom),
        );
        const style = getComputedStyle(unitElement);
        const closing = (Number.parseFloat(style.paddingBottom) || 0) + (Number.parseFloat(style.borderBottomWidth) || 0);
        const reservationBottom = rect.bottom - (frame?.last ? closing : 0);
        if (reservationBottom > contentBottom + 0.5) {
          reservation = { top: contentBottom, bottom: reservationBottom };
        }
      }
    }

    units.push({
      id,
      rect,
      span,
      breakBefore,
      nodes,
      ...(columns ? { columns } : {}),
      attachments,
      ...(frame ? { frame } : {}),
      ...(reservation ? { reservation } : {}),
    });
  });

  if (cache) {
    for (const key of cache.nodes.keys()) {
      if (!seenNodeIds.has(key)) cache.nodes.delete(key);
    }
  }
  return { units };
}

/**
 * 最上位ブロックの中 (引用・箱・入れ子の問題など) の子に保存された手動改ページの位置。
 * 複数段の段組みの中の改ページは、その段組み自身の改段なので外側の改ページには使わない。
 */
function measureInnerBreaks(
  element: HTMLElement,
  breakIds: ReadonlySet<string>,
  toY: (clientY: number) => number,
): ProbeInnerBreak[] {
  if (breakIds.size === 0) return [];
  // 子の前の改ページの印 (編集面では見え、PDF 面では場所だけ残る)。
  const markerTops = new Map<string, number>();
  element.querySelectorAll<HTMLElement>(".page-break-marker[data-page-break-block-id]").forEach((marker) => {
    const id = marker.getAttribute("data-page-break-block-id");
    if (id && !markerTops.has(id)) markerTops.set(id, toY(marker.getBoundingClientRect().top));
  });
  const breaks: ProbeInnerBreak[] = [];
  element.querySelectorAll<HTMLElement>("[data-sigma-doc-id]").forEach((child) => {
    const id = child.getAttribute("data-sigma-doc-id");
    if (!id || !breakIds.has(id)) return;
    const section = child.parentElement?.closest<HTMLElement>(".sigma-doc-layout-section-block");
    if (section && element.contains(section) && Number(section.getAttribute("data-column-count") ?? 1) > 1) return;
    const top = toY(child.getBoundingClientRect().top);
    breaks.push({ top, contentEnd: Math.min(top, markerTops.get(id) ?? top) });
  });
  return breaks.sort((a, b) => a.top - b.top);
}

/**
 * 1 つの最上位ブロックの中身を読む。値はブロック上端からの相対 y。
 * 行内原子 (数式・囲み枠) は子孫の文字矩形ではなく全体で読む — 分数の分子と分母を
 * 別の行と数えると、その間で改ページされてしまう。
 */
function measureNodeContent(
  element: HTMLElement,
  toRelativeY: (clientY: number) => number,
  rules: ContentMeasureRules,
): { ink: ProbeInk[]; chrome: ProbeChromeBox[] } {
  const ink: ProbeInk[] = [];
  const chrome: ProbeChromeBox[] = [];
  const range = element.ownerDocument.createRange();
  const view = element.ownerDocument.defaultView;
  const ownerId = element.getAttribute("data-sigma-doc-id") ?? element.getAttribute(FLOW_EXTENSION_NODE_ATTRIBUTE);
  /** client 座標の縦の可視範囲。スクロール・クリップする子孫の外の描画は紙面に見えない。 */
  interface Clip { top: number; bottom: number }
  const NO_CLIP: Clip = { top: Number.NEGATIVE_INFINITY, bottom: Number.POSITIVE_INFINITY };
  const visibleSpan = (rect: DOMRect | DOMRectReadOnly, clip: Clip) => {
    const top = Math.max(rect.top, clip.top);
    const bottom = Math.min(rect.bottom, clip.bottom);
    return bottom - top > 0.5 ? { top, bottom } : null;
  };
  const pushRect = (rect: DOMRect | DOMRectReadOnly, kind: ProbeInk["kind"], clip: Clip) => {
    if (rect.height <= 0.5) return;
    const span = visibleSpan(rect, clip);
    if (!span) return;
    ink.push({ top: toRelativeY(span.top), bottom: toRelativeY(span.bottom), kind });
  };
  const clipOf = (current: Element, clip: Clip): Clip => {
    if (!rules.clipToOverflow || current === element || !view) return clip;
    const style = view.getComputedStyle(current);
    const overflow = style.overflowY || style.overflow;
    if (!overflow || overflow === "visible") return clip;
    const rect = current.getBoundingClientRect();
    return { top: Math.max(clip.top, rect.top), bottom: Math.min(clip.bottom, rect.bottom) };
  };

  const visit = (current: Element, parentClip: Clip) => {
    // display:none の要素は矩形を持たないので、ここで style を引く必要は無い (打鍵ごとの計測を重くしない)。
    if (current !== element && current.matches(rules.excluded)) return;
    if (current.matches(CHROME_SELECTOR)) {
      const span = visibleSpan(current.getBoundingClientRect(), parentClip);
      if (span) {
        chrome.push({
          id: current.getAttribute("data-sigma-doc-id") ?? `${ownerId}:chrome:${chrome.length}`,
          top: toRelativeY(span.top),
          bottom: toRelativeY(span.bottom),
        });
      }
    }
    if (current.matches(".sigma-doc-box-title") && !(current.textContent ?? "").trim()) {
      // 空のタイトル帯は箱の上縁の一部 (開き側の縁) として扱い、行にしない。
      return;
    }
    if (current !== element && current.matches(INLINE_ATOM_SELECTOR)) {
      for (const rect of Array.from(current.getClientRects())) pushRect(rect, "atom", parentClip);
      return;
    }
    if (OBJECT_TAGS.has(current.tagName.toUpperCase())) {
      pushRect(current.getBoundingClientRect(), "object", parentClip);
      return;
    }
    const clip = clipOf(current, parentClip);
    for (const child of Array.from(current.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (!(child.textContent ?? "").trim()) continue;
        range.selectNodeContents(child);
        for (const rect of Array.from(range.getClientRects())) pushRect(rect, "text", clip);
        continue;
      }
      if (child instanceof HTMLBRElement) {
        range.selectNode(child);
        pushRect(range.getBoundingClientRect(), "empty", clip);
        continue;
      }
      if (child instanceof Element) visit(child, clip);
    }
  };
  visit(element, NO_CLIP);
  return { ink, chrome };
}
