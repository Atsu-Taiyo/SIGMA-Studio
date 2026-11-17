/** Evaluated in the preview renderer; tests execute this exact function too. */
export function printPreviewReadyScript(options: {
  timeoutMs: number;
  requirePageWindows: boolean;
  documentLoadFailed: string;
  preparationTimedOut: string;
}): string {
  return `(${waitForPreview.toString()})(${JSON.stringify(options)})`;
}

function waitForPreview(options: {
  timeoutMs: number;
  requirePageWindows: boolean;
  documentLoadFailed: string;
  preparationTimedOut: string;
}) {
  return new Promise((resolve, reject) => {
    let lastSignature = "";
    let stableFrames = 0;
    let finished = false;
    let frame = 0;
    const cleanup = () => {
      finished = true;
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
    };
    const fail = (error: Error) => {
      if (finished) return;
      cleanup();
      reject(error);
    };
    // Independent of rAF and asset promises, including while a hidden renderer is idle.
    const timer = window.setTimeout(() => {
      const stage = document.querySelector(".paged-surface")?.getAttribute("data-paged-surface-stage") ?? "load";
      fail(new Error(options.preparationTimedOut + " (stage: " + stage + ")"));
    }, options.timeoutMs);

    const tick = () => {
      if (finished) return;
      const errorElement = document.querySelector('[data-print-load-state="error"]');
      if (errorElement) {
        fail(new Error(errorElement.textContent?.trim() || options.documentLoadFailed));
        return;
      }
      const stack = document.querySelector<HTMLElement>(".paged-surface");
      const state = stack?.getAttribute("data-paged-surface-state");
      if (state === "stalled") {
        const stage = stack?.getAttribute("data-paged-surface-stage") ?? "layout";
        fail(new Error(options.preparationTimedOut + " (stage: " + stage + "; stalled)"));
        return;
      }
      const renderedPageCount = document.querySelectorAll(".paged-surface-page").length;
      const pageCount = Number(stack?.getAttribute("data-paged-surface-page-count") ?? "0");
      // Never accept stale windows from a previous ready revision, or a newly loading font.
      const assetsReady = document.fonts?.status !== "loading"
        && Array.from(document.querySelectorAll("img")).every(image => image.complete);
      if (stack && state === "ready" && assetsReady && pageCount > 0
        && (!options.requirePageWindows || renderedPageCount === pageCount)) {
        const signature = [pageCount, renderedPageCount,
          stack.getAttribute("data-paged-surface-revision"),
          stack.scrollWidth, stack.scrollHeight, document.body.scrollHeight].join(":");
        stableFrames = signature === lastSignature ? stableFrames + 1 : 0;
        lastSignature = signature;
        if (stableFrames >= 8) {
          cleanup();
          resolve({ pageCount, renderedPageCount,
            pageWidthMm: Number(stack.getAttribute("data-paged-surface-page-width-mm") ?? "0"),
            pageHeightMm: Number(stack.getAttribute("data-paged-surface-page-height-mm") ?? "0"),
          });
          return;
        }
      } else {
        stableFrames = 0;
        lastSignature = "";
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
  });
}
