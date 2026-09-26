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
        const block = blockOf(node);
        const blockId = block?.dataset.sigmaDocId ?? "(none)";
        if (node.nodeType === Node.TEXT_NODE) {
          const text = node.textContent ?? "";
          if (!text.trim()) continue;
          const localIndex = perRootCounters.get(blockId) ?? 0;
          perRootCounters.set(blockId, localIndex + 1);
          const range = document.createRange();
          range.selectNodeContents(node);
          const clip = clipOf(element);
          Array.from(range.getClientRects()).forEach((rect, rectIndex) => {
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
          pushLine(`${blockId}:empty`, block, "↵", rect, clipOf(paragraph));
          continue;
        }
        if (node instanceof HTMLElement && node.classList.contains("problem-number-marker")) {
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
    return { pageCount, contentTop, contentBottom, lines: visibleLines, violations };
  }, { options, excluded: EXCLUDED_SELECTOR });
}

/**
 * 同じ文書を用紙 1 枚に収まる高さで描いた自然配置と比べ、改ページの最小性を検査する。
 * ページ k の最後の行 L と次ページ先頭の行 M について、自然配置での L→M の送り量を
 * ページ k の残りに足しても下端を越えないなら、M は前ページに入ったはず。
 */
export function findUnderfilledBreaks(
  paged: PaginationAuditResult,
  natural: PaginationAuditResult,
  tolerancePx = 1,
): string[] {
  const naturalByKey = new Map(natural.lines.map((line) => [line.key, line]));
  const violations: string[] = [];
  // 領域 = (ページ, 段)。読む順に並べ、隣り合う領域の間の送りが最小かを見る。
  const regionKey = (line: AuditLine) => line.page * 100 + line.column;
  const byRegion = new Map<number, AuditLine[]>();
  for (const line of paged.lines) {
    const key = regionKey(line);
    const existing = byRegion.get(key);
    if (existing) existing.push(line);
    else byRegion.set(key, [line]);
  }
  const regionKeys = [...byRegion.keys()].sort((a, b) => a - b);
  for (let index = 0; index < regionKeys.length - 1; index += 1) {
    const current = byRegion.get(regionKeys[index]) ?? [];
    const next = byRegion.get(regionKeys[index + 1]) ?? [];
    const pageIndex = Math.floor(regionKeys[index] / 100);
    if (current.length === 0 || next.length === 0) continue;
    const last = current.reduce((a, b) => (b.bottom > a.bottom ? b : a));
    const first = next.reduce((a, b) => (b.top < a.top ? b : a));
    if (first.manualBreak) continue;
    const naturalLast = naturalByKey.get(last.key);
    const naturalFirst = naturalByKey.get(first.key);
    if (!naturalLast || !naturalFirst) {
      violations.push(`region ${regionKeys[index + 1]} first line ${first.key} has no natural counterpart`);
      continue;
    }
    const advance = naturalFirst.fullBottom + naturalFirst.closingChrome - naturalLast.fullBottom;
    if (advance <= 0) continue;
    const wouldBottom = last.bottom + advance;
    if (wouldBottom <= paged.contentBottom[pageIndex] - tolerancePx) {
      violations.push(
        `region ${regionKeys[index]} underfilled: "${first.text}" (${first.key}) needs ${advance.toFixed(1)}px, `
        + `${(paged.contentBottom[pageIndex] - last.bottom).toFixed(1)}px left`,
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
