import { getTablePlacementBounds } from "@/features/drawing";

type Point = { x: number; y: number };
type Release = Point & { pointerId: number; ctrlKey: boolean; shiftKey: boolean };
type Placement = ReturnType<typeof getTablePlacementBounds>;
interface Binding {
  bounds: (start: Point, end: Point) => Placement;
  commit: (start: Point, end: Release) => void;
  cancel: () => void;
  freeze: () => void;
}
interface Feedback {
  id: number;
  root: HTMLDivElement;
  grid: HTMLDivElement;
  svg: SVGSVGElement;
  path: SVGPathElement;
  hint: HTMLDivElement;
  start: Point | null;
  pointerId: number | null;
  end: Release | null;
  binding: Binding | null;
  committing: boolean;
  cancelRequest: () => void;
  dispose: () => void;
}
let active: Feedback | null = null;
let pointer: Point = { x: 120, y: 160 };

export function trackTablePlacementPointer() {
  const move = (event: PointerEvent) => { pointer = { x: event.clientX, y: event.clientY }; };
  document.addEventListener("pointermove", move, true);
  return () => { document.removeEventListener("pointermove", move, true); cancelTablePlacementFeedback(); };
}

export function hasTablePlacementFeedback() { return active !== null; }

function afterPaint(state: Feedback, action: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(() => { if (active === state) action(); }));
}

function draw(state: Feedback, end: Point) {
  const start = state.start ?? end;
  const box = state.binding?.bounds(start, end) ?? getTablePlacementBounds(start, end, { w: 64, h: 36 });
  Object.assign(state.grid.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
  state.grid.dataset.tablePreviewRows = String(box.rows);
  state.grid.dataset.tablePreviewColumns = String(box.columns);
  const lines = [`M0.5 0.5H${box.w - 0.5}V${box.h - 0.5}H0.5Z`,
    ...Array.from({ length: box.columns - 1 }, (_, i) => `M${(i + 1) * box.cellW} 0V${box.h}`),
    ...Array.from({ length: box.rows - 1 }, (_, i) => `M0 ${(i + 1) * box.cellH}H${box.w}`)];
  state.path.setAttribute("d", lines.join(" "));
  state.root.style.display = "";
}

function commitWhenReady(state: Feedback) {
  if (!state.binding || !state.start || !state.end || state.committing) return;
  state.committing = true;
  state.binding.freeze();
  // The solid placeholder gets a paint before canonical shape creation/editor mounting starts.
  afterPaint(state, () => {
    const binding = state.binding;
    if (!binding) { state.committing = false; return; }
    try { binding.commit(state.start!, state.end!); }
    catch (error) { finishTablePlacementFeedback(); throw error; }
  });
}

export function beginTablePlacementFeedback(id: number, hintText: string, cancelRequest: () => void, activate: () => void) {
  cancelTablePlacementFeedback();
  const root = document.createElement("div");
  Object.assign(root.style, { position: "fixed", inset: "0", pointerEvents: "none", zIndex: "10000" });
  root.dataset.tablePlacementPreview = "";
  root.dataset.tablePlacementFeedback = "";
  root.setAttribute("aria-hidden", "true");
  const grid = document.createElement("div");
  grid.className = "overlay-insert-preview-shape table-grid-placement";
  Object.assign(grid.style, { position: "fixed", zIndex: "10000", pointerEvents: "none" });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "100%"); svg.setAttribute("height", "100%");
  svg.classList.add("table-grid-placement-lines");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  svg.append(path);
  const hint = document.createElement("div");
  hint.className = "table-placement-hint"; hint.textContent = hintText;
  grid.append(svg, hint); root.append(grid); document.body.append(root);
  const state: Feedback = { id, root, grid, svg, path, hint, start: null, pointerId: null, end: null,
    binding: null, committing: false, cancelRequest, dispose: () => {} };
  active = state;
  const onCanvas = (event: PointerEvent) => event.target instanceof Element
    && Boolean(event.target.closest(".page-canvas, .overlay-canvas-editor"));
  const move = (event: PointerEvent) => {
    if (state.end) return;
    if (!state.start && !onCanvas(event)) {
      root.style.display = "none"; delete root.dataset.tablePlacementPreview; return;
    }
    root.dataset.tablePlacementPreview = "";
    draw(state, { x: event.clientX, y: event.clientY });
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0) return;
    if (state.start && onCanvas(event)) { event.preventDefault(); event.stopPropagation(); return; }
    if (!onCanvas(event)) { cancelTablePlacementFeedback(); return; }
    state.start = { x: event.clientX, y: event.clientY };
    state.pointerId = event.pointerId;
    if (!state.binding) { event.preventDefault(); event.stopPropagation(); }
    draw(state, state.start);
  };
  const up = (event: PointerEvent) => {
    if (!state.start) return;
    event.preventDefault(); event.stopPropagation();
    if (state.end || state.pointerId !== event.pointerId) return;
    state.end = { x: event.clientX, y: event.clientY, pointerId: event.pointerId,
      ctrlKey: event.ctrlKey, shiftKey: event.shiftKey };
    draw(state, state.end);
    delete root.dataset.tablePlacementPreview;
    root.dataset.tablePlacementPending = "";
    Object.assign(svg.style, { stroke: "#111827", strokeDasharray: "none", background: "transparent" });
    hint.style.display = "none";
    state.binding?.freeze();
    commitWhenReady(state);
  };
  const cancel = () => cancelTablePlacementFeedback();
  const key = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
  document.addEventListener("pointermove", move, true);
  document.addEventListener("pointerdown", down, true);
  document.addEventListener("pointerup", up, true);
  document.addEventListener("pointercancel", cancel, true);
  document.addEventListener("keydown", key, true);
  window.addEventListener("blur", cancel);
  state.dispose = () => {
    root.remove();
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerdown", down, true);
    document.removeEventListener("pointerup", up, true);
    document.removeEventListener("pointercancel", cancel, true);
    document.removeEventListener("keydown", key, true);
    window.removeEventListener("blur", cancel);
  };
  draw(state, pointer);
  afterPaint(state, activate);
}

export function bindTablePlacementFeedback(id: number, binding: Binding) {
  const state = active;
  if (!state || state.id !== id) return;
  state.binding = binding;
  if (state.start) draw(state, state.end ?? pointer);
  commitWhenReady(state);
  return () => { if (state.binding === binding) state.binding = null; };
}

export function finishTablePlacementFeedback() {
  const state = active;
  active = null;
  state?.dispose();
}

export function cancelTablePlacementFeedback() {
  const state = active;
  finishTablePlacementFeedback();
  state?.cancelRequest();
  state?.binding?.cancel();
}
