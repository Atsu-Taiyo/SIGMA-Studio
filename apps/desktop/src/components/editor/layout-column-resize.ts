/**
 * 部分段組の列境界。本文 (React) と入れ子 (Tiptap の widget) の両方の境界ボタンが、同じ
 * 見た目・同じドラッグ・同じ確定規則を使う。
 *
 * ボタンは段間の全幅を覆う透明な当たり判定で、中身 (つまみ・結合プレビュー) もここで作る。
 * ドラッグ中は grid のプレビューとボタンの custom property だけを書き、文書へは離した 1 回だけ
 * `onCommit(leftWidth, rightWidth)` を返す (幅はレイアウト px。どちらかが 0 なら 2 列の結合)。
 */

export interface LayoutColumnResizeLabels {
  /** 端まで寄せたとき「離すと結合する」と示す表示。 */
  merge: string;
}

export interface LayoutColumnResizeOptions {
  labels?: LayoutColumnResizeLabels;
}

type ResizeCommit = (leftWidth: number, rightWidth: number) => void;

/** 列の最小幅。段組全体の幅に対する比。これより狭い段は本文を組めない。 */
export const LAYOUT_COLUMN_MIN_FRACTION = 0.1;
/** 均等 (2 列の中央) へ吸い付く距離 (画面 px)。 */
const SNAP_SCREEN_PX = 8;
/** これより動かなければクリック。文書は書き換えない (丸めで幅が 1 ずれた版を作らない)。 */
const CLICK_SLOP_SCREEN_PX = 3;
const DOUBLE_CLICK_MS = 400;
const KEY_STEP_FRACTION = 0.01;
const KEY_STEP_LARGE_FRACTION = 0.05;
const KNOB_EDGE_PX = 14;

const KNOB_CLASS = "layout-section-column-resize-knob";
const MERGE_CLASS = "layout-section-column-resize-merge";
const GRID_SELECTOR = ".layout-section-independent-columns";
const COLUMN_SELECTOR = ":scope > .layout-section-independent-column";

export type LayoutColumnResizeState = "resize" | "equal" | "merge";

export interface LayoutColumnResizePreview {
  left: number;
  right: number;
  state: LayoutColumnResizeState;
  /** `merge` のとき、離すと消える (隣へ結合される) 側。 */
  collapsing?: "left" | "right";
}

/**
 * ドラッグ量から 2 列の幅を決める。
 *
 * - 各列は最小幅 (始めからそれより狭い列はその幅) より狭くしない。
 * - 最小幅の半分より先まで寄せると **結合**。プレビューは最小幅で止め、潰れた本文は描かない。
 * - 2 列の中央のそばでは均等に吸い付く。
 */
export function resolveLayoutColumnResizePreview(input: {
  leftWidth: number;
  rightWidth: number;
  delta: number;
  minWidth: number;
  snapPx: number;
}): LayoutColumnResizePreview {
  const { leftWidth, rightWidth, delta, minWidth, snapPx } = input;
  const pair = leftWidth + rightWidth;
  const leftMin = Math.max(0, Math.min(minWidth, leftWidth));
  const rightMin = Math.max(0, Math.min(minWidth, rightWidth));
  const raw = Math.max(0, Math.min(pair, leftWidth + delta));
  if (delta < 0 && raw < leftMin / 2) {
    return { left: leftMin, right: pair - leftMin, state: "merge", collapsing: "left" };
  }
  if (delta > 0 && pair - raw < rightMin / 2) {
    return { left: pair - rightMin, right: rightMin, state: "merge", collapsing: "right" };
  }
  if (Math.abs(raw - pair / 2) <= snapPx) {
    return { left: pair / 2, right: pair / 2, state: "equal" };
  }
  const left = Math.max(leftMin, Math.min(pair - rightMin, raw));
  return { left, right: pair - left, state: "resize" };
}

/** 段組全体に対する 2 列それぞれの割合 (%)。 */
export function formatLayoutColumnShare(left: number, right: number, total: number): string {
  const share = (width: number) => `${Math.round(total > 0 ? width / total * 100 : 0)}%`;
  return `${share(left)} : ${share(right)}`;
}

interface ColumnGeometry {
  grid: HTMLElement;
  scale: number;
  widths: number[];
  left: number;
  right: number;
  total: number;
}

function measureColumns(handle: HTMLElement, dividerIndex: number): ColumnGeometry | null {
  const grid = handle.closest<HTMLElement>(GRID_SELECTOR);
  const columns = grid ? [...grid.querySelectorAll<HTMLElement>(COLUMN_SELECTOR)] : [];
  if (!grid || !columns[dividerIndex] || !columns[dividerIndex + 1]) return null;
  const gridRect = grid.getBoundingClientRect();
  const scale = grid.offsetWidth > 0 && gridRect.width > 0 ? gridRect.width / grid.offsetWidth : 1;
  const widths = columns.map((column) => column.getBoundingClientRect().width / scale);
  return {
    grid,
    scale,
    widths,
    left: widths[dividerIndex],
    right: widths[dividerIndex + 1],
    total: widths.reduce((sum, width) => sum + width, 0),
  };
}

const lastClickAt = new WeakMap<HTMLElement, number>();

function setKnobY(handle: HTMLElement, clientY: number, scale: number) {
  const rect = handle.getBoundingClientRect();
  const height = rect.height / scale;
  const y = (clientY - rect.top) / scale;
  const clamped = height > KNOB_EDGE_PX * 2 ? Math.max(KNOB_EDGE_PX, Math.min(height - KNOB_EDGE_PX, y)) : height / 2;
  handle.style.setProperty("--layout-column-knob-y", `${clamped}px`);
}

/** Shared pointer session for body and nested independent column dividers. */
export function beginLayoutColumnResize(
  event: PointerEvent | { button: number; clientX: number; clientY?: number; pointerId: number; preventDefault(): void; stopPropagation(): void },
  handle: HTMLElement,
  dividerIndex: number,
  onCommit: ResizeCommit,
  options: LayoutColumnResizeOptions = {},
): () => void {
  if (event.button !== 0) return () => {};
  event.preventDefault();
  event.stopPropagation();
  const geometry = measureColumns(handle, dividerIndex);
  if (!geometry) return () => {};
  const { grid, scale, widths: initialWidths, left: leftWidth, right: rightWidth, total } = geometry;
  const startX = event.clientX;
  const minWidth = total * LAYOUT_COLUMN_MIN_FRACTION;
  const originalGridTemplateColumns = grid.style.gridTemplateColumns;
  const ownerWindow = handle.ownerDocument.defaultView ?? window;
  const merge = handle.querySelector<HTMLElement>(`:scope > .${MERGE_CLASS}`);
  let preview: LayoutColumnResizePreview = { left: leftWidth, right: rightWidth, state: "resize" };
  let moved = false;
  let finished = false;
  handle.dataset.dragging = "true";
  handle.setPointerCapture(event.pointerId);
  if (typeof event.clientY === "number") setKnobY(handle, event.clientY, scale);
  const onMove = (moveEvent: PointerEvent) => {
    const screenDelta = moveEvent.clientX - startX;
    if (!moved && Math.abs(screenDelta) < CLICK_SLOP_SCREEN_PX) return;
    moved = true;
    preview = resolveLayoutColumnResizePreview({
      leftWidth,
      rightWidth,
      delta: screenDelta / scale,
      minWidth,
      snapPx: SNAP_SCREEN_PX / scale,
    });
    const widths = [...initialWidths];
    widths[dividerIndex] = preview.left;
    widths[dividerIndex + 1] = preview.right;
    grid.style.gridTemplateColumns = widths.map((width) => `${Math.max(0, width)}px`).join(" ");
    handle.style.setProperty("--layout-column-resize-preview-x", `${preview.left - leftWidth}px`);
    setKnobY(handle, moveEvent.clientY, scale);
    handle.dataset.resizeState = preview.state;
    handle.dataset.readout = preview.state === "merge" && options.labels
      ? options.labels.merge
      : formatLayoutColumnShare(preview.left, preview.right, total);
    if (merge) {
      if (preview.collapsing) {
        merge.dataset.side = preview.collapsing;
        merge.style.setProperty("--layout-column-merge-width", `${preview.collapsing === "left" ? preview.left : preview.right}px`);
      } else {
        delete merge.dataset.side;
      }
    }
  };
  const finish = (commit: boolean) => {
    if (finished) return;
    finished = true;
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onCancel);
    handle.removeEventListener("lostpointercapture", onCancel);
    ownerWindow.removeEventListener("keydown", onKeyDown, true);
    grid.style.gridTemplateColumns = originalGridTemplateColumns;
    handle.style.removeProperty("--layout-column-resize-preview-x");
    delete handle.dataset.dragging;
    delete handle.dataset.resizeState;
    delete handle.dataset.readout;
    if (merge) delete merge.dataset.side;
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    if (!commit) return;
    if (!moved) {
      // クリック。2 回目のクリックなら 2 列を均等に戻す。それ以外は何も書かない。
      const now = Date.now();
      const previous = lastClickAt.get(handle);
      if (previous !== undefined && now - previous <= DOUBLE_CLICK_MS) {
        lastClickAt.delete(handle);
        if (Math.abs(leftWidth - rightWidth) >= 1) onCommit((leftWidth + rightWidth) / 2, (leftWidth + rightWidth) / 2);
      } else {
        lastClickAt.set(handle, now);
      }
      return;
    }
    lastClickAt.delete(handle);
    if (preview.state === "merge") {
      onCommit(preview.collapsing === "left" ? 0 : leftWidth + rightWidth, preview.collapsing === "right" ? 0 : leftWidth + rightWidth);
      return;
    }
    if (Math.abs(preview.left - leftWidth) >= 0.5) onCommit(preview.left, preview.right);
  };
  const onUp = () => finish(true);
  const onCancel = () => finish(false);
  const onKeyDown = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key !== "Escape") return;
    keyEvent.preventDefault();
    keyEvent.stopPropagation();
    finish(false);
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onCancel);
  handle.addEventListener("lostpointercapture", onCancel);
  ownerWindow.addEventListener("keydown", onKeyDown, true);
  return onCancel;
}

/**
 * ←/→ で境界を動かす (Shift で大きく)。キーボードでは結合しない — 最小幅で止める。
 * 確定で境界ボタンが作り直される面 (Tiptap の widget) でも、同じ境界へフォーカスを戻す。
 */
export function adjustLayoutColumnsWithKey(
  event: KeyboardEvent | { key: string; shiftKey: boolean; preventDefault(): void; stopPropagation(): void },
  handle: HTMLElement,
  dividerIndex: number,
  onCommit: ResizeCommit,
): boolean {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return false;
  event.preventDefault();
  event.stopPropagation();
  const geometry = measureColumns(handle, dividerIndex);
  if (!geometry) return true;
  const { left, right, total } = geometry;
  const minWidth = Math.min(total * LAYOUT_COLUMN_MIN_FRACTION, left, right);
  const step = total * (event.shiftKey ? KEY_STEP_LARGE_FRACTION : KEY_STEP_FRACTION) * (event.key === "ArrowLeft" ? -1 : 1);
  const next = Math.max(minWidth, Math.min(left + right - minWidth, left + step));
  if (Math.abs(next - left) < 0.5) return true;
  const sectionId = handle.dataset.layoutSectionId;
  const ownerDocument = handle.ownerDocument;
  onCommit(next, left + right - next);
  if (!sectionId) return true;
  ownerDocument.defaultView?.requestAnimationFrame(() => {
    if (handle.isConnected) {
      handle.focus();
      return;
    }
    ownerDocument.querySelector<HTMLElement>(
      `.layout-section-column-resize-handle[data-layout-section-id="${CSS.escape(sectionId)}"][data-divider-index="${dividerIndex}"]`,
    )?.focus();
  });
  return true;
}

export interface LayoutColumnResizeHandleBinding {
  dividerIndex: number;
  labels: LayoutColumnResizeLabels;
  onCommit: ResizeCommit;
}

/**
 * 境界ボタンに中身 (つまみ・結合プレビュー) とイベントを付ける。`resolve` はイベントのたびに
 * 呼ぶので、描画ごとに作り直されるコールバックもそのまま渡せる。戻り値で外す。
 */
export function attachLayoutColumnResizeHandle(
  handle: HTMLElement,
  resolve: () => LayoutColumnResizeHandleBinding,
): () => void {
  const ownerDocument = handle.ownerDocument;
  const created: HTMLElement[] = [];
  for (const className of [KNOB_CLASS, MERGE_CLASS]) {
    if (handle.querySelector(`:scope > .${className}`)) continue;
    const part = ownerDocument.createElement("span");
    part.className = className;
    part.setAttribute("aria-hidden", "true");
    handle.append(part);
    created.push(part);
  }
  let cancel: (() => void) | null = null;
  const onPointerDown = (event: PointerEvent) => {
    cancel?.();
    const { dividerIndex, labels, onCommit } = resolve();
    cancel = beginLayoutColumnResize(event, handle, dividerIndex, onCommit, { labels });
  };
  const onHover = (event: PointerEvent) => {
    if (handle.dataset.dragging) return;
    const grid = handle.closest<HTMLElement>(GRID_SELECTOR);
    const gridRect = grid?.getBoundingClientRect();
    const scale = grid && gridRect && grid.offsetWidth > 0 && gridRect.width > 0 ? gridRect.width / grid.offsetWidth : 1;
    setKnobY(handle, event.clientY, scale);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const { dividerIndex, onCommit } = resolve();
    adjustLayoutColumnsWithKey(event, handle, dividerIndex, onCommit);
  };
  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onHover);
  handle.addEventListener("keydown", onKeyDown);
  return () => {
    cancel?.();
    cancel = null;
    handle.removeEventListener("pointerdown", onPointerDown);
    handle.removeEventListener("pointermove", onHover);
    handle.removeEventListener("keydown", onKeyDown);
    for (const part of created) part.remove();
  };
}
