import type {
  ProbeChromeBox,
  ProbeColumn,
  ProbeInk,
  ProbeNode,
  ProbeRect,
  ProbeTree,
  ProbeUnit,
} from "@/features/rendering/core";

/**
 * 本文フローの**自然配置**を読む。
 *
 * ページ割りは本文を動かさない: ユニットと最上位ブロックへの配置は、レイアウトに影響しない
 * CSS `translate` で与え、同じ量を `data-flow-dx` / `data-flow-dy` に書く。ここでは読んだ矩形から
 * その量を差し引くので、結果はページ割りの答えに依存しない (= 計測→配置は開ループ)。
 * 以前の「隙間 (spacer / margin) を入れた DOM を読み、適用済みの隙間を推定で引く」閉ループは、
 * margin の相殺や計測のタイミングで推定がずれ、答えが往復して誤った配置で凍結していた。
 */

export const FLOW_DX_ATTRIBUTE = "data-flow-dx";
export const FLOW_DY_ATTRIBUTE = "data-flow-dy";
export const FLOW_BREAK_BEFORE_ATTRIBUTE = "data-flow-break-before";
export const FLOW_SPAN_ATTRIBUTE = "data-flow-span";

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

/** 分割できない行内要素。子孫の矩形ではなく全体を 1 つの矩形として読む。 */
const INLINE_ATOM_SELECTOR = ".inline-math-node, .boxed-run-frame, .math-preview";
/** 分割できないブロック要素 (区切り線・画像など)。 */
const OBJECT_TAGS = new Set(["HR", "IMG", "SVG", "CANVAS", "VIDEO", "IFRAME", "OBJECT", "EMBED"]);
/** 上下に見える縁を持つ入れ物。 */
const CHROME_SELECTOR = ".sigma-doc-box-block, pre";

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
    const id = element.getAttribute("data-sigma-doc-id");
    if (!id) return null;
    seenNodeIds.add(id);
    const own = readFlowDisplacement(element);
    const acc = { dx: unitAcc.dx + own.dx, dy: unitAcc.dy + own.dy };
    const rect = toRect(element.getBoundingClientRect(), acc);
    const height = rect.bottom - rect.top;
    const revision = element.closest<HTMLElement>(".ProseMirror")?.dataset.flowMeasureRevision ?? "0";
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
      const measured = measureNodeContent(element, (clientY) => toY(clientY, acc) - rect.top);
      inkRelative = measured.ink;
      chromeRelative = measured.chrome;
      cache?.nodes.set(id, { element, revision, width: rect.width, height, ink: inkRelative, chrome: chromeRelative });
    }
    const innerBreaks = element.getAttribute("data-sigma-doc-type") === "boxBlock"
      ? measureInnerBreaks(element, options.breakIds, (clientY) => toY(clientY, acc))
      : [];
    return {
      id,
      rect,
      ink: inkRelative.map((ink) => ({ ...ink, top: ink.top + rect.top, bottom: ink.bottom + rect.top })),
      chrome: chromeRelative.map((box) => ({ ...box, top: box.top + rect.top, bottom: box.bottom + rect.top })),
      breakBefore: options.breakIds.has(id),
      ...(innerBreaks.length > 0 ? { innerBreaks } : {}),
    };
  };

  const probeEditorNodes = (root: Element, unitAcc: Displacement): ProbeNode[] => {
    const nodes: ProbeNode[] = [];
    root.querySelectorAll<HTMLElement>(".ProseMirror > [data-sigma-doc-id]").forEach((element) => {
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
      units.push({ id, rect, span, breakBefore, nodes: [], attachments: [], objects: [], placeholder: true });
      return;
    }

    const columnElements = Array.from(unitElement.querySelectorAll<HTMLElement>(".layout-section-independent-column[data-layout-column-index]"));
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
        const contentBottom = toY(contentElement.getBoundingClientRect().bottom, acc);
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
      objects: [],
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
 * 箱の中の子に保存された手動改ページの位置。複数段の段組みの中の改ページは、その段組み
 * 自身の改段なので外側の改ページには使わない。
 */
function measureInnerBreaks(
  element: HTMLElement,
  breakIds: ReadonlySet<string>,
  toY: (clientY: number) => number,
): number[] {
  if (breakIds.size === 0) return [];
  const positions: number[] = [];
  element.querySelectorAll<HTMLElement>("[data-sigma-doc-id]").forEach((child) => {
    const id = child.getAttribute("data-sigma-doc-id");
    if (!id || !breakIds.has(id)) return;
    const section = child.parentElement?.closest<HTMLElement>(".sigma-doc-layout-section-block");
    if (section && element.contains(section) && Number(section.getAttribute("data-column-count") ?? 1) > 1) return;
    positions.push(toY(child.getBoundingClientRect().top));
  });
  return positions.sort((a, b) => a - b);
}

/**
 * 1 つの最上位ブロックの中身を読む。値はブロック上端からの相対 y。
 * 行内原子 (数式・囲み枠) は子孫の文字矩形ではなく全体で読む — 分数の分子と分母を
 * 別の行と数えると、その間で改ページされてしまう。
 */
function measureNodeContent(
  element: HTMLElement,
  toRelativeY: (clientY: number) => number,
): { ink: ProbeInk[]; chrome: ProbeChromeBox[] } {
  const ink: ProbeInk[] = [];
  const chrome: ProbeChromeBox[] = [];
  const range = element.ownerDocument.createRange();
  const pushRect = (rect: DOMRect | DOMRectReadOnly, kind: ProbeInk["kind"]) => {
    if (rect.height <= 0.5) return;
    ink.push({ top: toRelativeY(rect.top), bottom: toRelativeY(rect.bottom), kind });
  };

  const visit = (current: Element) => {
    // display:none の要素は矩形を持たないので、ここで style を引く必要は無い (打鍵ごとの計測を重くしない)。
    if (current !== element && current.matches(EDITOR_ONLY_SELECTOR)) return;
    if (current.matches(CHROME_SELECTOR)) {
      const rect = current.getBoundingClientRect();
      if (rect.height > 0.5) {
        chrome.push({
          id: current.getAttribute("data-sigma-doc-id") ?? `${element.getAttribute("data-sigma-doc-id")}:chrome:${chrome.length}`,
          top: toRelativeY(rect.top),
          bottom: toRelativeY(rect.bottom),
        });
      }
    }
    if (current.matches(".sigma-doc-box-title") && !(current.textContent ?? "").trim()) {
      // 空のタイトル帯は箱の上縁の一部 (開き側の縁) として扱い、行にしない。
      return;
    }
    if (current !== element && current.matches(INLINE_ATOM_SELECTOR)) {
      for (const rect of Array.from(current.getClientRects())) pushRect(rect, "atom");
      return;
    }
    if (current !== element && OBJECT_TAGS.has(current.tagName.toUpperCase())) {
      pushRect(current.getBoundingClientRect(), "object");
      return;
    }
    if (current === element && OBJECT_TAGS.has(current.tagName.toUpperCase())) {
      pushRect(current.getBoundingClientRect(), "object");
      return;
    }
    for (const child of Array.from(current.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (!(child.textContent ?? "").trim()) continue;
        range.selectNodeContents(child);
        for (const rect of Array.from(range.getClientRects())) pushRect(rect, "text");
        continue;
      }
      if (child instanceof HTMLBRElement) {
        range.selectNode(child);
        pushRect(range.getBoundingClientRect(), "empty");
        continue;
      }
      if (child instanceof Element) visit(child);
    }
  };
  visit(element);
  return { ink, chrome };
}
