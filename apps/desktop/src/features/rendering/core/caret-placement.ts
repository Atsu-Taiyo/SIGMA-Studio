/**
 * ページや段を跨ぐブロックは、正本 (最初の断片) と続きの断片という複数の面に分かれて描かれる。
 * 「ブロック上端からの縦位置がどの断片に見えているか」を、レイアウトの数値だけから一意に決める
 * 純関数群。ブラウザにも描画エンジンにも依存しないので、編集面・印刷面のどちらからも同じ答えを
 * 得られる。
 *
 * 座標系: `localY` はブロック上端からの縦位置 (拡大前の紙面 px)。断片テーブルの `sourceOffsetY`
 * と `height` も同じ単位なので、比較は素のまま成立する。
 */

/** ブロック外かどうかの判定に許す誤差 (px)。採寸の丸めで 1 px 未満はずれる。 */
const CARET_BOUND_TOLERANCE = 0.5;

/** 1 つの断片が見せているブロック内の帯。 */
export interface CaretFragmentPlacement {
  fragmentIndex: number;
  sourceOffsetY: number;
  height: number;
}

/** 正本が見せている高さと、ブロック全体の高さ。 */
export interface CaretFragmentSourceLayout {
  visibleHeight: number;
  totalHeight: number;
  /** First fragment position in unscaled page-canvas coordinates. */
  origin?: { x: number; y: number; width: number };
}

/**
 * 断片の並び。`fragments` は `fragmentIndex` が一意で昇順、帯も昇順であることを前提にする
 * (`buildCaretFragmentTable` がその形を保証する。手で組むときは同じ条件を満たすこと)。
 */
export interface CaretFragmentTable {
  totalHeight: number;
  fragments: readonly CaretFragmentPlacement[];
}

/**
 * `"same"` は「今いる断片の中で動いた」、`"fragment"` は「別の断片へ移った」。ペイロードは同型
 * なので、呼び出し側は**両方**を「断片の上の位置」として扱うこと (片方だけ見ると同一断片内の
 * 移動を取りこぼす)。`resolveCaretSurface` は位置を引くだけなので `"same"` は返さない。
 */
export type CaretPlacement =
  | { kind: "fragment"; fragmentIndex: number; localY: number }
  | { kind: "same"; fragmentIndex: number; localY: number }
  | { kind: "beforeBlock" }
  | { kind: "afterBlock" };

export interface CaretVerticalMoveInput {
  direction: "up" | "down";
  lineHeight: number;
  localY: number;
  table: CaretFragmentTable;
}

/**
 * 正本のレイアウトと続きの断片から、index 0 を先頭に持つ 1 本のテーブルを組む。
 *
 * ページ割りの側は「続きの断片」だけを配列で持ち、正本は別の形 (可視高さと全高) で持っている。
 * 面を決める側から見ると両者は同じ帯なので、ここで 1 本に合成する。並びと一意性はここで正す:
 * 呼び出し側から順不同や重複が来ても、後続の引き方が食い違わないようにするため。
 */
export function buildCaretFragmentTable(
  source: CaretFragmentSourceLayout,
  replicas: readonly CaretFragmentPlacement[],
): CaretFragmentTable {
  const byIndex = new Map<number, CaretFragmentPlacement>();
  for (const fragment of replicas) {
    if (fragment.fragmentIndex <= 0 || byIndex.has(fragment.fragmentIndex)) {
      continue;
    }
    byIndex.set(fragment.fragmentIndex, {
      fragmentIndex: fragment.fragmentIndex,
      sourceOffsetY: fragment.sourceOffsetY,
      height: fragment.height,
    });
  }
  const continuations = [...byIndex.values()]
    .sort((first, second) => first.fragmentIndex - second.fragmentIndex);

  return {
    fragments: [
      { fragmentIndex: 0, sourceOffsetY: 0, height: source.visibleHeight },
      ...continuations,
    ],
    totalHeight: source.totalHeight,
  };
}

/**
 * ブロック内の縦位置を見せている断片を決める。
 *
 * 帯は半開区間 `[sourceOffsetY, sourceOffsetY + height)` で、境界ちょうどは次の断片のもの
 * (そうしないと境界で 2 つの断片が同時に名乗る)。ただし**最終断片の下端はブロック内の合法な
 * 末尾位置**なので、外へ出さず最終断片へ寄せる。返す `localY` は必ず `[0, totalHeight]` に
 * 収まる。
 */
export function resolveCaretSurface(localY: number, table: CaretFragmentTable): CaretPlacement {
  if (!Number.isFinite(localY) || localY < -CARET_BOUND_TOLERANCE) {
    // 数値でない位置はブロックの上に無いものとして扱う (黙って最終断片へ落とさない)。
    return { kind: "beforeBlock" };
  }
  if (localY > table.totalHeight + CARET_BOUND_TOLERANCE) {
    return { kind: "afterBlock" };
  }

  const clamped = Math.min(Math.max(localY, 0), table.totalHeight);
  // 高さ 0 の断片はページ送りの都合で生まれる (次の段へ送るだけの断片)。何も見せていないので
  // 宛先にしない。
  const visible = table.fragments.filter((fragment) => fragment.height > 0);
  const fallback = visible.at(-1) ?? table.fragments[0];
  if (!fallback) {
    return { kind: "afterBlock" };
  }
  for (const fragment of visible) {
    if (clamped < fragment.sourceOffsetY + fragment.height) {
      return { kind: "fragment", fragmentIndex: fragment.fragmentIndex, localY: clamped };
    }
  }
  return { kind: "fragment", fragmentIndex: fallback.fragmentIndex, localY: clamped };
}

/**
 * **ブロック内**の縦位置を、それを見せている断片の中での縦位置へ移す。ブロック外なら null。
 *
 * 返るのは断片の中でのオフセット (常に `[0, height]`) であって、紙面上の絶対座標ではない。
 * 紙面へ落とすときは断片の矩形の上端を足すこと。
 */
export function blockLocalYToFragmentOffset(localY: number, table: CaretFragmentTable): number | null {
  const placement = resolveCaretSurface(localY, table);
  if (placement.kind !== "fragment") {
    return null;
  }
  const fragment = findFragment(table, placement.fragmentIndex);
  if (!fragment) {
    return null;
  }
  const offset = placement.localY - fragment.sourceOffsetY;
  return Math.min(Math.max(offset, 0), Math.max(0, fragment.height));
}

/**
 * `blockLocalYToFragmentOffset` の逆。**断片の中**での縦位置をブロック内の縦位置へ戻す。
 * 断片の外を指す値・数値でない値は null (順方向がブロック外で null を返すのと揃える)。
 */
export function fragmentOffsetToBlockLocalY(
  offsetInFragment: number,
  fragmentIndex: number,
  table: CaretFragmentTable,
): number | null {
  const fragment = findFragment(table, fragmentIndex);
  if (!fragment || !Number.isFinite(offsetInFragment)) {
    return null;
  }
  if (offsetInFragment < 0 || offsetInFragment > fragment.height) {
    return null;
  }
  return fragment.sourceOffsetY + offsetInFragment;
}

/**
 * 1 行ぶんの上下移動の行き先を決める。
 *
 * 断片の境界はブロックの境界ではないので、ブラウザ任せの移動では「同じ doc の中で成功したまま
 * 見えない場所へ行く」。行き先の断片をここで先に決めておく。
 *
 * **移動量はブロック内座標でちょうど 1 行**であり、途中の断片の高さで削られない。これが往復
 * 対称性 (`up(down(y)) === y`) の根拠で、行より低い断片 (未計測フォールバックが作りうる) を
 * 挟んでもキャレットが 1 行ずつ上へ流れない。行の高さがブロックの残りより大きくて**ブロックの
 * 外**へ出てしまうときだけ、隣の断片の中に留める (まだ断片が残っているのに文書の次のブロックへ
 * 抜けてしまわないため)。
 */
export function resolveVerticalMove({
  direction,
  lineHeight,
  localY,
  table,
}: CaretVerticalMoveInput): CaretPlacement {
  const current = resolveCaretSurface(localY, table);
  if (current.kind !== "fragment") {
    return current;
  }
  if (!Number.isFinite(lineHeight)) {
    return { kind: "same", fragmentIndex: current.fragmentIndex, localY: current.localY };
  }

  const step = Math.abs(lineHeight);
  const target = direction === "down" ? current.localY + step : current.localY - step;
  const moved = resolveCaretSurface(target, table);
  if (moved.kind === "fragment") {
    return moved.fragmentIndex === current.fragmentIndex
      ? { kind: "same", fragmentIndex: moved.fragmentIndex, localY: moved.localY }
      : moved;
  }

  const neighbour = neighbourFragment(table, current.fragmentIndex, direction);
  if (!neighbour) {
    return direction === "down" ? { kind: "afterBlock" } : { kind: "beforeBlock" };
  }
  return {
    kind: "fragment",
    fragmentIndex: neighbour.fragmentIndex,
    localY: clampIntoFragment(target, neighbour, step, table),
  };
}

/**
 * 文書順を表すタプルの比較。要素が少ない方 (ユニット自身) が、その断片より先に来る。
 */
export function compareCaretSurfaceOrder(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const first = a[index] ?? Number.NEGATIVE_INFINITY;
    const second = b[index] ?? Number.NEGATIVE_INFINITY;
    if (first !== second) {
      return first < second ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 文書順で隣の面を返す。`current` と**同じ順序**の面は「今いる面」とみなして候補から外す
 * (順序だけでは自分と区別できないため)。候補が同じ順序を持っていても、必ず先に現れた 1 つに
 * 定まる — 面の登録順が変わっても行き先が揺れないようにするため。
 */
export function nextSurfaceInVisualOrder<T extends { order: readonly number[] }>(
  surfaces: readonly T[],
  current: readonly number[],
  direction: "up" | "down",
): T | null {
  let best: T | null = null;
  for (const surface of surfaces) {
    const toCurrent = compareCaretSurfaceOrder(surface.order, current);
    if (direction === "down" ? toCurrent <= 0 : toCurrent >= 0) {
      continue;
    }
    if (!best) {
      best = surface;
      continue;
    }
    const toBest = compareCaretSurfaceOrder(surface.order, best.order);
    if (direction === "down" ? toBest < 0 : toBest > 0) {
      best = surface;
    }
  }
  return best;
}

function findFragment(
  table: CaretFragmentTable,
  fragmentIndex: number,
): CaretFragmentPlacement | null {
  return table.fragments.find((fragment) => fragment.fragmentIndex === fragmentIndex) ?? null;
}

/**
 * 進行方向で最も近い「何かを見せている」断片。今いる断片自身が高さ 0 でも答えられるよう、
 * 配列の位置ではなく `fragmentIndex` の大小で引く。
 */
function neighbourFragment(
  table: CaretFragmentTable,
  fragmentIndex: number,
  direction: "up" | "down",
): CaretFragmentPlacement | null {
  const visible = table.fragments.filter((fragment) => fragment.height > 0);
  if (direction === "down") {
    return visible.find((fragment) => fragment.fragmentIndex > fragmentIndex) ?? null;
  }
  return visible.filter((fragment) => fragment.fragmentIndex < fragmentIndex).at(-1) ?? null;
}

/**
 * ブロックの外へ出てしまった行き先を、隣の断片の中に留める。最終断片の下端はブロック内の合法な
 * 末尾位置なのでそこまで許し、それ以外は「1 行ぶん手前」を上限にする (下端ちょうどは次の断片の
 * ものなので、そこへ置くと行き先が 1 つずれる)。
 */
function clampIntoFragment(
  target: number,
  fragment: CaretFragmentPlacement,
  lineHeight: number,
  table: CaretFragmentTable,
): number {
  const start = fragment.sourceOffsetY;
  const end = Math.min(fragment.sourceOffsetY + fragment.height, table.totalHeight);
  const visible = table.fragments.filter((candidate) => candidate.height > 0);
  const isLast = visible.at(-1)?.fragmentIndex === fragment.fragmentIndex;
  return Math.max(start, Math.min(target, isLast ? end : end - lineHeight));
}
