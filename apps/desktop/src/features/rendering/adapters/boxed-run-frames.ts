import { getEffectiveZoom } from "./boxed-inline-dom";

/** One frame in its paragraph's untransformed coordinate space. */
export interface BoxedRunFrame {
  left: number;
  top: number;
  width: number;
  height: number;
  variant: string | null;
  tone: string | null;
  color?: string;
}

const round = (value: number) => Math.round(value * 100) / 100;

export function hasBoxedRunFrameContent(segment: HTMLElement): boolean {
  // A math atom can paint an SVG/rule without any text. Only plain whitespace
  // is excluded: it still reserves the run's horizontal padding.
  const mathOrGraphic = '[data-sigma-doc-boxed-math="true"], .math-preview, .inline-math-node, svg, img';
  return /[^\s\u200B-\u200D\uFEFF]/u.test(segment.textContent ?? "")
    || segment.matches(mathOrGraphic) || segment.querySelector(mathOrGraphic) !== null;
}

/** Shared by the editing and static surfaces after their inline heights settle. */
export function readBoxedRunFrames(container: HTMLElement): BoxedRunFrame[] {
  const segments = container.querySelectorAll<HTMLElement>('[data-boxed-run-height-target="true"]');
  if (!segments.length) return [];
  const origin = container.getBoundingClientRect();
  const style = window.getComputedStyle(container);
  const scaleX = getEffectiveZoom(container, "x"), scaleY = getEffectiveZoom(container, "y");
  const originLeft = origin.left + (Number.parseFloat(style.borderLeftWidth) || 0) * scaleX;
  const originTop = origin.top + (Number.parseFloat(style.borderTopWidth) || 0) * scaleY;
  const frames: BoxedRunFrame[] = [];
  let run: { left: number; top: number; right: number; bottom: number; lastRight: number; contentTop?: number; contentBottom?: number; variant: string | null; tone: string | null; color?: string; id: string | null } | undefined;
  const flush = () => {
    if (run) {
      // Whitespace-only inline-flex boxes have no text baseline. Equalising their
      // height can move them above the visible run, so they must not enlarge its
      // vertical frame. Keep both horizontal edges, and preserve blank answer
      // boxes (including a whitespace-only wrapped line) via the fallback.
      const top = run.contentTop ?? run.top, bottom = run.contentBottom ?? run.bottom;
      frames.push({ left: round(run.left), top: round(top), width: round(run.right - run.left),
        height: round(bottom - top), variant: run.variant, tone: run.tone, ...(run.color ? { color: run.color } : {}) });
    }
    run = undefined;
  };
  for (const segment of segments) {
    const mark = segment.closest<HTMLElement>(".boxed-text") ?? segment;
    const variant = mark.getAttribute("data-sigma-doc-boxed-variant");
    const tone = mark.getAttribute("data-sigma-doc-boxed-tone");
    const color = window.getComputedStyle(segment).color;
    const id = segment.getAttribute("data-boxed-run-id");
    const hasContent = hasBoxedRunFrameContent(segment);
    for (const rect of Array.from(segment.getClientRects())) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      const left = (rect.left - originLeft) / scaleX, top = (rect.top - originTop) / scaleY;
      const right = left + rect.width / scaleX, bottom = top + rect.height / scaleY;
      const overlap = run ? Math.min(bottom, run.bottom) - Math.max(top, run.top) : 0;
      // A canonical run already proves adjacency. Text and a tall formula can
      // share a baseline while their padded boxes overlap by less than 60%,
      // and inline math margins can leave a small horizontal gap. Their frame
      // encloses the union instead of drawing an internal border at each atom.
      // A wrapped line resets x; compare against the previous fragment's right
      // edge (not the union's left edge) so overlapping tall lines stay apart.
      const sameVisualLine = run && overlap > 1 && left >= run.lastRight - 1.5;
      const connect = id !== null
        ? sameVisualLine
        : run && overlap >= Math.min(bottom - top, run.bottom - run.top) * 0.6
          && left - run.right <= 1.5 && left >= run.left - 1.5;
      if (run && run.variant === variant && run.tone === tone && run.id === id && connect) {
        run.left = Math.min(run.left, left); run.top = Math.min(run.top, top);
        run.right = Math.max(run.right, right); run.bottom = Math.max(run.bottom, bottom);
        run.lastRight = right;
        if (hasContent) {
          run.contentTop = Math.min(run.contentTop ?? top, top);
          run.contentBottom = Math.max(run.contentBottom ?? bottom, bottom);
        }
      } else {
        flush(); run = { left, top, right, bottom, lastRight: right, variant, tone, color, id,
          ...(hasContent ? { contentTop: top, contentBottom: bottom } : {}) };
      }
    }
  }
  flush();
  return frames;
}

export function createBoxedRunFrameLayer(frames: readonly BoxedRunFrame[]): HTMLElement {
  const layer = document.createElement("span");
  layer.className = "boxed-run-frame-layer";
  layer.contentEditable = "false";
  layer.setAttribute("aria-hidden", "true");
  for (const frame of frames) {
    const element = document.createElement("span");
    element.className = "boxed-run-frame";
    if (frame.variant) element.setAttribute("data-sigma-doc-boxed-variant", frame.variant);
    if (frame.tone) element.setAttribute("data-sigma-doc-boxed-tone", frame.tone);
    if (frame.color) element.style.color = frame.color;
    Object.assign(element.style, { left: `${frame.left}px`, top: `${frame.top}px`, width: `${frame.width}px`, height: `${frame.height}px` });
    layer.appendChild(element);
  }
  return layer;
}
