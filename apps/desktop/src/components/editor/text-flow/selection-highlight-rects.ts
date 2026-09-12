export interface SelectionHighlightRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const LINE_GROUP_TOLERANCE_PX = 2;
/**
 * 縦に同じ行でも、これより横に離れた矩形は別の帯として残す。多段組 (layoutSection) では
 * 左右の段の行が同じ高さに並ぶため、水平の近接を見ずに畳むと段間ギャップごと 1 枚の
 * 巨大矩形に融合してしまう。行内の断片 (単語・数式ノード) は隣接して並ぶので、この
 * 許容量あれば 1 本に繋がる。
 */
const LINE_GROUP_HORIZONTAL_GAP_PX = 8;
/** 空行 (テキストを持たない <br>) に置く「選択された改行」の印の最小幅。 */
const EMPTY_LINE_MARK_MIN_WIDTH_PX = 4;

/**
 * `Range.getClientRects()` は KaTeX や span の入れ子ボックスまで返す。
 * 半透明の帯として全部重ねると、同じ行が二重三重に濃く見える。
 * 行ごとに 1 本へ畳む。
 */
export function mergeSelectionHighlightRects(
  rects: readonly SelectionHighlightRect[],
): SelectionHighlightRect[] {
  const groups: Array<{ top: number; right: number; bottom: number; left: number }> = [];
  const sorted = rects
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => ({
      top: rect.top,
      left: rect.left,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
    }))
    .sort((left, right) => left.top - right.top || left.left - right.left);

  for (const rect of sorted) {
    const group = groups.find((candidate) => rectMatchesLineGroup(rect, candidate));
    if (!group) {
      groups.push({ ...rect });
      continue;
    }
    group.top = Math.min(group.top, rect.top);
    group.right = Math.max(group.right, rect.right);
    group.bottom = Math.max(group.bottom, rect.bottom);
    group.left = Math.min(group.left, rect.left);
  }

  return groups
    .sort((left, right) => left.top - right.top || left.left - right.left)
    .map((group) => ({
      left: group.left,
      top: group.top,
      width: group.right - group.left,
      height: group.bottom - group.top,
    }));
}

/**
 * 選択範囲の**行矩形**だけを集める。`Range.getClientRects()` の生値は「範囲に完全に
 * 含まれるブロック要素の全幅 border box」も返すため、96px の短い段落や空行が全幅の
 * スラブになり、多段組は段間ギャップごと 1 枚に融合して、ネイティブ選択 (行ごとに
 * ragged) と見た目が明確に割れる。テキストノードの断片矩形と改行 (<br>) だけを拾う
 * ことで、端点段落もそれ以外もネイティブと同じ行単位の形になる。
 */
export function collectRangeLineRects(range: Range): SelectionHighlightRect[] {
  return collectRangeRects(range, { includeText: true });
}

/**
 * 空行 (テキストを持たない <br>) の「選択された改行」の印だけを集める。
 * CSS Custom Highlight (`::highlight`) はテキストの無い行に何も描かないため、
 * 跨ぎ選択・保持選択の描画では、テキスト行は Highlight・空行だけこの矩形が補完する。
 */
export function collectRangeEmptyLineRects(range: Range): SelectionHighlightRect[] {
  return collectRangeRects(range, { includeText: false });
}

/**
 * 行末の塗り: フォーカスのあるエディタのネイティブ `::selection` は、選択が続く各行の
 * 行末 (段落末の改行・空白折返し・CJK 折返しのすべて) にスペース 1 個分の幅の「改行タブ」
 * を塗る。CSS Custom Highlight はこれを塗らない (実測: tmp/line-end-wrap-probe.mjs —
 * native は行末グリフ/空白の右に space advance ぶん塗り、highlight は 0)。放置すると
 * ドラッグがチャンク境界を跨いだ瞬間 (ネイティブ選択 → Highlight への切り替わり) に
 * 全行末のタブが一斉に消えて見える。この矩形を空行の印と同じレイヤー (multiply、
 * 白地 Δ0) が補完する。
 *
 * 選択の最終行 (範囲の終端の行) だけはネイティブも塗らない。`continuesBeyondRange` は
 * 範囲の終端の先 (次のユニット) にも選択が続くとき true — 単一文書としては終端行の
 * 改行も選択中なので、そのタブも塗る。
 */
export function collectRangeLineEndFillRects(
  range: Range,
  { continuesBeyondRange }: { continuesBeyondRange: boolean },
): SelectionHighlightRect[] {
  const root: Node = range.commonAncestorContainer;
  const ownerDocument = root.ownerDocument;
  if (!ownerDocument || typeof range.intersectsNode !== "function") {
    // テスト DOM (happy-dom) 等。実ブラウザでは通らない。
    return [];
  }

  // 文書順で矩形を集める (テキスト断片 + 数式アトムの箱)。数式は Highlight では塗らない
  // (text-selected 装飾が塗る) が、行末判定にはその右端が要る — 末尾が数式の行でタブが
  // 行中に出ないように。fontElement は改行タブの幅 (スペースの advance) の出典。
  const collected: Array<{ rect: SelectionHighlightRect; fontElement: Element | null }> = [];

  const walker = ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node) => {
        if (!range.intersectsNode(node)) {
          return NodeFilter.FILTER_REJECT;
        }
        if (node.nodeType === Node.TEXT_NODE) {
          return (node as Text).parentElement?.closest(".inline-math-node")
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_ACCEPT;
        }
        return (node as Element).classList?.contains("inline-math-node")
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    },
  );
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType !== Node.TEXT_NODE) {
      const element = node as Element;
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        collected.push({
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          fontElement: element,
        });
      }
      continue;
    }

    const textNode = node as Text;
    const subRange = ownerDocument.createRange();
    subRange.selectNodeContents(textNode);
    if (textNode === range.startContainer) {
      subRange.setStart(textNode, range.startOffset);
    }
    if (textNode === range.endContainer) {
      subRange.setEnd(textNode, range.endOffset);
    }
    for (const rect of Array.from(subRange.getClientRects())) {
      if (rect.width > 0 && rect.height > 0) {
        collected.push({
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          fontElement: textNode.parentElement,
        });
      }
    }
  }
  if (collected.length === 0) {
    return [];
  }

  // 行ごとに畳む (帯の行グループ化と同じ規則 — 多段組の隣の段は別の行)。
  interface LineGroup {
    top: number;
    right: number;
    bottom: number;
    left: number;
    fontElement: Element | null;
  }
  const lines: LineGroup[] = [];
  let finalLine: LineGroup | null = null;
  for (const { rect, fontElement } of collected) {
    const bounds = {
      top: rect.top,
      left: rect.left,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
    };
    // 矩形は文書順に届くので、まず直前の行と比べる (大選択のドラッグ中に毎フレーム
    // 全行を走査しないための近道)。
    let line: LineGroup | undefined = finalLine && rectMatchesLineGroup(bounds, finalLine)
      ? finalLine
      : lines.find((candidate) => rectMatchesLineGroup(bounds, candidate));
    if (!line) {
      line = { ...bounds, fontElement };
      lines.push(line);
    } else {
      line.top = Math.min(line.top, bounds.top);
      line.bottom = Math.max(line.bottom, bounds.bottom);
      line.left = Math.min(line.left, bounds.left);
      if (bounds.right >= line.right) {
        line.right = bounds.right;
        line.fontElement = fontElement;
      }
    }
    // 文書順で最後の矩形が乗る行 = 選択の最終行。
    finalLine = line;
  }

  const fills: SelectionHighlightRect[] = [];
  for (const line of lines) {
    if (line === finalLine && !continuesBeyondRange) {
      // 選択はこの行で終わる: 行末の改行/折返しは選択されていない。
      continue;
    }
    // 隣の行のグリフ矩形と 1〜3px 重なるフリンジ行では、native の連続した帯に対して
    // 数 px・Δ7 以下の合成差が残る (実測)。行単位の矩形をこれ以上正確にするには native の
    // 帯の端数境界 (グリフ矩形とは別物) が要り、DOM からは取れない。
    fills.push({
      left: line.right,
      top: line.top,
      width: measureSelectionSpaceWidth(line.fontElement),
      height: line.bottom - line.top,
    });
  }
  return fills;
}

/**
 * 改行タブ / 折返し空白の塗りの幅 = そのフォントのスペースの advance (Chromium の
 * ネイティブ選択の実測と一致)。ブロック単位でフォントはほぼ共通なのでフォント指定文字列を
 * 鍵にキャッシュする。
 */
const spaceWidthCache = new Map<string, number>();
let spaceMeasureContext: CanvasRenderingContext2D | null | undefined;

function measureSelectionSpaceWidth(element: Element | null): number {
  const view = element?.ownerDocument.defaultView;
  if (!element || !view) {
    return EMPTY_LINE_MARK_MIN_WIDTH_PX;
  }
  const style = view.getComputedStyle(element);
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const cached = spaceWidthCache.get(font);
  if (cached !== undefined) {
    return cached;
  }
  if (spaceMeasureContext === undefined) {
    spaceMeasureContext = element.ownerDocument.createElement("canvas").getContext("2d");
  }
  let width = EMPTY_LINE_MARK_MIN_WIDTH_PX;
  if (spaceMeasureContext) {
    spaceMeasureContext.font = font;
    const measured = spaceMeasureContext.measureText(" ").width;
    if (measured > 0) {
      width = measured;
    }
  }
  spaceWidthCache.set(font, width);
  return width;
}

function collectRangeRects(
  range: Range,
  { includeText }: { includeText: boolean },
): SelectionHighlightRect[] {
  const root: Node = range.commonAncestorContainer;
  const ownerDocument = root.ownerDocument;
  if (!ownerDocument) {
    return [];
  }

  const rects: SelectionHighlightRect[] = [];
  const pushTextRects = (node: Node) => {
    const subRange = ownerDocument.createRange();
    subRange.selectNodeContents(node);
    if (node === range.startContainer) {
      subRange.setStart(node, range.startOffset);
    }
    if (node === range.endContainer) {
      subRange.setEnd(node, range.endOffset);
    }
    for (const rect of Array.from(subRange.getClientRects())) {
      rects.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    }
  };

  if (root.nodeType === Node.TEXT_NODE) {
    if (includeText) {
      pushTextRects(root);
    }
    return rects;
  }
  if (typeof range.intersectsNode !== "function") {
    // テスト DOM (happy-dom) 等のフォールバック。実ブラウザでは通らない。
    if (!includeText) {
      return [];
    }
    return Array.from(range.getClientRects())
      .map((rect) => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }));
  }

  const walker = ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node) => {
        if (!range.intersectsNode(node)) {
          // 範囲外の枝ごと刈る (REJECT は子孫も見ない)。
          return NodeFilter.FILTER_REJECT;
        }
        if (node.nodeType === Node.TEXT_NODE) {
          return NodeFilter.FILTER_ACCEPT;
        }
        return (node as Element).tagName === "BR"
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    },
  );
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (includeText) {
        pushTextRects(node);
      }
      continue;
    }
    // 空行 (空段落の <br>) はテキスト矩形を持たない。ネイティブ選択が選択中の改行に
    // 置く小さな印に合わせ、行高ぶんの細い矩形を置く (幅 0 のままだと帯ごと消える)。
    const rect = (node as Element).getBoundingClientRect();
    if (rect.height > 0) {
      rects.push({
        left: rect.left,
        top: rect.top,
        width: Math.max(rect.width, EMPTY_LINE_MARK_MIN_WIDTH_PX, rect.height * 0.25),
        height: rect.height,
      });
    }
  }
  return rects;
}

/**
 * ネイティブ `::selection` が付く間はカスタム帯を出さない。
 * Chromium はフォーカスの無い contenteditable の `::selection` を描かないので、
 * そのときだけ帯が本文選択の見え方になる。
 */
export function isNativeBodySelectionVisible(
  range: Pick<Range, "commonAncestorContainer">,
  activeElement: Element | null,
): boolean {
  const editor = textFlowEditorFromRange(range);
  if (!editor || !activeElement) {
    return false;
  }
  return editor === activeElement || editor.contains(activeElement);
}

export function shouldPaintHeldBodySelection(params: {
  nativeSelectionVisible: boolean;
  multiEditorTextRunSpan: boolean;
}): boolean {
  return !params.nativeSelectionVisible && !params.multiEditorTextRunSpan;
}

function textFlowEditorFromRange(
  range: Pick<Range, "commonAncestorContainer">,
): Element | null {
  const container = range.commonAncestorContainer;
  const element = container instanceof Element ? container : container.parentElement;
  return element?.closest(".text-flow-editor") ?? null;
}

function rectMatchesLineGroup(
  rect: { top: number; right: number; bottom: number; left: number },
  group: { top: number; right: number; bottom: number; left: number },
): boolean {
  // 縦が同じ行でも、横に離れた矩形 (多段組の隣の段) は別の帯にする。
  const horizontalGap = Math.max(rect.left - group.right, group.left - rect.right);
  if (horizontalGap > LINE_GROUP_HORIZONTAL_GAP_PX) {
    return false;
  }

  const rectCenterY = (rect.top + rect.bottom) / 2;
  const groupCenterY = (group.top + group.bottom) / 2;
  if (Math.abs(rectCenterY - groupCenterY) <= LINE_GROUP_TOLERANCE_PX) {
    return true;
  }

  const overlap = Math.min(rect.bottom, group.bottom) - Math.max(rect.top, group.top);
  const minHeight = Math.min(rect.bottom - rect.top, group.bottom - group.top);
  return overlap > Math.max(1, minHeight * 0.45);
}
