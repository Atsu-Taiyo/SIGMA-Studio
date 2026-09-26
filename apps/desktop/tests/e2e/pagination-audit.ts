import type { Page } from "@playwright/test";

/**
 * 実描画から「Word と同じ改ページ」になっているかを検査する。
 *
 * 行 = テキストの行ボックス・空段落の行・問題番号などの付属物。どれもページ下端を
 * またいではならず、途中で切れてもならず、ちょうど 1 回だけ見えていなければならない。
 * さらに次ページ先頭の行は、前ページの残りに入らない高さでなければならない
 * (入るのに送られていたら「ブロックごと送った」証拠)。
 */
export interface AuditLine {
  key: string;
  blockId: string;
  text: string;
  /** canvas 座標 (ズーム除去済み) の可視範囲。 */
  top: number;
  bottom: number;
  /** クリップ前の行ボックス全体。 */
  fullTop: number;
  fullBottom: number;
  left: number;
  page: number;
  /** ページ内の段 (0 始まり)。1 段組では常に 0。 */
  column: number;
  /** この行を含むブロックに手動改ページが付いているか。 */
  manualBreak: boolean;
  /**
   * この行が見える縁を持つ入れ物 (箱・コード・枠付き問題文) の最後の行なら、閉じ側の縁の高さ。
   * 閉じ側の縁は最後の行と同じページに置く規則なので、送りの最小性はこの分も含めて判定する。
   */
  closingChrome: number;
  /** 文書順 (本文フローの DOM 順)。断片の複製も元と同じ値になる。 */
  order: number;
  /** 段組みのページで本文幅に広がる区間 (全幅の問題など) の行か。 */
  fullSpan: boolean;
  /** 部分段組 (独立した列) の中の行か。列どうしは横に並ぶので文書順と縦の順が一致しない。 */
  inBand: boolean;
}

export interface PaginationAuditResult {
  pageCount: number;
  contentTop: number[];
  contentBottom: number[];
  lines: AuditLine[];
  violations: string[];
}

export interface PaginationAuditOptions {
  marginTopMm: number;
  marginBottomMm: number;
  pageHeightMm: number;
  /** 次ページ先頭行が前ページに収まったかを判定するときの許容量 (px)。 */
  fitTolerancePx?: number;
  marginLeftMm?: number;
  columnCount?: number;
  columnWidthMm?: number;
  columnGapMm?: number;
  /** 手動改ページを持つブロック (と問題) の id。直後の送りは最小性の検査から外す。 */
  manualBreakBlockIds?: readonly string[];
}

/** 紙面に出ない編集用の飾り。行として数えない。 */
const EXCLUDED_SELECTOR = [
  ".katex-mathml",
  ".page-backdrop",
  ".page-layout-controls",
  ".page-overlay-background-layer",
  ".page-overlay-layer",
  ".problem-area-side-note",
  ".problem-area-side-label",
  ".layout-section-side-note",
  ".box-layout-section-side-note-layer",
  ".page-break-marker",
  ".page-flow-page-break-marker",
  ".manual-break-marker",
  ".page-block-handle",
  ".page-block-space-handle",
  "[aria-hidden='true']",
  "[data-editor-only]",
].join(",");

export async function auditPagination(page: Page, options: PaginationAuditOptions): Promise<PaginationAuditResult> {
  return page.evaluate(({ options, excluded }) => {
    const mmToPx = 96 / 25.4;
    const canvas = document.querySelector<HTMLElement>(".page-canvas");
    if (!canvas) throw new Error("page canvas missing");
    const pageCount = Number(canvas.dataset.pageCount);
    const pageHeight = Number(canvas.dataset.pageHeight);
    const stride = Number(canvas.dataset.pageStride);
    const canvasRect = canvas.getBoundingClientRect();
    const scale = canvasRect.height / canvas.offsetHeight || 1;
    const toCanvasY = (clientY: number) => (clientY - canvasRect.top) / scale;
    const contentTop: number[] = [];
    const contentBottom: number[] = [];
    for (let index = 0; index < pageCount; index += 1) {
      contentTop.push(index * stride + options.marginTopMm * mmToPx);
      contentBottom.push(index * stride + (options.pageHeightMm - options.marginBottomMm) * mmToPx);
    }
    void pageHeight;

    // 祖先のクリップ (overflow / clip-path inset / 断片の可視高) を client 座標の縦範囲で返す。
    const clipCache = new Map<Element, { top: number; bottom: number }>();
    const clipOf = (element: Element | null): { top: number; bottom: number } => {
      if (!element || element === document.body) return { top: -Infinity, bottom: Infinity };
      const cached = clipCache.get(element);
      if (cached) return cached;
      const parent = clipOf(element.parentElement);
      let top = parent.top;
      let bottom = parent.bottom;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const clipsY = /(hidden|clip|scroll|auto)/.test(style.overflowY) || /(hidden|clip|scroll|auto)/.test(style.overflow);
      if (clipsY && element !== document.documentElement) {
        top = Math.max(top, rect.top);
        bottom = Math.min(bottom, rect.bottom);
      }
      if (element instanceof HTMLElement && element.classList.contains("text-flow-box-fragment-source")) {
        const visible = Number.parseFloat(element.style.getPropertyValue("--text-flow-box-fragment-visible-height"));
        if (Number.isFinite(visible)) {
          bottom = Math.min(bottom, rect.top + visible * scale);
        }
      } else if (style.clipPath && style.clipPath.startsWith("inset(")) {
        const values = style.clipPath.slice(6, -1).split(/\s+/).map((value) => Number.parseFloat(value));
        if (values.every((value) => Number.isFinite(value))) {
          const [insetTop, , insetBottom = insetTop] = values;
          top = Math.max(top, rect.top + insetTop * scale);
          bottom = Math.min(bottom, rect.bottom - insetBottom * scale);
        }
      }
      if (style.display === "none" || style.visibility === "hidden") {
        top = Infinity;
        bottom = -Infinity;
      }
      const clip = { top, bottom };
      clipCache.set(element, clip);
      return clip;
    };

    const blockOf = (node: Node): HTMLElement | null => (
      (node instanceof HTMLElement ? node : node.parentElement)?.closest<HTMLElement>("[data-sigma-doc-id]") ?? null
    );
    const manualBreakIds = new Set(options.manualBreakBlockIds ?? []);
    const manualBreakOf = (element: HTMLElement | null) => {
      for (let current = element; current; current = current.parentElement?.closest<HTMLElement>("[data-sigma-doc-id], [data-problem-id]") ?? null) {
        if (manualBreakIds.has(current.dataset.sigmaDocId ?? "") || manualBreakIds.has(current.dataset.problemId ?? "")) return true;
      }
      return false;
    };

    const roots = Array.from(canvas.querySelectorAll<HTMLElement>(".page-flow, .editor-box-fragment-viewport"));
    const lines: AuditLine[] = [];
    // 文書順と区間の種類は本文フローの DOM から決める (断片の複製はキーで引き継ぐ)。
    const orderByKey = new Map<string, number>();
    const fullSpanKeys = new Set<string>();
    const bandKeys = new Set<string>();
    const noteOrder = (key: string, element: Element) => {
      if (orderByKey.has(key)) return;
      orderByKey.set(key, orderByKey.size);
      // 全幅: 段組みのページで、行を含むユニットの幅が段の幅より広い (実装の印ではなく見た目で決める)。
      const unit = element.closest<HTMLElement>("[data-flow-unit-id]");
      const columnWidthPx = (options.columnWidthMm ?? 0) * mmToPx;
      if ((options.columnCount ?? 1) > 1 && unit && unit.getBoundingClientRect().width / scale > columnWidthPx + 2) fullSpanKeys.add(key);
      if (element.closest(".layout-section-independent-column")) bandKeys.add(key);
    };
    const CHROME_SELECTOR = ".sigma-doc-box-block, pre, .problem-area-flow-unit.with-frame.last-frame-area";
    const linesByChrome = new Map<Element, AuditLine[]>();
    const pushLine = (keyBase: string, block: HTMLElement | null, text: string, rect: DOMRect, clip: { top: number; bottom: number }) => {
      if (rect.height < 1) return;
      const visTop = Math.max(rect.top, clip.top);
      const visBottom = Math.min(rect.bottom, clip.bottom);
      if (visBottom - visTop < 0.5) return;
      const top = toCanvasY(visTop);
      const bottom = toCanvasY(visBottom);
      const center = (top + bottom) / 2;
      lines.push({
        key: keyBase,
        blockId: block?.dataset.sigmaDocId ?? "",
        text: text.slice(0, 24),
        top,
        bottom,
        fullTop: toCanvasY(rect.top),
        fullBottom: toCanvasY(rect.bottom),
        left: (rect.left - canvasRect.left) / scale,
        page: Math.max(0, Math.min(pageCount - 1, Math.floor(center / stride))),
        column: (() => {
          const count = options.columnCount ?? 1;
          if (count <= 1) return 0;
          const left = (rect.left - canvasRect.left) / scale - (options.marginLeftMm ?? 0) * mmToPx;
          const step = ((options.columnWidthMm ?? 0) + (options.columnGapMm ?? 0)) * mmToPx;
          return Math.max(0, Math.min(count - 1, Math.floor((left + 1) / step)));
        })(),
        manualBreak: manualBreakOf(block),
        closingChrome: 0,
        order: orderByKey.get(keyBase) ?? Number.POSITIVE_INFINITY,
        fullSpan: fullSpanKeys.has(keyBase),
        inBand: bandKeys.has(keyBase),
      });
      const line = lines[lines.length - 1];
      for (let chrome = block?.closest(CHROME_SELECTOR) ?? null; chrome; chrome = chrome.parentElement?.closest(CHROME_SELECTOR) ?? null) {
        const existing = linesByChrome.get(chrome);
        if (existing) existing.push(line);
        else linesByChrome.set(chrome, [line]);
      }
    };

    for (const root of roots) {
      // 同じ source の断片は同じ DOM を持つ。キーは root を含めず、全断片を通して数える。
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      const perRootCounters = new Map<string, number>();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const element = node instanceof HTMLElement ? node : node.parentElement;
        if (!element || element.closest(excluded)) continue;
        // 断片は別の root として数える (キーが元と揃うように)。
        const viewport = element.closest(".editor-box-fragment-viewport");
        if (viewport && viewport !== root) continue;
        // 問題番号は枠の外 (ブロックの外) にあるので、問題とエリアで区別する。数字は印として 1 回だけ数える。
        if (node.nodeType === Node.TEXT_NODE && element.closest(".problem-number-marker")) continue;
        const block = blockOf(node);
        const area = block ? null : element.closest<HTMLElement>("[data-problem-id]");
        const blockId = block?.dataset.sigmaDocId ?? (area ? `${area.dataset.problemId}:${area.dataset.problemArea ?? ""}` : "(none)");
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent ?? "";
          if (!text.trim()) continue;
          const localIndex = perRootCounters.get(blockId) ?? 0;
          perRootCounters.set(blockId, localIndex + 1);
          const range = document.createRange();
          range.selectNodeContents(node);
          const clip = clipOf(element);
          Array.from(range.getClientRects()).forEach((rect, rectIndex) => {
            if (!viewport) noteOrder(`${blockId}:t${localIndex}:r${rectIndex}`, element);
            pushLine(`${blockId}:t${localIndex}:r${rectIndex}`, block, text, rect, clip);
          });
          continue;
        }
        if (node instanceof HTMLBRElement && node.classList.contains("ProseMirror-trailingBreak")) {
          const paragraph = node.parentElement;
          if (!paragraph || (paragraph.textContent ?? "").trim()) continue;
          const range = document.createRange();
          range.selectNode(node);
          let rect = range.getBoundingClientRect();
          if (rect.height < 1) rect = paragraph.getBoundingClientRect();
          if (!viewport) noteOrder(`${blockId}:empty`, paragraph);
          pushLine(`${blockId}:empty`, block, "↵", rect, clipOf(paragraph));
          continue;
        }
        if (node instanceof HTMLElement && node.classList.contains("problem-number-marker")) {
          if (!viewport) noteOrder(`${blockId}:marker`, node);
          pushLine(`${blockId}:marker`, block, node.textContent ?? "", node.getBoundingClientRect(), clipOf(node));
        }
      }
      void perRootCounters;
    }

    for (const [chrome, chromeLines] of linesByChrome) {
      const last = chromeLines.reduce((a, b) => (b.fullBottom > a.fullBottom ? b : a));
      const chromeBottom = toCanvasY(chrome.getBoundingClientRect().bottom);
      last.closingChrome = Math.max(last.closingChrome, chromeBottom - last.fullBottom);
    }

    // 同じキーは断片ごとに同じ順で現れる。キーごとの出現を束ね、可視部分を合算する。
    const violations: string[] = [];
    const byKey = new Map<string, AuditLine[]>();
    for (const line of lines) {
      const existing = byKey.get(line.key);
      if (existing) existing.push(line);
      else byKey.set(line.key, [line]);
    }
    const visibleLines: AuditLine[] = [];
    for (const [key, occurrences] of byKey) {
      if (occurrences.length > 1) {
        violations.push(`duplicated line ${key} "${occurrences[0].text}" on pages ${occurrences.map((line) => line.page + 1).join(",")}`);
      }
      const line = occurrences[0];
      const fullHeight = line.fullBottom - line.fullTop;
      const visibleHeight = occurrences.reduce((sum, item) => sum + (item.bottom - item.top), 0);
      if (visibleHeight < fullHeight - 1.5) {
        violations.push(`cut line ${key} "${line.text}" page ${line.page + 1}: visible ${visibleHeight.toFixed(1)} of ${fullHeight.toFixed(1)}px`);
      }
      for (const item of occurrences) {
        const pageTop = contentTop[item.page] ?? 0;
        const pageBottom = contentBottom[item.page] ?? 0;
        if (item.bottom > pageBottom + 1 || item.top < pageTop - 1) {
          violations.push(`line outside page body ${key} "${item.text}" page ${item.page + 1}: ${item.top.toFixed(1)}-${item.bottom.toFixed(1)} (body ${pageTop.toFixed(1)}-${pageBottom.toFixed(1)})`);
        }
      }
      visibleLines.push(line);
    }
    violations.push(...readingOrderViolations(visibleLines));
    return { pageCount, contentTop, contentBottom, lines: visibleLines, violations };

    /**
     * 読む順の検査。
     * - 全幅の行と同じページの行は、文書順で前なら全幅の行より上、後なら下にある。
     * - 全幅の行で区切られた区間の中では、(ページ, 段, 縦位置) の順が文書順と一致する
     *   (部分段組の列の中の行は横に並ぶので除く。縦に重なる行どうしは同じ行とみなす)。
     */
    function readingOrderViolations(all: AuditLine[]): string[] {
      const found: string[] = [];
      const sorted = [...all].filter((line) => Number.isFinite(line.order)).sort((a, b) => a.order - b.order);
      for (const wide of sorted.filter((line) => line.fullSpan)) {
        for (const other of sorted) {
          if (other.fullSpan || other.page !== wide.page) continue;
          if (other.order > wide.order && other.top < wide.bottom - 1) {
            found.push(`line ${other.key} "${other.text}" is above the full-width line ${wide.key} it follows (page ${wide.page + 1})`);
          } else if (other.order < wide.order && other.bottom > wide.top + 1) {
            found.push(`line ${other.key} "${other.text}" is below the full-width line ${wide.key} it precedes (page ${wide.page + 1})`);
          }
        }
      }
      let previous: AuditLine | null = null;
      for (const line of sorted) {
        if (line.fullSpan) {
          previous = null;
          continue;
        }
        if (line.inBand) continue;
        if (previous) {
          const before = previous.page * 100 + previous.column;
          const here = line.page * 100 + line.column;
          // 同じ段では「後の行が前の行より丸ごと上にある」ときだけ違反 (同じ行に並ぶ飾りは順不同)。
          if (here < before || (here === before && line.bottom <= previous.top + 1)) {
            found.push(`line ${line.key} "${line.text}" (page ${line.page + 1} column ${line.column + 1}) comes before ${previous.key} "${previous.text}" (page ${previous.page + 1} column ${previous.column + 1}) in reading order`);
          }
        }
        previous = line;
      }
      return found;
    }
  }, { options, excluded: EXCLUDED_SELECTOR });
}

/**
 * 同じ文書を用紙 1 枚に収まる高さで描いた自然配置と比べ、改ページの最小性を検査する。
 * 領域 k の最後の行 L と次の領域の先頭の行 M について、自然配置での L→M の送り量を
 * 領域 k の残りに足しても下端を越えないなら、M は前の領域に入ったはず。
 *
 * 領域は (ページ, 区間, 段)。区間は文書順で全幅の行の並びが始まる・終わるたびに変わる。
 * 同じページの中で区間が変わるのは送りではない (全幅の区間は段組みの直下から始まる) ので検査しない。
 * 全幅の区間の直前の段組みは左右を揃えて詰めるので、そのページの段から段への送りも検査しない。
 */
export function findUnderfilledBreaks(
  paged: PaginationAuditResult,
  natural: PaginationAuditResult,
  tolerancePx = 1,
): string[] {
  const naturalByKey = new Map(natural.lines.map((line) => [line.key, line]));
  const violations: string[] = [];
  const ordered = [...paged.lines].sort((a, b) => a.order - b.order);
  const sectionOf = new Map<AuditLine, number>();
  let section = 0;
  let previousFullSpan: boolean | null = null;
  for (const line of ordered) {
    if (previousFullSpan !== null && line.fullSpan !== previousFullSpan) section += 1;
    previousFullSpan = line.fullSpan;
    sectionOf.set(line, section);
  }
  interface RegionLines { page: number; section: number; column: number; lines: AuditLine[] }
  const regions = new Map<string, RegionLines>();
  for (const line of ordered) {
    const lineSection = sectionOf.get(line) ?? 0;
    const column = line.fullSpan ? 0 : line.column;
    const key = `${line.page}:${lineSection}:${column}`;
    const existing = regions.get(key);
    if (existing) existing.lines.push(line);
    else regions.set(key, { page: line.page, section: lineSection, column, lines: [line] });
  }
  const sorted = [...regions.values()].sort((a, b) => a.page - b.page || a.section - b.section || a.column - b.column);
  const balancedPageSections = new Set<string>();
  for (const region of sorted) {
    if (sorted.some((other) => other.page === region.page && other.section > region.section)) {
      balancedPageSections.add(`${region.page}:${region.section}`);
    }
  }
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const current = sorted[index];
    const next = sorted[index + 1];
    if (next.page === current.page && next.section !== current.section) continue;
    if (next.page === current.page && balancedPageSections.has(`${current.page}:${current.section}`)) continue;
    const pageLines = next.section !== current.section
      ? sorted.filter((region) => region.page === current.page && region.section === current.section).flatMap((region) => region.lines)
      : current.lines;
    const last = pageLines.reduce((a, b) => (b.bottom > a.bottom ? b : a));
    const first = next.lines.reduce((a, b) => (b.top < a.top ? b : a));
    if (first.manualBreak) continue;
    const naturalLast = naturalByKey.get(last.key);
    const naturalFirst = naturalByKey.get(first.key);
    const label = `page ${current.page + 1} column ${current.column + 1}`;
    if (!naturalLast || !naturalFirst) {
      violations.push(`${label}: first line ${first.key} of the next region has no natural counterpart`);
      continue;
    }
    const advance = naturalFirst.fullBottom + naturalFirst.closingChrome - naturalLast.fullBottom;
    if (advance <= 0) continue;
    const wouldBottom = last.bottom + advance;
    if (wouldBottom <= paged.contentBottom[current.page] - tolerancePx) {
      violations.push(
        `${label} underfilled: "${first.text}" (${first.key}) needs ${advance.toFixed(1)}px, `
        + `${(paged.contentBottom[current.page] - last.bottom).toFixed(1)}px left`,
      );
    }
  }
  const pagedKeys = new Set(paged.lines.map((line) => line.key));
  for (const line of natural.lines) {
    if (!pagedKeys.has(line.key)) violations.push(`missing line ${line.key} "${line.text}"`);
  }
  for (const line of paged.lines) {
    if (!naturalByKey.has(line.key)) violations.push(`extra line ${line.key} "${line.text}"`);
  }
  return violations;
}
