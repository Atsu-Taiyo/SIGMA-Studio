/**
 * 1 段組フローのページ割り判定。
 *
 * ここに来る値は **gap-free** であることが契約 — 呼び出し側が測定値から「今そこに描かれている
 * gap」(`applied-gaps.ts`) を引いてから渡す。前パスの出力が次パスの入力に混ざると、判定が
 * 自分の結果に依存する閉ループになり、同じ文書で gap が 114px ⇔ 4px を往復し続ける
 * (実データで観測: 後続 273 ブロックが毎フレーム 110px 上下し、recompute が 60Hz で回り続けた)。
 *
 * DOM に触らないので、往復するかどうかをユニットテストで固定できる。フラグメント分割のように
 * 実測が要る部分は `onPlaced` フックで呼び出し側へ返し、カーソルの移動だけを受け取る。
 */

export type PaginationItemKind = "atomicProblemArea" | "block" | "fragmentableBlock" | "area" | "reservedAreaEnd";

export interface PaginationItem {
  kind: PaginationItemKind;
  /** gap を積む先のキー。atomicProblemArea はエリアの DOM キャリア、area はユニット id。 */
  gapKey: string;
  /** gap を除いた位置 (コンテンツ領域上端からの px)。 */
  topNat: number;
  /** gap を除いた高さ。ブロック下余白 (`spaceAfterPx`) を含む。 */
  height: number;
  /**
   * `height` のうち末尾のブロック下余白ぶん。**収まり判定からは除き、カーソル前進には含める**。
   * 余白を含めて判定すると「余白を足したらその段落自身が次ページへ飛ぶ」= 下げたかったのは
   * 次の行なのに逆の結果になる。含めないとページ末尾で余白が消える。
   */
  trailingSpacePx?: number;
  /** 分割枠の各ページ片の下端に必要な、描画だけの chrome 予約高。 */
  fragmentEndSpacePx?: number;
  /** 手動改ページ。 */
  forceBreakBefore?: boolean;
  /** keepWithNext: current + next の gap-free 合算高。1ページ内に収まる組だけ有効。 */
  keepWithNextHeightPx?: number;
  /** fragmentableBlock: 1ページに収まる箱は分割せず次ページへ送る。 */
  keepTogether?: boolean;
  /** fragmentableBlock: そのページで開始するのに要る最小の残り高さ。 */
  minStartHeightPx?: number;
  /** area: セクション頭からコンテンツ原点までのオフセット。 */
  contentOffset?: number;
  /** area: 先頭ブロックの高さ。 */
  firstBlockHeight?: number;
  /** area: 先頭ブロックが現在ページから断片化できる。 */
  firstBlockFragmentable?: boolean;
  /** area: 断片化可能な先頭箱を開始するのに必要な残高。 */
  firstBlockMinStartHeightPx?: number;
  /** atomicProblemArea: 論理予約高のうちDOM外に残り、後続の前へ積む高さ。 */
  reservedHeightDeficitPx?: number;
}

export interface PaginationEnv {
  contentHeightPx: number;
  pageStride: number;
}

export interface PaginationPlacement {
  /** 直前に適用した gap (丸め済み)。0 なら適用していない。 */
  gap: number;
  pageIndex: number;
  pageStartNatural: number;
  /** ここまでに適用した gap の累計。実描画位置 = marginTop + topNat + cumGapPrev。 */
  cumGapPrev: number;
  /** area 用: ページ内でのコンテンツ開始位置と、そのページに残っている高さ。 */
  relTop: number;
  availableFirst: number;
}

/** フラグメント分割の結果として呼び出し側が返すカーソル移動。 */
export interface PaginationCursorMove {
  pageIndex: number;
  pageStartNatural: number;
  /** 次の項目の前に足す gap (フラグメントがはみ出した分)。 */
  pendingGap?: number;
}

export interface PaginationWalkHooks {
  onPlaced?: (item: PaginationItem, placement: PaginationPlacement) => PaginationCursorMove | void;
}

export interface PaginationResult {
  gaps: Record<string, number>;
  pageCount: number;
}

/** 1px 未満のずれで gap を積むと、丸めの往復そのものが振動源になる。 */
export function roundPaginationGap(gap: number): number {
  return Math.abs(gap) <= 0.5 ? 0 : Math.round(gap);
}

/**
 * 高さが何ページぶんを占めるか (最低 1 ページ)。
 *
 * keep-together の項目は分割されないので、ページ間の余白ごと連続して流れる。したがって
 * 割るのはコンテンツ高さではなく **ページの送り幅** (`pageStride`) — コンテンツ高さで
 * 割ると、1 ページ分をわずかに超えただけの項目でカーソルが 1 ページ余計に進み、空ページと
 * 「後続が常にページ頭扱い」を生む。
 */
export function occupiedPageCount(height: number, pageStride: number): number {
  if (!(pageStride > 0)) {
    return 1;
  }
  return Math.max(1, Math.ceil((height - 0.5) / pageStride));
}

/** 収まり判定に使う高さ。末尾のブロック下余白は「そこで切ってよい」ので除く。 */
function fitHeight(item: PaginationItem): number {
  return Math.max(0, item.height - (item.trailingSpacePx ?? 0))
    + Math.max(0, item.fragmentEndSpacePx ?? 0);
}

export function decidePagination(
  items: readonly PaginationItem[],
  env: PaginationEnv,
  initialGaps: Readonly<Record<string, number>>,
  hooks: PaginationWalkHooks = {},
): PaginationResult {
  const gaps: Record<string, number> = { ...initialGaps };
  let pageIndex = 0;
  let pageStartNatural = items.length > 0
    ? items[0].topNat - (initialGaps[items[0].gapKey] ?? 0)
    : 0;
  let cumGapPrev = 0;
  let pendingGap = 0;
  let trailingCursorNatural = items.length > 0 ? items[0].topNat : 0;

  const addGap = (gapKey: string, gap: number): number => {
    const rounded = roundPaginationGap(gap);
    if (rounded === 0) {
      return 0;
    }
    gaps[gapKey] = (gaps[gapKey] ?? 0) + rounded;
    cumGapPrev += rounded;
    return rounded;
  };

  const pushToNextPage = (gapKey: string, topNat: number): number => {
    pageIndex += 1;
    const applied = addGap(gapKey, pageIndex * env.pageStride - topNat - cumGapPrev);
    pageStartNatural = topNat;
    return applied;
  };

  for (const item of items) {
    // atomic の height は論理予約高を含む一方、deficit は DOM にまだ無い部分。
    // 末尾 pendingGap と合成するとき二重計上しないよう、ここでは実在カーソルだけを持つ。
    const renderedHeight = item.kind === "atomicProblemArea"
      ? Math.max(0, item.height - Math.max(0, item.reservedHeightDeficitPx ?? 0))
      : item.height;
    trailingCursorNatural = Math.max(trailingCursorNatural, item.topNat + renderedHeight);
    let gap = 0;
    // reservedAreaEnd はDOMキャリアを持たない。保留 gap は次の実在項目まで運ぶ。
    if (pendingGap > 0.5 && item.kind !== "reservedAreaEnd") {
      gap += addGap(item.gapKey, pendingGap);
      pendingGap = 0;
    }

    const isFirstOnPage = item.topNat <= pageStartNatural + 0.5;
    const relTop = item.topNat - pageStartNatural;
    // すでにページ頭にいるなら手動改ページは満たされている (空ページを作らない)。
    const forceBreak = item.forceBreakBefore === true && !isFirstOnPage;

    if (item.kind === "atomicProblemArea") {
      // keep-together が唯一の規則。ページより高い枠付きエリアも分割せず、次ページの頭から
      // 始める (枠を切らないための規則で、そこが「どのページにも収まらない枠」にできる最善)。
      if (!isFirstOnPage && relTop + item.height > env.contentHeightPx + 0.5) {
        gap += pushToNextPage(item.gapKey, item.topNat);
      }
      // 占有するページ数だけカーソルを進める。これが無いと、後続のブロックが
      // 「まだエリアの始まったページにいる」前提で判定され、毎パス上下する。
      const pages = occupiedPageCount(item.height, env.pageStride);
      if (pages > 1) {
        pageIndex += pages - 1;
        pageStartNatural += (pages - 1) * env.pageStride;
      }
      const reservedHeightDeficit = Math.max(0, item.reservedHeightDeficitPx ?? 0);
      if (reservedHeightDeficit > 0) {
        pendingGap += reservedHeightDeficit;
        // The synthetic height is absent from subsequent topNat values. Move the natural
        // page origin back by the same amount so later fit checks see their actual position.
        pageStartNatural -= reservedHeightDeficit;
      }
    } else if (item.kind === "reservedAreaEnd") {
      // minHeight が作る連続DOM高はページ間 gap も高さとして消費する。自然座標の末尾が
      // 通過した紙面ページ数をここで確定し、その gap 分を次の実在キャリアへ補う。
      const pages = env.contentHeightPx > 0
        ? Math.max(0, Math.floor((relTop - 0.5) / env.contentHeightPx))
        : 0;
      if (pages > 0) {
        pageIndex += pages;
        pageStartNatural += pages * env.contentHeightPx;
        pendingGap += pages * Math.max(0, env.pageStride - env.contentHeightPx);
      }
      continue;
    } else if (item.kind === "fragmentableBlock") {
      // 箱や 1 ページより高いブロックは本文のように流れる: 残りを埋めて
      // 次ページへ続く。ここでは見た目の種類を知らず、分割可能というレイアウト契約だけを扱う。
      const available = env.contentHeightPx - relTop;
      const minStart = item.minStartHeightPx ?? 0;
      const keepWithNextHeight = Math.max(0, item.keepWithNextHeightPx ?? 0);
      const keepWithNextPush = !isFirstOnPage
        && keepWithNextHeight > available + 0.5
        && keepWithNextHeight <= env.contentHeightPx + 0.5;
      const keepTogetherPush = item.keepTogether === true
        && !isFirstOnPage
        && fitHeight(item) > available + 0.5
        && fitHeight(item) <= env.contentHeightPx + 0.5;
      const needsPush = forceBreak
        || keepWithNextPush
        || keepTogetherPush
        || (!isFirstOnPage && fitHeight(item) > available + 0.5 && available < minStart - 0.5);
      if (needsPush) {
        gap += pushToNextPage(item.gapKey, item.topNat);
      }
    } else if (item.kind === "block") {
      const keepWithNextHeight = Math.max(0, item.keepWithNextHeightPx ?? 0);
      const keepWithNextPush = !isFirstOnPage
        && keepWithNextHeight > env.contentHeightPx - relTop + 0.5
        && keepWithNextHeight <= env.contentHeightPx + 0.5;
      if (forceBreak || keepWithNextPush || (!isFirstOnPage && relTop + fitHeight(item) > env.contentHeightPx + 0.5)) {
        gap += pushToNextPage(item.gapKey, item.topNat);
      }
    }

    let areaRelTop = relTop;
    let availableFirst = env.contentHeightPx - relTop;
    if (item.kind === "area") {
      const contentOffset = item.contentOffset ?? 0;
      areaRelTop = Math.max(0, item.topNat + contentOffset - pageStartNatural);
      availableFirst = env.contentHeightPx - areaRelTop;
      const firstBlockHeight = Math.max(0, item.firstBlockHeight ?? 0);
      const firstBlockCannotStart = item.firstBlockFragmentable === true
        ? firstBlockHeight > availableFirst + 0.5
          && availableFirst < Math.max(0, item.firstBlockMinStartHeightPx ?? 0) - 0.5
        : availableFirst < firstBlockHeight - 0.5;
      // 満ページに収まる先頭ブロックだけを次ページへ送る。1ページ超の
      // 段落は現在ページから断片化し、箱は minStart を満たす残りから流す。
      if (areaRelTop > 0.5 && firstBlockCannotStart) {
        gap += pushToNextPage(item.gapKey, item.topNat);
        areaRelTop = contentOffset;
        availableFirst = env.contentHeightPx - areaRelTop;
      }
    }

    const move = hooks.onPlaced?.(item, {
      gap,
      pageIndex,
      pageStartNatural,
      cumGapPrev,
      relTop: areaRelTop,
      availableFirst,
    });
    if (move) {
      pageIndex = move.pageIndex;
      pageStartNatural = move.pageStartNatural;
      pendingGap += move.pendingGap ?? 0;
    }
  }

  let pageCount = pageIndex + 1;
  if (pendingGap > 0.5 && items.length > 0 && env.pageStride > 0) {
    // 次の実在キャリアが無くても、予約の論理末尾は紙面数に残す。pendingGap は DOM に
    // 未実現なので gap map へは書かず、最終カーソルとの合成だけで占有ページを数える。
    const documentStartNatural = items[0].topNat - (initialGaps[items[0].gapKey] ?? 0);
    const trailingBottom = trailingCursorNatural + cumGapPrev + pendingGap;
    pageCount = Math.max(
      pageCount,
      occupiedPageCount(Math.max(0, trailingBottom - documentStartNatural), env.pageStride),
    );
  }

  return { gaps, pageCount };
}

/**
 * gap マップの署名。キー順に依存せず、0 の gap は「無い」と同じに見える必要がある
 * (往復の片側だけ 0 のキーを持つことがあるため)。
 */
export function gapMapSignature(gaps: Readonly<Record<string, number>>): string {
  return Object.keys(gaps)
    .filter((key) => Math.round(gaps[key] ?? 0) !== 0)
    .sort()
    .map((key) => `${key}:${Math.round(gaps[key] ?? 0)}`)
    .join("|");
}

export type GapOscillationVerdict = "stable" | "oscillating" | "progressing";

/**
 * 直近の署名列から、収束したか・往復しているかを見る。
 *
 * `sameGapMap` のような隣接 2 パスの等値では止まらない — 往復は「隣とは必ず違う」ので、
 * 履歴を見ないと A→B→A→B を検出できない。
 */
export function detectGapOscillation(
  history: readonly string[],
  next: string,
): GapOscillationVerdict {
  const window = [...history.slice(-3), next];
  if (window.length >= 2 && window.every((signature) => signature === window[0])) {
    return "stable";
  }
  if (window.length === 4) {
    const [first, second, third, fourth] = window;
    if (first === third && second === fourth && first !== second) {
      return "oscillating";
    }
  }
  return "progressing";
}
