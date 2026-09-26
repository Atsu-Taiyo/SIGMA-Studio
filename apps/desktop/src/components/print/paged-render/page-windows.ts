/**
 * Cuts a settled page canvas into paper-sized windows.
 *
 * The PDF is a clone of the editor canvas (docs/pdf-parity-architecture.md), so
 * nothing here may re-measure or re-position content. Each window clips one page
 * band out of an identical copy of the canvas; the only per-page difference is the
 * translation applied to the wrapper.
 */

import { stripWrappingMarkdownCodeFence } from "@/features/rendering/core";
import { visibleBlockClientRect } from "@/components/editor/page-canvas/visible-block-rect";

export interface PagedCanvasMetrics {
  pageCount: number;
  pageHeightPx: number;
  pageWidthPx: number;
  pageStridePx: number;
}

/**
 * Reads the layout result the canvas published after its own measurement pass.
 * Returns `null` while the canvas has not produced a layout yet.
 */
export function readPagedCanvasMetrics(canvas: HTMLElement | null): PagedCanvasMetrics | null {
  if (!canvas) {
    return null;
  }
  const pageCount = readPositiveNumber(canvas.dataset.pageCount);
  const pageHeightPx = readPositiveNumber(canvas.dataset.pageHeight);
  const pageStridePx = readPositiveNumber(canvas.dataset.pageStride);
  const pageWidthPx = canvas.getBoundingClientRect().width;
  if (pageCount === null || pageHeightPx === null || pageStridePx === null || pageWidthPx <= 0) {
    return null;
  }
  return {
    pageCount: Math.round(pageCount),
    pageHeightPx,
    pageWidthPx,
    pageStridePx,
  };
}

/**
 * Strips editing affordances from a clone. Only attributes that cannot affect
 * layout are touched — no stylesheet keys off any of them, so the clone lays out
 * byte-identically to the staged canvas.
 */
export function sanitizePagedClone(root: HTMLElement): void {
  root.removeAttribute("id");
  root.querySelectorAll("[contenteditable]").forEach((element) => {
    element.removeAttribute("contenteditable");
  });
  root.querySelectorAll("[tabindex]").forEach((element) => {
    element.removeAttribute("tabindex");
  });
  root.querySelectorAll("[autofocus]").forEach((element) => {
    element.removeAttribute("autofocus");
  });
}

/**
 * Attributes that identify a piece of content. Every page window holds a complete
 * copy of the canvas, so these have to be scoped to the page the element actually
 * lands on — otherwise `[data-sigma-doc-id="…"]` would resolve to page 1's copy of
 * a block that prints on page 5.
 */
const OWNED_ATTRIBUTES = [
  "data-sigma-doc-id",
  "data-overlay-shape-id",
  "data-flow-unit-id",
] as const;

const OWNED_SELECTOR = OWNED_ATTRIBUTES.map((name) => `[${name}]`).join(",");

/**
 * Assigns each identified element to its visible fragment's page. Measured once
 * against the settled canvas; the clones are structurally identical, so the result
 * applies to them by document order.
 */
export function measurePageOwnership(canvas: HTMLElement, metrics: PagedCanvasMetrics): number[] {
  const canvasTop = canvas.getBoundingClientRect().top;
  const lastPageIndex = Math.max(0, metrics.pageCount - 1);
  return Array.from(canvas.querySelectorAll<HTMLElement>(OWNED_SELECTOR)).map((element) => {
    // A paragraph's natural top may be on the previous page while its remaining
    // lines are visible in this continuation. Use the same clip as hit testing.
    const visible = visibleBlockClientRect(element);
    if (!visible) return -1;
    const top = visible.top - canvasTop;
    const index = Math.floor(top / metrics.pageStridePx);
    return Math.min(lastPageIndex, Math.max(0, index));
  });
}

/**
 * `ownership` is indexed by document order within the canvas, so it must be applied
 * to the cloned canvas — not the cloned `.page-mode` root, whose element set differs.
 */
function applyPageOwnership(clonedCanvas: Element, ownership: readonly number[], pageIndex: number): void {
  const elements = clonedCanvas.querySelectorAll(OWNED_SELECTOR);
  elements.forEach((element, index) => {
    if (ownership[index] === pageIndex) {
      return;
    }
    for (const name of OWNED_ATTRIBUTES) {
      element.removeAttribute(name);
    }
  });
}

/**
 * Oversized code blocks keep only fixed-size continuation placeholders in the staged canvas.
 * Hydrate the one placeholder owned by this page from the canonical first-fragment `<pre>`.
 * Doing this after cloning keeps the staged DOM O(lines + pages), rather than materializing the
 * whole code string in every continuation before every page clones the complete canvas.
 */
export function hydratePagedCodeFragment(clonedCanvas: Element, pageIndex: number): void {
  const sources = Array.from(
    clonedCanvas.querySelectorAll<HTMLElement>(".print-code[data-sigma-doc-id]"),
  );
  const viewports = clonedCanvas.querySelectorAll<HTMLElement>(
    `[data-paged-code-fragment][data-fragment-page-index="${pageIndex}"]`,
  );

  viewports.forEach((viewport) => {
    const sourceId = viewport.getAttribute("data-box-source-id");
    const target = viewport.querySelector<HTMLElement>(":scope > .editor-box-fragment-editor");
    const source = sources.find((element) => element.getAttribute("data-sigma-doc-id") === sourceId);
    if (!source || !target) {
      return;
    }

    const clone = source.cloneNode(true) as HTMLElement;
    clone.removeAttribute("id");
    clone.removeAttribute("data-sigma-doc-id");
    clone.classList.remove("text-flow-box-fragment-source");
    clone.style.removeProperty("clip-path");
    clone.style.removeProperty("--text-flow-box-fragment-visible-height");
    clone.style.removeProperty("--text-flow-box-fragment-hidden-bottom");
    target.replaceChildren(clone);
  });
}

/**
 * The editing DOM represents every newline as its own `<br>` node. Collapse plain code in the
 * clone template so a large block does not multiply its nodes across page windows. Preserve
 * styled runs and syntax tokens: flattening those changes both their appearance and line wraps.
 * Editing widgets are removed from every code block before reading its text.
 */
export function compactPagedCodeBlocks(root: Element): void {
  root.querySelectorAll<HTMLElement>(".print-code").forEach((code) => {
    code.querySelectorAll("[data-code-block-action-button='true']").forEach((button) => button.remove());
    const original = readCodeDomText(code);
    const text = stripWrappingMarkdownCodeFence(original);
    if (hasStyledCodeContent(code)) {
      if (text !== original) {
        retainCodeTextRange(code, original, text);
      }
      return;
    }
    code.replaceChildren(code.ownerDocument.createTextNode(text));
  });
}

function hasStyledCodeContent(code: HTMLElement): boolean {
  return Array.from(code.querySelectorAll("*")).some((element) => element.tagName !== "BR");
}

/** Keep the markup around a stripped fence when the remaining text is one contiguous range. */
function retainCodeTextRange(code: HTMLElement, original: string, text: string): void {
  const start = original.indexOf(text);
  if (start < 0) {
    code.replaceChildren(code.ownerDocument.createTextNode(text));
    return;
  }
  const range = code.ownerDocument.createRange();
  const from = codeTextBoundary(code, start);
  const to = codeTextBoundary(code, start + text.length);
  if (!from || !to) {
    code.replaceChildren(code.ownerDocument.createTextNode(text));
    return;
  }
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  code.replaceChildren(range.cloneContents());
}

function codeTextBoundary(root: Node, position: number): { node: Node; offset: number } | null {
  let current = 0;
  function visit(parent: Node): { node: Node; offset: number } | null {
    for (const [index, node] of Array.from(parent.childNodes).entries()) {
      const length = node.nodeType === Node.TEXT_NODE
        ? (node.textContent?.length ?? 0)
        : node instanceof HTMLElement && node.tagName === "BR" ? 1 : 0;
      if (length > 0) {
        if (position <= current + length) {
          if (node.nodeType === Node.TEXT_NODE) {
            return { node, offset: position - current };
          }
          return { node: parent, offset: index + (position === current + 1 ? 1 : 0) };
        }
        current += length;
      } else {
        const nested = visit(node);
        if (nested) return nested;
      }
    }
    return null;
  }
  return visit(root) ?? (position === current ? { node: root, offset: root.childNodes.length } : null);
}

function readCodeDomText(root: Node): string {
  let text = "";
  root.childNodes.forEach((node) => {
    if (node.nodeType === 3) {
      text += node.textContent ?? "";
    } else if (node instanceof HTMLElement && node.tagName === "BR") {
      text += "\n";
    } else {
      text += readCodeDomText(node);
    }
  });
  return text;
}

export interface BuildPageWindowsOptions {
  /** The `.page-mode` root rendered by the paged canvas. */
  stageRoot: HTMLElement;
  /** The settled `.page-canvas` inside `stageRoot`. */
  canvas: HTMLElement;
  /** Receives the page windows. Existing children are replaced. */
  container: HTMLElement;
  metrics: PagedCanvasMetrics;
}

/**
 * Materializes one clipped window per page. Returns the number of pages written.
 */
export function buildPageWindows({
  stageRoot,
  canvas,
  container,
  metrics,
}: BuildPageWindowsOptions): number {
  const ownerDocument = container.ownerDocument;
  const fragment = ownerDocument.createDocumentFragment();
  const ownership = measurePageOwnership(canvas, metrics);
  const cloneTemplate = stageRoot.cloneNode(true) as HTMLElement;
  sanitizePagedClone(cloneTemplate);
  compactPagedCodeBlocks(cloneTemplate);

  // Where the canvas sits inside the staged root, after the stack's padding and
  // centring. The clone reproduces that offset, so the window has to cancel it to put
  // the page band at the window origin. Measuring it beats overriding the CSS, which
  // would make the staged layout stop being the editor's layout.
  const rootRect = stageRoot.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  const canvasOffsetTop = canvasRect.top - rootRect.top;
  const canvasOffsetLeft = canvasRect.left - rootRect.left;

  for (let index = 0; index < metrics.pageCount; index += 1) {
    const slot = ownerDocument.createElement("div");
    slot.className = "paged-surface-page-slot";

    const page = ownerDocument.createElement("div");
    page.className = "paged-surface-page";
    page.dataset.pageNumber = String(index + 1);
    page.style.setProperty("--paged-page-width", `${metrics.pageWidthPx}px`);
    page.style.setProperty("--paged-page-height", `${metrics.pageHeightPx}px`);

    const inner = ownerDocument.createElement("div");
    inner.className = "paged-surface-page-inner";
    inner.style.setProperty("--paged-page-offset", `${index * metrics.pageStridePx + canvasOffsetTop}px`);
    inner.style.setProperty("--paged-page-inset", `${canvasOffsetLeft}px`);

    const clone = cloneTemplate.cloneNode(true) as HTMLElement;
    const clonedCanvas = clone.querySelector(".page-canvas");
    if (clonedCanvas) {
      hydratePagedCodeFragment(clonedCanvas, index);
      applyPageOwnership(clonedCanvas, ownership, index);
    }
    inner.appendChild(clone);
    page.appendChild(inner);

    const pageNumber = ownerDocument.createElement("span");
    pageNumber.className = "paged-surface-page-number";
    pageNumber.textContent = `${index + 1} / ${metrics.pageCount}`;

    slot.append(page, pageNumber);
    fragment.appendChild(slot);
  }

  container.replaceChildren(fragment);
  return metrics.pageCount;
}

/**
 * A layout fingerprint. The canvas is considered settled once this stops changing.
 *
 * It has to include block positions, not just the canvas box: overlay shapes reserve
 * space in the flow, and that resolution can still be nudging content around while the
 * canvas height stays put. Cutting on the coarser signal produced pages that were a few
 * pixels off the editor.
 */
export function readCanvasLayoutSignature(canvas: HTMLElement | null): string {
  if (!canvas) {
    return "";
  }
  const rect = canvas.getBoundingClientRect();
  const parts: (string | number)[] = [
    canvas.dataset.pageCount ?? "",
    canvas.dataset.pageHeight ?? "",
    canvas.dataset.pageStride ?? "",
    Math.round(rect.width * 100),
    Math.round(rect.height * 100),
  ];
  for (const element of Array.from(canvas.querySelectorAll(OWNED_SELECTOR))) {
    const elementRect = element.getBoundingClientRect();
    parts.push(
      Math.round((elementRect.top - rect.top) * 100),
      Math.round((elementRect.left - rect.left) * 100),
      Math.round(elementRect.height * 100),
    );
  }

  // Deferred passes that decorate rather than move things have to be waited for too. A
  // boxed run only learns which of its ends are open after its measuring pass finishes,
  // and a clone taken before that prints a frame that is open at both ends.
  parts.push(canvas.querySelectorAll(".boxed-run-measuring").length);
  for (const element of Array.from(canvas.querySelectorAll("[data-boxed-run-height-target]"))) {
    parts.push(
      element.getAttribute("data-boxed-run-connect-left") ?? "-",
      element.getAttribute("data-boxed-run-connect-right") ?? "-",
    );
  }
  return parts.join(":");
}

function readPositiveNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
