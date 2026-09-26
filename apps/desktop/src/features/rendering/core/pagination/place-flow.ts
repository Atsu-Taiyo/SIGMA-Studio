import {
  FLOW_EPS,
  type FlowBand,
  type FlowBlank,
  type FlowItem,
  type FlowLine,
  type FlowModel,
  type FlowPlacement,
  type PageGeometry,
  type PlacedBlankPiece,
  type PlacedLine,
  type PlacementSegment,
  type Region,
  type BalancedTail,
} from "./model";
import {
  BandColumnStream,
  FullWidthStream,
  PageColumnStream,
  RegionAllocator,
  firstPageStartingAtOrBelow,
  normalizePageGeometry,
  pageContentTop,
  type NormalizedPageGeometry,
  type RegionStream,
} from "./regions";

/**
 * 行モデルを紙面へ詰める唯一のエンジン。
 *
 * 規則は 1 つだけ: **収まる限り今の領域 (ページ / 段) に置き、収まらない行だけを次の領域へ送る**。
 * 容器 (問題・枠・箱・引用・段組) ごとの特例は持たない。容器の見える縁は行に接着済み
 * (開き側は `top`、閉じ側は `fitBottom`) なので、ここでは行と空白と改ページしか見ない。
 *
 * - 領域の途中では自然配置の間隔を保つ。送った先 (手動改ページ以外) では段落間の margin を詰める。
 * - 空白 (解答欄の予約) は任意の位置で分割する。
 * - 領域より背の高い 1 行は領域の頭に置いてはみ出させ、後続はその下端より下の領域から始める。
 * - 段組の後に全幅の区間が来るときは、最後のページの段組部分を左右の高さが揃うよう詰め直す。
 * - ページの途中から始まる段組の区間は、どの段も最初の行と同じ高さから始める。
 * - 独立段組 (band) の各列は別々に流れ、後続は最も遅く終わった列の後から始める。
 */
export function placeFlow(model: FlowModel, geometry: PageGeometry): FlowPlacement {
  const g = normalizePageGeometry(geometry);
  const allocator = new RegionAllocator();
  const sink = createSink();
  const tallLines: string[] = [];
  const ignoredBreaks: string[] = [];
  const balanced: string[] = [];
  const balancedTails: BalancedTail[] = [];
  const context: FillContext = { g, allocator, tallLines, ignoredBreaks };

  let page = 0;
  let startTop: number | null = null;
  let prevBottom: number | null = null;
  let maxBottom = 0;

  model.sections.forEach((section, sectionIndex) => {
    if (section.items.length === 0) return;
    const multiColumn = section.span === "column" && g.columnCount > 1;
    // ページの途中から始まる段組みの区間は、どの段も最初の行と同じ高さから始める
    // (全幅の区間との間の自然な隙間を段の上端に含める。2 段目だけ詰まって行がずれない)。
    const firstItem = section.items[0];
    const alignedTop = multiColumn && startTop !== null && prevBottom !== null && firstItem.kind !== "break"
      ? startTop + Math.max(0, firstItem.top - prevBottom)
      : null;
    const topOfSection = alignedTop ?? startTop ?? pageContentTop(g, page);
    const stream: RegionStream = multiColumn
      ? new PageColumnStream(allocator, g, page, topOfSection, null)
      : new FullWidthStream(allocator, g, page, topOfSection);
    const beforeRegions = allocator.regions.length;
    const flowStart: FlowStart = startTop === null
      ? { kind: "document" }
      : alignedTop !== null
        ? { kind: "continue", y: alignedTop, prevBottom: null }
        : { kind: "continue", y: startTop, prevBottom };
    const result = fillFlow(section.items, "root", stream, flowStart, context, sink);
    if (!result) return;
    let end = result;

    const nextSection = model.sections[sectionIndex + 1];
    if (multiColumn && nextSection?.span === "full") {
      const balancedEnd = balanceTail(section.items, sink, beforeRegions, end, context, section.key, balancedTails, flowStart.kind === "document");
      if (balancedEnd) {
        end = balancedEnd;
        balanced.push(section.key);
      }
    }

    page = end.page;
    startTop = end.pageBottomUsed;
    prevBottom = end.prevBottom;
    maxBottom = Math.max(maxBottom, end.maxBottom);
  });

  let lastPage = 0;
  for (const line of sink.lines.values()) {
    lastPage = Math.max(lastPage, allocator.regions[line.regionIndex]?.page ?? 0);
  }
  for (const piece of sink.blanks) {
    lastPage = Math.max(lastPage, allocator.regions[piece.regionIndex]?.page ?? 0);
  }
  if (maxBottom > 0) {
    // 背の高い行のはみ出しも紙面として数える (内容を消さない)。
    lastPage = Math.max(lastPage, Math.max(0, Math.ceil((maxBottom - FLOW_EPS - g.contentTop - g.contentHeight) / g.stride)));
  }

  return {
    regions: allocator.regions,
    segments: sink.segments,
    lines: sink.lines,
    blanks: sink.blanks,
    pageCount: lastPage + 1,
    // 均等化は最後のページの尾を置き直すので、同じ行が 2 回数えられうる。
    diagnostics: { tallLines: [...new Set(tallLines)], balanced, balancedTails, ignoredBreaks: [...new Set(ignoredBreaks)] },
  };
}

interface FillContext {
  g: NormalizedPageGeometry;
  allocator: RegionAllocator;
  tallLines: string[];
  ignoredBreaks: string[];
}

interface Sink {
  lines: Map<string, PlacedLine>;
  blanks: PlacedBlankPiece[];
  segments: PlacementSegment[];
}

function createSink(): Sink {
  return { lines: new Map(), blanks: [], segments: [] };
}

type FlowStart =
  | { kind: "document" }
  | { kind: "continue"; y: number; prevBottom: number | null };

interface FillEnd {
  region: Region;
  page: number;
  y: number;
  prevBottom: number | null;
  /** そのページで使った最も下の位置 (段組なら全段の最大)。次の区間はここから始まる。 */
  pageBottomUsed: number;
  maxBottom: number;
  /** ページごとの使用済み下端 (独立段組の列を親の流れへ合成するため)。 */
  pageBottomUsedByPage: Map<number, number>;
}

interface Cursor {
  region: Region;
  y: number;
  prevBottom: number | null;
  placedInRegion: boolean;
  forced: boolean;
  /** 背の高い行がはみ出した下端。後続はこれより下の領域から始める。 */
  clearY: number | null;
  documentStart: boolean;
}

/**
 * 1 つの流れ (本文、または独立段組の 1 列) を詰める。`stream` が null を返した
 * (均等化の試行で高さが足りない) ときは null を返す。
 */
function fillFlow(
  items: readonly FlowItem[],
  flowKey: string,
  stream: RegionStream,
  start: FlowStart,
  context: FillContext,
  sink: Sink,
): FillEnd | null {
  const { g } = context;
  const first = stream.first();
  const cursor: Cursor = {
    region: first,
    y: start.kind === "continue" ? start.y : first.top,
    prevBottom: start.kind === "continue" ? start.prevBottom : null,
    placedInRegion: false,
    forced: false,
    clearY: null,
    documentStart: start.kind === "document",
  };
  let maxBottom = 0;
  const pageBottoms = new Map<number, number>();
  const noteBottom = (region: Region, bottom: number) => {
    pageBottoms.set(region.page, Math.max(pageBottoms.get(region.page) ?? region.top, bottom));
    maxBottom = Math.max(maxBottom, bottom);
  };

  const regionAtPageTop = (region: Region) => region.top <= pageContentTop(g, region.page) + FLOW_EPS;
  const advance = (toNextPage: boolean): boolean => {
    const next = toNextPage ? stream.nextPage(cursor.region) : stream.next(cursor.region);
    if (!next) return false;
    cursor.region = next;
    cursor.y = next.top;
    cursor.prevBottom = null;
    cursor.placedInRegion = false;
    cursor.documentStart = false;
    return true;
  };
  const clearTallOverflow = (): boolean => {
    if (cursor.clearY === null) return true;
    const clearY = cursor.clearY;
    cursor.clearY = null;
    const targetPage = firstPageStartingAtOrBelow(g, clearY, FLOW_EPS);
    for (let guard = 0; guard < 10_000 && cursor.region.top < clearY - FLOW_EPS; guard += 1) {
      const next = cursor.region.page < targetPage ? stream.nextPage(cursor.region) : stream.next(cursor.region);
      if (!next) return false;
      cursor.region = next;
      cursor.y = next.top;
      cursor.prevBottom = null;
      cursor.placedInRegion = false;
      cursor.documentStart = false;
    }
    return true;
  };
  /** 領域が空で、かつページ (段) の頭にある = ここに収まらない行はどこにも収まらない。 */
  const atFreshTop = () => !cursor.placedInRegion && regionAtPageTop(cursor.region);
  const startY = (top: number, leadingSpace: number): number => {
    // 自然な隙間が負 (重なり) でも、領域の上端より上には置かない。
    if (cursor.prevBottom !== null) return Math.max(cursor.region.top, cursor.y + (top - cursor.prevBottom));
    if (cursor.documentStart) return Math.max(cursor.region.top, top);
    return cursor.y + (cursor.forced ? leadingSpace : 0);
  };

  const pushSegment = (item: { top: number; bottom: number }, region: Region, dy: number) => {
    const last = findLastSegment(sink.segments, flowKey);
    if (last && last.regionIndex === region.index && Math.abs(last.dy - dy) < 0.01) {
      last.to = Math.max(last.to, item.bottom);
      last.visibleTo = Math.max(last.visibleTo, item.bottom);
      return;
    }
    sink.segments.push({
      flowKey,
      from: last ? last.to : item.top,
      to: item.bottom,
      visibleFrom: item.top,
      visibleTo: item.bottom,
      regionIndex: region.index,
      dx: region.dx,
      dy,
    });
  };

  const placeLine = (line: FlowLine): boolean => {
    if (!clearTallOverflow()) return false;
    const fitHeight = Math.max(0, line.fitBottom - line.top);
    let y = startY(line.top, line.leadingSpace);
    // 次の領域も途中から始まる (ページの途中から始まる段組みの 2 段目など) ことがあるので、
    // ページ・段の頭の空の領域に着くまで送り続ける。そこにも収まらない行だけが「背の高い行」。
    while (y + fitHeight > cursor.region.bottom + FLOW_EPS && !atFreshTop()) {
      if (!advance(false)) return false;
      y = cursor.y + (cursor.forced ? line.leadingSpace : 0);
    }
    const region = cursor.region;
    if (y + fitHeight > region.bottom + FLOW_EPS) {
      // 領域より背の高い 1 行。頭に置いてはみ出させる (消さない・縮めない)。
      context.tallLines.push(line.key);
      y = region.top;
      cursor.clearY = y + Math.max(fitHeight, line.bottom - line.top);
    }
    const dy = y - line.top;
    sink.lines.set(line.key, { key: line.key, regionIndex: region.index, y, dx: region.dx, dy });
    pushSegment(line, region, dy);
    cursor.y = y + (line.bottom - line.top);
    cursor.prevBottom = line.bottom;
    cursor.placedInRegion = true;
    cursor.forced = false;
    cursor.documentStart = false;
    noteBottom(region, y + Math.max(fitHeight, line.bottom - line.top));
    return true;
  };

  const placeBlank = (blank: FlowBlank): boolean => {
    if (!clearTallOverflow()) return false;
    const closing = Math.max(0, blank.closingChrome ?? 0);
    let y = startY(blank.top, 0);
    let rest = Math.max(0, blank.height);
    for (let guard = 0; guard < 10_000; guard += 1) {
      const room = cursor.region.bottom - y;
      if (rest + closing <= room + FLOW_EPS) break;
      // 最後の片と閉じ側の縁は同じ領域に置く。
      const take = Math.max(0, Math.min(rest, room - closing));
      if (take > FLOW_EPS) {
        sink.blanks.push({ key: blank.key, ownerId: blank.ownerId, regionIndex: cursor.region.index, y, height: take });
        noteBottom(cursor.region, y + take);
        rest -= take;
      }
      if (!advance(false)) return false;
      y = cursor.region.top;
    }
    if (rest > FLOW_EPS || closing > 0) {
      sink.blanks.push({ key: blank.key, ownerId: blank.ownerId, regionIndex: cursor.region.index, y, height: rest });
    }
    noteBottom(cursor.region, y + rest + closing);
    cursor.y = y + rest + closing;
    cursor.prevBottom = blank.top + (blank.virtual ? 0 : blank.height) + closing;
    cursor.placedInRegion = true;
    cursor.forced = false;
    cursor.documentStart = false;
    return true;
  };

  const placeBand = (band: FlowBand): boolean => {
    if (!clearTallOverflow()) return false;
    const y0 = startY(band.top, 0);
    const parentRegion = cursor.region;
    let latest: FillEnd | null = null;
    let latestOrder = -1;
    for (const column of band.columns) {
      const columnStream = new BandColumnStream(context.allocator, stream, parentRegion, y0, column);
      const end = fillFlow(
        column.items.filter((item) => {
          if (item.kind === "break") {
            context.ignoredBreaks.push(item.key);
            return false;
          }
          return true;
        }),
        column.key,
        columnStream,
        { kind: "continue", y: y0, prevBottom: band.top },
        context,
        sink,
      );
      if (!end) return false;
      const parentIndex = end.region.parentIndex ?? end.region.index;
      const order = parentIndex * 1e7 + end.y;
      if (!latest || order > latestOrder) {
        latest = end;
        latestOrder = order;
      }
      for (const [page, bottom] of end.pageBottomUsedByPage) {
        pageBottoms.set(page, Math.max(pageBottoms.get(page) ?? 0, bottom));
      }
      maxBottom = Math.max(maxBottom, end.maxBottom);
    }
    if (latest) {
      cursor.region = context.allocator.regions[latest.region.parentIndex ?? latest.region.index];
      cursor.y = latest.y;
    } else {
      cursor.y = y0 + (band.bottom - band.top);
    }
    cursor.prevBottom = band.bottom;
    cursor.placedInRegion = true;
    cursor.forced = false;
    cursor.documentStart = false;
    return true;
  };

  for (const item of items) {
    if (item.kind === "break") {
      const hasContent = cursor.placedInRegion
        || !regionAtPageTop(cursor.region)
        || (item.target === "page" && cursor.region.column > 0);
      if (!hasContent) continue;
      if (!advance(item.target === "page")) return null;
      cursor.forced = true;
      continue;
    }
    const ok = item.kind === "line"
      ? placeLine(item)
      : item.kind === "blank"
        ? placeBlank(item)
        : placeBand(item);
    if (!ok) return null;
  }

  const endRegion = cursor.region;
  const endPage = endRegion.page;
  const clearY = cursor.clearY;
  const endY = clearY !== null ? Math.max(cursor.y, clearY) : cursor.y;
  return {
    region: endRegion,
    page: clearY !== null ? Math.max(endPage, firstPageStartingAtOrBelow(g, clearY, FLOW_EPS) - 1) : endPage,
    y: endY,
    prevBottom: cursor.prevBottom,
    pageBottomUsed: Math.max(pageBottoms.get(endPage) ?? endY, endY),
    maxBottom,
    pageBottomUsedByPage: pageBottoms,
  };
}

function findLastSegment(segments: readonly PlacementSegment[], flowKey: string): PlacementSegment | undefined {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index].flowKey === flowKey) return segments[index];
  }
  return undefined;
}

/**
 * 全幅の区間の直前: 最後のページの段組部分を、左右の段の高さが揃う最小の高さで詰め直す
 * (Word の「現在の位置から新しいセクション」と同じ)。行・空白・独立段組のどれでも詰め直す。
 * 最後のページに手動改ページがあるとき、または前のページから続く空白・独立段組の途中で
 * 始まるときは詰め直さない (単純な順送りのまま)。
 */
function balanceTail(
  items: readonly FlowItem[],
  sink: Sink,
  firstRegionIndex: number,
  end: FillEnd,
  context: FillContext,
  sectionKey: string,
  balancedTails: BalancedTail[],
  sectionStartsDocument: boolean,
): FillEnd | null {
  const { g, allocator } = context;
  if (g.columnCount <= 1) return null;
  const endPage = end.page;
  const pageOfRegion = (index: number) => allocator.regions[index]?.page;
  /** 項目が置かれたページ (最初と最後)。置かれていなければ null。 */
  const pagesOf = (item: FlowItem): { first: number; last: number } | null => {
    const pages: number[] = [];
    const visit = (entry: FlowItem) => {
      if (entry.kind === "line") {
        const placed = sink.lines.get(entry.key);
        const page = placed ? pageOfRegion(placed.regionIndex) : undefined;
        if (page !== undefined) pages.push(page);
      } else if (entry.kind === "blank") {
        for (const piece of sink.blanks) {
          if (piece.key !== entry.key) continue;
          const page = pageOfRegion(piece.regionIndex);
          if (page !== undefined) pages.push(page);
        }
      } else if (entry.kind === "band") {
        for (const column of entry.columns) column.items.forEach(visit);
      }
    };
    visit(item);
    return pages.length > 0 ? { first: Math.min(...pages), last: Math.max(...pages) } : null;
  };
  const tailStart = items.findIndex((item) => pagesOf(item)?.first === endPage);
  if (tailStart < 0) return null;
  const tail = items.slice(tailStart);
  if (tail.some((item) => item.kind === "break")) return null;
  // 前のページから続く空白・独立段組の途中で始まる尾は扱わない。
  for (let index = tailStart - 1; index >= 0; index -= 1) {
    const pages = pagesOf(items[index]);
    if (!pages) continue;
    if (pages.last === endPage) return null;
    break;
  }
  const firstPlacement = (() => {
    const first = tail[0];
    if (first.kind === "line") return sink.lines.get(first.key)?.regionIndex;
    if (first.kind === "blank") return sink.blanks.find((piece) => piece.key === first.key)?.regionIndex;
    return undefined;
  })();
  const firstRegion = allocator.regions[firstPlacement ?? -1]
    ?? allocator.regions.find((region, index) => index >= firstRegionIndex && region.page === endPage && region.flowKey === "root");
  if (!firstRegion || firstRegion.column !== 0) return null;
  const tailTop = firstRegion.top;
  const pageBottom = pageContentTop(g, endPage) + g.contentHeight;
  const tallest = (item: FlowItem): number => {
    if (item.kind === "line") return Math.max(item.fitBottom, item.bottom) - item.top;
    if (item.kind === "band") return Math.max(0, ...item.columns.flatMap((column) => column.items.map(tallest)));
    return 0;
  };
  const maxLine = Math.max(0, ...tail.map(tallest));

  const attempt = (height: number): { sink: Sink; end: FillEnd } | null => {
    const trialSink = createSink();
    const mark = allocator.regions.length;
    const stream = new PageColumnStream(allocator, g, endPage, tailTop, { page: endPage, bottom: tailTop + height });
    // 文書の先頭から始まる尾は、先頭の行の自然な位置を保つ (元の配置と同じ規則)。
    const start: FlowStart = sectionStartsDocument && tailStart === 0
      ? { kind: "document" }
      : { kind: "continue", y: tailTop, prevBottom: null };
    const trialEnd = fillFlow(tail, "root", stream, start, context, trialSink);
    if (!trialEnd) {
      allocator.truncate(mark);
      return null;
    }
    return { sink: trialSink, end: trialEnd };
  };

  let low = Math.max(0.5, maxLine);
  let high = pageBottom - tailTop;
  if (high < low) return null;
  const mark = allocator.regions.length;
  const tallLinesBefore = context.tallLines.length;
  const ignoredBefore = context.ignoredBreaks.length;
  for (let guard = 0; guard < 64 && high - low > 0.5; guard += 1) {
    const mid = Math.round(((low + high) / 2) * 2) / 2;
    const trial = attempt(mid);
    allocator.truncate(mark);
    context.tallLines.length = tallLinesBefore;
    context.ignoredBreaks.length = ignoredBefore;
    if (trial) high = mid;
    else low = mid + 0.5;
  }
  const finalTrial = attempt(high);
  if (!finalTrial) {
    allocator.truncate(mark);
    context.tallLines.length = tallLinesBefore;
    context.ignoredBreaks.length = ignoredBefore;
    return null;
  }
  // 元の尾の配置 (最後のページの、この区間の領域にあるもの) を差し替える。
  const replaced = (regionIndex: number) => regionIndex >= firstRegionIndex && regionIndex < mark && pageOfRegion(regionIndex) === endPage;
  for (const [key, placed] of [...sink.lines]) {
    if (replaced(placed.regionIndex)) sink.lines.delete(key);
  }
  const keptBlanks = sink.blanks.filter((piece) => !replaced(piece.regionIndex));
  sink.blanks.length = 0;
  sink.blanks.push(...keptBlanks);
  const keptSegments = sink.segments.filter((segment) => !replaced(segment.regionIndex));
  sink.segments.length = 0;
  sink.segments.push(...keptSegments);
  for (const [key, placed] of finalTrial.sink.lines) sink.lines.set(key, placed);
  sink.blanks.push(...finalTrial.sink.blanks);
  sink.segments.push(...finalTrial.sink.segments);
  balancedTails.push({ sectionKey, page: endPage, top: tailTop, height: high });
  return {
    ...finalTrial.end,
    page: endPage,
    pageBottomUsed: finalTrial.end.pageBottomUsedByPage.get(endPage) ?? finalTrial.end.pageBottomUsed,
  };
}
