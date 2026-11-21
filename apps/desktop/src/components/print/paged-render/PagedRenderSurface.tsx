"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { EMPTY_OVERLAY_SELECTION, BASE_EDITOR_FONT_SIZE } from "@/components/editor/editor-shell/constants";
import { PageCanvasEditor } from "@/components/editor/PageCanvasEditor";
import { PrintPaperShimmer } from "@/components/print/PrintPaperShimmer";
import { useT } from "@/lib/i18n/react";
import { Button } from "@/components/ui/Button";
import {
  buildPageWindows,
  readCanvasLayoutSignature,
  readPagedCanvasMetrics,
} from "@/components/print/paged-render/page-windows";
import {
  ensurePageLayout,
  getPageMetrics,
  type SigmaDocument,
  type OutputProfileName,
} from "@/features/document";
import { getPrintableDocument } from "@/lib/print-renderer";
import { PRINT_PREPARATION_TIMEOUT_MS } from "@/lib/print-preparation";
import { useCustomFonts } from "@/lib/use-custom-fonts";
import { measurePerformance } from "@/lib/performance";

/** How often the canvas layout is sampled while waiting for it to settle. */
const SETTLE_SAMPLE_MS = 100;
/** Consecutive unchanged samples required before cutting — about half a second. */
const STABLE_SAMPLE_COUNT = 5;
/** Guards against a canvas that never converges (a relayout loop would hang the export). */
const MAX_SETTLE_SAMPLES = 150;

export type PagedRenderDisplayMode = "vertical" | "spread" | "grid";
export type PagedRenderState = "pending" | "ready" | "stalled";

export interface PagedRenderStateSnapshot {
  surfaceId: string;
  revision: number;
  pageCount: number;
  pageWidthMm: number;
  pageHeightMm: number;
  state: PagedRenderState;
}

export interface PagedRenderSurfaceProps {
  document: SigmaDocument;
  profile: OutputProfileName;
  displayMode?: PagedRenderDisplayMode;
  onRenderStateChange?: (snapshot: PagedRenderStateSnapshot) => void;
  /** Hidden layout probes need the settled canvas, without one full DOM clone per page. */
  measurementOnly?: boolean;
}

/**
 * Renders a document as paper-sized pages by cutting the editor's own page canvas
 * into page bands.
 *
 * There is deliberately no layout code here: the canvas measures and paginates
 * exactly as it does on screen, and every page window shows a clone of that settled
 * DOM at a different offset. See docs/pdf-parity-architecture.md.
 */
export function PagedRenderSurface({
  document: sourceDocument,
  profile,
  displayMode = "vertical",
  onRenderStateChange,
  measurementOnly = false,
}: PagedRenderSurfaceProps) {
  const t = useT("print");
  useCustomFonts();
  const reactSurfaceId = useId();
  const surfaceId = `pdf_surface_${reactSurfaceId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const printable = useMemo(
    () => getPrintableDocument(sourceDocument, profile, t),
    [sourceDocument, profile, t],
  );
  // The paper size the PDF is cut to comes from the document, never from a default.
  const paper = useMemo(() => {
    const metrics = getPageMetrics(ensurePageLayout(printable).pageLayout!);
    return { widthMm: metrics.page.widthMm, heightMm: metrics.page.heightMm };
  }, [printable]);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [preparationStage, setPreparationStage] = useState<"assets" | "layout" | "pages">("assets");
  const [state, setState] = useState<PagedRenderState>("pending");
  const [renderedDocument, setRenderedDocument] = useState<SigmaDocument | null>(null);
  const [retryRevision, setRetryRevision] = useState(0);
  // Bumped on every cut. A late decorating pass rebuilds the windows, so consumers that
  // must not capture a superseded surface (the PDF exporter, layout tests) wait for this
  // to stop changing rather than for `state` alone.
  const [revision, setRevision] = useState(0);

  const noop = useCallback(() => {}, []);

  useEffect(() => {
    let cancelled = false;
    const assetWaitController = new AbortController();
    let timerId = 0;
    let stableSamples = 0;
    let takenSamples = 0;
    let lastSignature = "";
    let cutSignature: string | null = null;
    let assetsReady = false;
    let terminal = false;
    let phase: "assets" | "layout" | "pages" = "assets";
    let deadline = Date.now() + PRINT_PREPARATION_TIMEOUT_MS;
    let deadlineTimer = window.setTimeout(stall, PRINT_PREPARATION_TIMEOUT_MS);

    function stall() {
      if (cancelled || terminal) return;
      terminal = true;
      assetWaitController.abort();
      window.clearTimeout(timerId);
      window.clearTimeout(deadlineTimer);
      observer?.disconnect();
      fonts?.removeEventListener?.("loading", onFontsLoading);
      setPreparationStage(phase);
      setRenderedDocument(printable);
      setState("stalled");
    }

    const markPending = () => {
      // A late decorating pass invalidates the previous OutputSession immediately.
      if (cutSignature !== null) {
        cutSignature = null;
        deadline = Date.now() + PRINT_PREPARATION_TIMEOUT_MS;
        deadlineTimer = window.setTimeout(stall, PRINT_PREPARATION_TIMEOUT_MS);
      }
      setRenderedDocument(printable);
      setState("pending");
    };

    const cut = (signature: string) => {
      const stage = stageRef.current;
      const pages = pagesRef.current;
      const canvas = stage?.querySelector<HTMLElement>(".page-canvas") ?? null;
      const stageRoot = stage?.querySelector<HTMLElement>(".page-mode") ?? null;
      const metrics = readPagedCanvasMetrics(canvas);
      if (!pages || !stageRoot || !canvas || !metrics) {
        return false;
      }
      phase = "pages";
      setPreparationStage(phase);
      const written = measurementOnly
        ? metrics.pageCount
        : measurePerformance("pdf.page-windows", () =>
          buildPageWindows({ stageRoot, canvas, container: pages, metrics }),
        );
      if (Date.now() >= deadline) {
        stall();
        return false;
      }
      window.clearTimeout(deadlineTimer);
      cutSignature = signature;
      setPageCount(written);
      setRevision((current) => current + 1);
      setRenderedDocument(printable);
      setState("ready");
      return true;
    };

    const schedule = () => {
      timerId = window.setTimeout(tick, SETTLE_SAMPLE_MS);
    };

    function tick() {
      timerId = 0;
      if (cancelled || terminal) {
        return;
      }
      if (Date.now() >= deadline) {
        stall();
        return;
      }
      // Reading layout can trigger another font load; never cut its fallback geometry.
      if (stageRef.current?.ownerDocument.fonts?.status === "loading"
        || Array.from(stageRef.current?.querySelectorAll("img") ?? []).some(image => !image.complete)) {
        awaitAssets();
        return;
      }
      takenSamples += 1;
      const canvas = stageRef.current?.querySelector<HTMLElement>(".page-canvas") ?? null;
      const signature = readCanvasLayoutSignature(canvas);
      if (signature && signature === lastSignature) {
        stableSamples += 1;
      } else {
        stableSamples = 0;
        lastSignature = signature;
      }

      if (stableSamples >= STABLE_SAMPLE_COUNT) {
        // Already cut from this exact state — stop sampling and wait for the observer.
        if (signature === cutSignature || cut(signature)) {
          return;
        }
      }
      if (takenSamples >= MAX_SETTLE_SAMPLES) {
        // A PDF advertised as identical to its preview must never be cut from a
        // non-converged layout. Fail closed and let the user retry instead.
        stall();
        return;
      }
      if (!terminal) schedule();
    }

    const startSettling = () => {
      if (cancelled || terminal || !assetsReady || timerId) {
        return;
      }
      // React also updates non-layout editor attributes after a cut. Invalidating
      // those identical canvases would cause ready/pending renders to feed each
      // other, repeatedly cloning a large document and interrupting PDF saving.
      if (cutSignature !== null
        && readCanvasLayoutSignature(stageRef.current?.querySelector(".page-canvas") ?? null) === cutSignature) {
        return;
      }
      markPending();
      phase = "layout";
      setPreparationStage(phase);
      stableSamples = 0;
      takenSamples = 0;
      lastSignature = "";
      schedule();
    };

    function awaitAssets() {
      assetsReady = false;
      markPending();
      phase = "assets";
      setPreparationStage(phase);
      // Keep this subscription alive beyond the former 15s attempt. Only the shared
      // deadline or cancellation ends it, so late fonts/images resume pagination.
      void waitForAssets(stageRef.current, assetWaitController.signal).then((result) => {
        if (cancelled || terminal || result === "cancelled") return;
        assetsReady = true;
        startSettling();
      });
    }
    awaitAssets();
    const fonts = stageRef.current?.ownerDocument.fonts;
    const onFontsLoading = () => {
      if (cancelled || terminal || !assetsReady) return;
      window.clearTimeout(timerId);
      timerId = 0;
      awaitAssets();
    };
    fonts?.addEventListener?.("loading", onFontsLoading);

    // Some passes decorate the canvas well after its geometry has stopped moving — the
    // boxed-run frame ends are computed in a late measuring pass, and a surface cut
    // before it landed printed frames that were open at both ends. Waiting longer cannot
    // fix that (the wrong value is stable until the pass runs), so the windows are
    // rebuilt whenever the staged canvas changes.
    const stage = stageRef.current;
    const observer = stage && typeof MutationObserver !== "undefined"
      ? new MutationObserver(() => startSettling())
      : null;
    observer?.observe(stage!, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });

    return () => {
      cancelled = true;
      assetWaitController.abort();
      window.clearTimeout(deadlineTimer);
      fonts?.removeEventListener?.("loading", onFontsLoading);
      observer?.disconnect();
      if (timerId) {
        window.clearTimeout(timerId);
      }
    };
  }, [printable, retryRevision, measurementOnly]);

  const displayState = renderedDocument === printable ? state : "pending";

  const retryPagination = () => {
    setPageCount(0);
    setState("pending");
    setRetryRevision((current) => current + 1);
  };

  useEffect(() => {
    onRenderStateChange?.({
      surfaceId,
      revision,
      state: displayState,
      pageCount: displayState === "ready" ? pageCount : 0,
      pageWidthMm: paper.widthMm,
      pageHeightMm: paper.heightMm,
    });
  }, [displayState, onRenderStateChange, pageCount, paper.heightMm, paper.widthMm, revision, surfaceId]);

  return (
    <div
      className={`paged-surface paged-surface--${displayMode}`}
      data-paged-surface-id={surfaceId}
      data-paged-surface-state={displayState}
      data-paged-surface-stage={renderedDocument === printable ? preparationStage : "assets"}
      data-paged-surface-page-count={displayState === "ready" ? pageCount : undefined}
      data-paged-surface-revision={revision}
      data-paged-surface-page-width-mm={paper.widthMm}
      data-paged-surface-page-height-mm={paper.heightMm}
    >
      <style>{`@media print { @page { size: ${paper.widthMm}mm ${paper.heightMm}mm; margin: 0; } }`}</style>
      {displayState === "pending" && (
        <PrintPaperShimmer
          displayMode={displayMode}
          widthMm={paper.widthMm}
          heightMm={paper.heightMm}
        />
      )}
      {displayState === "stalled" && (
        <section className="paged-surface-stalled" role="alert">
          <AlertTriangle size={24} aria-hidden="true" />
          <h2>{t("pagination.stalledTitle")}</h2>
          <p>{t("pagination.stalledBody")}</p>
          <Button tone="secondary" onClick={retryPagination}>
            <RotateCcw size={16} aria-hidden="true" />
            {t("pagination.retry")}
          </Button>
        </section>
      )}
      <div className="paged-surface-pages" ref={pagesRef} />
      {/* Rendered last so that clones resolve their own `url(#…)` references
        * before the staged copy's identical definitions. */}
      <div className="paged-surface-stage" ref={stageRef} aria-hidden="true">
        <PageCanvasEditor
          presentation="paged"
          document={printable}
          selectedId={null}
          selectedInlineMath={null}
          commentThreads={[]}
          showComments={false}
          overlaySelection={EMPTY_OVERLAY_SELECTION}
          fontSize={BASE_EDITOR_FONT_SIZE}
          zoom={100}
          historyRevision={0}
          suppressSelectionActions
          pendingDeletion={null}
          overlayCommandRequest={null}
          overlayImageRequest={null}
          overlayActionRequest={null}
          onSelect={noop}
          onChange={noop}
          onDelete={noop}
          onCopyBlock={noop}
          onDuplicate={noop}
          onMove={noop}
          onAddProblemBlock={noop}
          onReplaceTextFlow={noop}
          onPageLayoutChange={noop}
          onOverlayChange={noop}
          onOverlayImagesRequest={noop}
          onReanchorOverlay={noop}
          onOverlayCommandHandled={noop}
          onOverlayImageHandled={noop}
          onOverlayActionHandled={noop}
        />
      </div>
    </div>
  );
}

/** Fonts and images change measured heights, so pagination is only meaningful after both land. */
async function waitForAssets(
  stage: HTMLElement | null,
  signal: AbortSignal,
): Promise<"ready" | "cancelled"> {
  const ownerDocument = stage?.ownerDocument ?? (typeof document === "undefined" ? null : document);
  if (!ownerDocument) {
    return "ready";
  }

  return new Promise((resolve) => {
    if (signal.aborted) { resolve("cancelled"); return; }
    let finished = false;
    const imageCleanups: Array<() => void> = [];
    const finish = (result: "ready" | "cancelled") => {
      if (finished) {
        return;
      }
      finished = true;
      signal.removeEventListener("abort", cancel);
      imageCleanups.forEach((cleanup) => cleanup());
      resolve(result);
    };
    const cancel = () => finish("cancelled");
    signal.addEventListener("abort", cancel, { once: true });

    const fontsReady = ownerDocument.fonts?.ready
      ? Promise.resolve(ownerDocument.fonts.ready).catch(() => undefined)
      : Promise.resolve();
    const imagesReady = Promise.all(
      Array.from(stage?.querySelectorAll("img") ?? [])
        .filter((image) => !image.complete)
        .map((image) => new Promise<void>((resolveImage) => {
          const settle = () => resolveImage();
          const cleanup = () => {
            image.removeEventListener("load", settle);
            image.removeEventListener("error", settle);
          };
          imageCleanups.push(cleanup);
          image.addEventListener("load", settle, { once: true });
          image.addEventListener("error", settle, { once: true });
        })),
    );

    void Promise.all([fontsReady, imagesReady]).then(() => finish("ready"));
  });
}
