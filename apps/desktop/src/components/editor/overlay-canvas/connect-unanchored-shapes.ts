import {
  pageIndexForY,
  resolveShapeAnchorPositions,
  resolveShapesPosition,
  type MeasuredBlock,
  type MeasuredLine,
} from "./anchor";
import { isPickableAnchorBlock } from "../page-canvas/undrawn-blocks";
import { isShapeEditPolicyLockedInTree } from "./grouping";
import {
  getAnchorProbeBounds,
  inheritGroupAnchorsForMembers,
  keepPreservedShapes,
} from "./reanchor-model";
import type { OverlayAnchor, OverlayBounds, OverlayShape, OverlayShapeId } from "./types";

/**
 * 紙面のページ割りのうち、本文と繋がっていない図形を本文へ繋ぐのに要る寸法 (すべて紙面のモデル座標の px)。
 */
export interface BodyPageBand {
  /** ページ送りの間隔 (ページの高さ + ページ間の隙間)。 */
  pageStridePx: number;
  /** ページの上端から本文域の上端まで (上余白)。 */
  contentTopPx: number;
  /** 本文域の高さ。 */
  contentHeightPx: number;
}

export interface ConnectUnanchoredShapesOptions {
  /**
   * 書き換えない図形 (`keepPreservedShapes`)。機能が守っている図形 (`preservedShapeIds`) と、変更口が人の編集を
   * 断る図形 (AI が編集中の `lockedShapeIds`) を渡す。触れると変更口がコミット全体を断る。
   */
  untouchableShapeIds?: ReadonlySet<OverlayShapeId>;
}

/**
 * 本文域の高さのこの割合を超える図形は、ページそのものの飾り (枠・段の仕切り線・ページ全面の背景) とみなす。
 * どの本文の高さにも「並んで」いないので、1 つのブロックへ繋ぐと本文の増減でページからずれる。
 */
const PAGE_FURNITURE_HEIGHT_RATIO = 0.8;
/** 重なりとみなす隙間。部品どうしが接しているだけの図 (線の端に置いたラベル) も 1 つの図として扱う。 */
const CLUSTER_TOUCH_TOLERANCE_PX = 1;
const EDGE_EPSILON_PX = 0.5;
/** 帯に重なるとみなす横の重なり。隣の段とは段間で離れているので、接しているだけのものは外す。 */
const LANE_OVERLAP_MIN_PX = 1;

/**
 * 本文と繋がっていない図形 (錨が無い・ページに固定) を、紙面上でその図形がある高さの本文ブロックへ繋ぐ。
 * 教材を開いたときに 1 回だけ使う (`use-connect-unanchored-on-open.ts`)。図形は 1 px も動かさない: 錨のずれは
 * いまの位置から測るので、解決すると同じ座標に戻る。
 *
 * どこへ繋ぐかの決め方:
 * - 図形の上端の高さにある本文 (同じページ・同じ段) へ繋ぐ。上端が段落の間の隙間にあって、すぐ下の段落の方が
 *   近く、図形がその段落の高さまで降りているなら、下の段落へ繋ぐ (本文の右横に置いた図は、上端が少しはみ
 *   出していても横に並ぶ段落のもの)。ページで最初の本文より上にあるなら、そのページの最初の本文へ繋ぐ。
 * - 重なっている図形どうしは 1 つの図として同じブロック・同じ行へ繋ぐ。部品ごとに高さで選ぶと、間の本文が
 *   増減したときに図が裂ける (グループのメンバーがグループの錨を継ぐのと同じ理由)。すでに本文へ繋がった図形と
 *   重なっていれば、その図形の繋ぎ先に揃える。
 * - ページの飾りは繋がない: ロックした図形、本文域のほぼ全高を占める図形、上下の余白 (ヘッダー/フッターの帯)
 *   だけにある図形、本文の無いページにある図形はページに固定したまま。
 *
 * すでに本文や別の図形へ繋がっている図形は変えない (繋ぎ先が見つからない錨も、保存時の付け替えに任せる)。
 */
export function connectUnanchoredShapesToBody(
  shapes: OverlayShape[],
  blocks: readonly MeasuredBlock[],
  band: BodyPageBand,
  options: ConnectUnanchoredShapesOptions = {},
): OverlayShape[] {
  if (blocks.length === 0 || !(band.pageStridePx > 0) || !(band.contentHeightPx > 0)) {
    return shapes;
  }
  const groupById = new Map(shapes.filter((shape) => shape.type === "group").map((shape) => [shape.id, shape]));
  const isTopLevel = (shape: OverlayShape) => !shape.parentId || !groupById.has(shape.parentId);
  const isUnconnected = (shape: OverlayShape) => shape.anchor === undefined || shape.anchor.type === "page";
  // 繋ぐ候補が無い (ほとんどの教材) ならここで降りる。グループのメンバーは、本文へ繋がったグループの中で
  // 繋がっていないものだけが候補 (グループの繋ぎ先を継ぐ)。
  const hasUnconnectedShape = shapes.some((shape) => isUnconnected(shape) && (
    isTopLevel(shape) || groupById.get(shape.parentId!)?.anchor?.type === "block"
  ));
  if (!hasUnconnectedShape) {
    return shapes;
  }

  const untouchable = options.untouchableShapeIds ?? new Set<OverlayShapeId>();
  const blockById = new Map(blocks.map((block) => [block.id, block]));
  // 本文へ繋がった図形の保存座標は錨から引く遅延キャッシュなので、重なりは描かれている位置で見る。
  const resolved = resolveShapesPosition(shapes, blockById);
  const resolvedById = new Map(resolved.map((shape) => [shape.id, shape]));
  const boundsById = new Map<OverlayShapeId, OverlayBounds>();
  const boundsOf = (shape: OverlayShape): OverlayBounds => {
    const cached = boundsById.get(shape.id);
    if (cached) {
      return cached;
    }
    const bounds = getAnchorProbeBounds(resolvedById.get(shape.id) ?? shape, resolved);
    boundsById.set(shape.id, bounds);
    return bounds;
  };

  const targets = shapes.filter((shape) => (
    isTopLevel(shape) &&
    isUnconnected(shape) &&
    shape.locked !== true &&
    !isShapeEditPolicyLockedInTree(shapes, shape, untouchable) &&
    !isPageFurniture(boundsOf(shape), band)
  ));
  const seeds = shapes.filter((shape) => {
    if (!isTopLevel(shape) || shape.anchor?.type !== "block") {
      return false;
    }
    const block = blockById.get(shape.anchor.blockId);
    return block !== undefined && isPickableAnchorBlock(block) && !block.derived;
  });

  // 重なっている図形を 1 つの図にまとめる (union-find)。すでに繋がった図形は繋ぎ先の手がかりとしてだけ使う。
  const parent = targets.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  for (let i = 0; i < targets.length; i += 1) {
    for (let j = i + 1; j < targets.length; j += 1) {
      if (boundsTouch(boundsOf(targets[i]), boundsOf(targets[j]))) {
        parent[find(i)] = find(j);
      }
    }
  }
  const seedsByRoot = new Map<number, OverlayShape[]>();
  for (let i = 0; i < targets.length; i += 1) {
    for (const seed of seeds) {
      if (boundsTouch(boundsOf(targets[i]), boundsOf(seed))) {
        const root = find(i);
        seedsByRoot.set(root, [...(seedsByRoot.get(root) ?? []), seed]);
      }
    }
  }
  const membersByRoot = new Map<number, OverlayShape[]>();
  targets.forEach((shape, index) => {
    const root = find(index);
    membersByRoot.set(root, [...(membersByRoot.get(root) ?? []), shape]);
  });

  const sortedBlocks = [...blocks].sort((a, b) => a.top - b.top);
  const nextAnchorById = new Map<OverlayShapeId, OverlayAnchor>();
  for (const [root, members] of membersByRoot) {
    const target = pickSeedTarget(seedsByRoot.get(root), blockById, boundsOf) ??
      pickBodyTargetAtHeight(unionBounds(members.map(boundsOf)), sortedBlocks, blockById, band);
    if (!target) {
      continue;
    }
    for (const member of members) {
      nextAnchorById.set(member.id, buildBlockAnchor(member, target));
    }
  }

  const connected = nextAnchorById.size === 0
    ? shapes
    : shapes.map((shape) => {
        const anchor = nextAnchorById.get(shape.id);
        return anchor ? { ...shape, anchor } as OverlayShape : shape;
      });
  // グループは部品ごとに選ばず、繋がっていないメンバーにグループの繋ぎ先 (ブロックと行) を継がせる。
  const inherited = inheritGroupAnchorsForMembers(connected, blockById, {}, {
    onlyUnanchored: true,
    rebindPageAnchoredMembers: true,
  });
  if (inherited === shapes) {
    return shapes;
  }
  return keepPreservedShapes(shapes, resolveShapeAnchorPositions(inherited), untouchable);
}

interface BlockTarget {
  block: MeasuredBlock;
  lineIndex?: number;
}

function buildBlockAnchor(shape: OverlayShape, target: BlockTarget): OverlayAnchor {
  const { block } = target;
  const line = target.lineIndex === undefined
    ? undefined
    : block.lines?.find((item) => item.index === target.lineIndex);
  return {
    type: "block",
    blockId: block.id,
    dy: shape.y - block.top,
    ...(block.left === undefined ? {} : { dx: shape.x - block.left }),
    ...(line === undefined ? {} : { line: { index: line.index, dy: shape.y - line.top } }),
  };
}

/** 本文へ繋がった図形と重なる図は、いちばん上のその図形の繋ぎ先に揃える。 */
function pickSeedTarget(
  seeds: readonly OverlayShape[] | undefined,
  blockById: ReadonlyMap<string, MeasuredBlock>,
  boundsOf: (shape: OverlayShape) => OverlayBounds,
): BlockTarget | null {
  if (!seeds || seeds.length === 0) {
    return null;
  }
  const topmost = [...seeds].sort((a, b) => boundsOf(a).y - boundsOf(b).y)[0];
  const anchor = topmost.anchor;
  if (anchor?.type !== "block") {
    return null;
  }
  const block = blockById.get(anchor.blockId);
  if (!block) {
    return null;
  }
  const lineIndex = anchor.line?.index;
  const hasLine = lineIndex !== undefined && block.lines?.some((line) => line.index === lineIndex);
  return { block, ...(hasLine ? { lineIndex } : {}) };
}

/**
 * 図 (`bounds`) がある高さの本文を、同じページ・同じ段から選ぶ。そのページに本文が無ければ null。
 */
export function pickBodyTargetAtHeight(
  bounds: OverlayBounds,
  sortedBlocks: readonly MeasuredBlock[],
  blockById: ReadonlyMap<string, MeasuredBlock>,
  band: BodyPageBand,
): BlockTarget | null {
  const { pageIndex } = pageIndexForY(bounds.y, band.pageStridePx);
  const bodyTop = pageIndex * band.pageStridePx + band.contentTopPx;
  const bodyBottom = bodyTop + band.contentHeightPx;
  // 段の切れ目をまたいで続く段落も、そのページに行があれば候補 (上端だけで見ると前のページの本文になる)。
  // 描かれていないブロックと、編集面にしか無いブロック (文書に無い id) には繋がない。
  const onPage = sortedBlocks.filter((block) => (
    isPickableAnchorBlock(block) &&
    !block.derived &&
    block.top <= bodyBottom &&
    block.top + (block.height ?? 0) >= bodyTop
  ));
  if (onPage.length === 0) {
    return null;
  }

  const shapeBottom = bounds.y + bounds.h;
  // 上の余白へはみ出した図は、本文域の上端から見る。
  let probe = Math.max(bounds.y, bodyTop);
  const lane = restrictBlocksToProbeLane(onPage, bounds.x + bounds.w / 2, probe, shapeBottom);
  const previous = lastBlockStartingAt(lane, probe);
  if (!previous) {
    // そのページ (段) の最初の本文より上: 最初の本文の高さに並んでいる。
    probe = lane[0].top + EDGE_EPSILON_PX;
  } else {
    const slotBottom = getSlotBottomAt(previous, probe);
    if (probe > slotBottom + EDGE_EPSILON_PX) {
      // 上端が本文の隙間にある。下の本文の方が近く、図がその高さまで降りていれば、下の本文の横に並ぶ図。
      const next = lane.find((block) => block.top > probe + EDGE_EPSILON_PX);
      if (next && next.top <= shapeBottom && next.top - probe <= probe - slotBottom) {
        probe = next.top + EDGE_EPSILON_PX;
      }
    }
  }

  // 同じ高さで始まる入れ物と中身 (箱と最初の段落) は、後に並ぶ中身の方。
  const block = lastBlockStartingAt(lane, probe)!;
  const lineIndex = getLineAt(block, probe)?.index;
  return { block, ...(lineIndex === undefined ? {} : { lineIndex }) };
}

function lastBlockStartingAt(sortedBlocks: readonly MeasuredBlock[], probe: number): MeasuredBlock | undefined {
  let found: MeasuredBlock | undefined;
  for (const block of sortedBlocks) {
    if (block.top <= probe + EDGE_EPSILON_PX) {
      found = block;
    }
  }
  return found;
}

/**
 * 図の横 (`probeX`) にある本文の縦の帯 (段) に重なるブロックだけを、上から順に返す。
 *
 * 帯はいちばん内側のブロック (段組・箱・リストの入れ物は中の段をまたいで広がるので使わない) の左右の範囲で、
 * 次の順に決める。
 * 1. 図と同じ高さで `probeX` を含む、いちばん幅の狭いブロック。
 * 2. 同じページで `probeX` を含む、その高さのブロックより広くないブロック。段の先頭に前の段から続く段落の行は
 *    続きの段落のブロックとしては測られないので、同じ高さに同じ段のブロックが無いことがある。全幅の段落はほかの
 *    高さにあっても段を決めない。
 * 3. 図と同じ高さで横にいちばん近いブロック (段と段の間・ページの余白に置いた図)。
 *
 * ページ内の段組では、段組の上下にある全幅の段落も帯に重なるので候補に残り、隣の段の本文は重ならないので外れる。
 * 段を左端の位置だけでまとめると、全幅の段落が 1 段目に入って 1 段目がページ幅まで広がり、2 段目以降の図が
 * 1 段目の本文へ繋がってしまう。
 */
function restrictBlocksToProbeLane(
  blocks: readonly MeasuredBlock[],
  probeX: number,
  top: number,
  bottom: number,
): MeasuredBlock[] {
  const spanOf = (block: MeasuredBlock) => (
    typeof block.left === "number" && typeof block.width === "number" && block.width > 0
      ? { left: block.left, right: block.left + block.width }
      : null
  );
  const containerIds = new Set(blocks.map((block) => block.containerId).filter((id) => id !== undefined));
  const leaves = blocks.filter((block) => spanOf(block) !== null && !containerIds.has(block.id));
  if (leaves.length === 0 || !Number.isFinite(probeX)) {
    return [...blocks];
  }
  const widthOf = (block: MeasuredBlock) => block.width!;
  const distanceOf = (block: MeasuredBlock) => {
    const span = spanOf(block)!;
    return Math.max(0, span.left - probeX, probeX - span.right);
  };
  const narrowestFirst = (a: MeasuredBlock, b: MeasuredBlock) => widthOf(a) - widthOf(b);
  const narrowestContaining = (list: readonly MeasuredBlock[]) => (
    list.filter((block) => distanceOf(block) <= EDGE_EPSILON_PX).sort(narrowestFirst)[0]
  );
  const atHeight = leaves.filter((block) => block.top <= bottom && block.top + (block.height ?? 0) >= top);
  const widestAtHeight = atHeight.length > 0 ? Math.max(...atHeight.map(widthOf)) : Number.POSITIVE_INFINITY;
  const laneBlock = narrowestContaining(atHeight) ??
    narrowestContaining(leaves.filter((block) => widthOf(block) <= widestAtHeight + LANE_OVERLAP_MIN_PX)) ??
    [...(atHeight.length > 0 ? atHeight : leaves)].sort((a, b) => distanceOf(a) - distanceOf(b) || narrowestFirst(a, b))[0];
  const lane = spanOf(laneBlock)!;
  return blocks.filter((block) => {
    const span = spanOf(block);
    return span === null || Math.min(span.right, lane.right) - Math.max(span.left, lane.left) > LANE_OVERLAP_MIN_PX;
  });
}

/** `probe` の高さにある行 (それより上なら最初の行)。紙面で図形を本文へ繋ぐとき (`pickBlockAnchor`) と同じ規則。 */
function getLineAt(block: MeasuredBlock, probe: number): MeasuredLine | undefined {
  const lines = [...(block.lines ?? [])].sort((a, b) => a.top - b.top);
  let chosen = lines[0];
  for (const line of lines) {
    if (line.top <= probe + EDGE_EPSILON_PX) {
      chosen = line;
    } else {
      break;
    }
  }
  return chosen;
}

/** `probe` の高さにある行 (行が無ければブロック) の下端。 */
function getSlotBottomAt(block: MeasuredBlock, probe: number): number {
  const line = getLineAt(block, probe);
  return line ? line.top + line.height : block.top + (block.height ?? 0);
}

/**
 * ページそのものの飾り: 本文域のほぼ全高を占めるか、上下の余白 (ヘッダー/フッターの帯) の中だけにある。
 */
export function isPageFurniture(bounds: OverlayBounds, band: BodyPageBand): boolean {
  if (bounds.h >= band.contentHeightPx * PAGE_FURNITURE_HEIGHT_RATIO) {
    return true;
  }
  const { pageIndex } = pageIndexForY(bounds.y, band.pageStridePx);
  const localTop = bounds.y - pageIndex * band.pageStridePx;
  const localBottom = localTop + bounds.h;
  return localBottom <= band.contentTopPx + EDGE_EPSILON_PX ||
    localTop >= band.contentTopPx + band.contentHeightPx - EDGE_EPSILON_PX;
}

function boundsTouch(a: OverlayBounds, b: OverlayBounds): boolean {
  return a.x <= b.x + b.w + CLUSTER_TOUCH_TOLERANCE_PX &&
    b.x <= a.x + a.w + CLUSTER_TOUCH_TOLERANCE_PX &&
    a.y <= b.y + b.h + CLUSTER_TOUCH_TOLERANCE_PX &&
    b.y <= a.y + a.h + CLUSTER_TOUCH_TOLERANCE_PX;
}

function unionBounds(list: readonly OverlayBounds[]): OverlayBounds {
  const left = Math.min(...list.map((bounds) => bounds.x));
  const top = Math.min(...list.map((bounds) => bounds.y));
  const right = Math.max(...list.map((bounds) => bounds.x + bounds.w));
  const bottom = Math.max(...list.map((bounds) => bounds.y + bounds.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}
