import {
  Component,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type ReactNode,
} from "react";

import { SigmaDocPrintSurface } from "@sigma-studio/viewer-internal/print-surface";
import {
  parseSigmaDocument as parseInternalSigmaDocument,
  recoverOverlaySnapshot,
} from "@sigma-studio/viewer-internal/schema";

import type { OverlayAsset, OverlayShape, OverlaySnapshot } from "./overlay-types.js";
import type {
  AnswerDefinition,
  BoxBlockChildBlock,
  LayoutSectionChildBlock,
  PageOverlay,
  PageLayout,
  ProblemAreaBlock,
  ProblemAreaKind,
  ProblemNode,
  SigmaBlock,
  SigmaDocument,
} from "./types.js";
import { assertViewerSafeDocument, validateImageDataUrl } from "./viewer-safety.js";

const CSS_PX_PER_MM = 96 / 25.4;
const VIEWER_PARTS = ["problem", "solution", "comments"] as const;

export type SigmaDocViewerPart = (typeof VIEWER_PARTS)[number];

export interface SigmaDocViewerProps {
  document: SigmaDocument;
  visibleParts?: readonly SigmaDocViewerPart[];
  hideProblemNumbers?: boolean;
  maxHeightPx?: number;
  className?: string;
  style?: CSSProperties;
  onError?: (error: SigmaDocViewerError) => void;
}

export type SigmaDocViewerError =
  | {
      code: "invalid-document";
      message: string;
      issues: readonly string[];
    }
  | {
      code: "unsupported-asset";
      message: string;
      assetId: string;
    }
  | {
      code: "render-failed";
      message: string;
    };

export class SigmaDocParseError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[], options?: { cause?: unknown }) {
    super("SigmaDocを読み込めませんでした。");
    this.name = "SigmaDocParseError";
    this.issues = issues;
    if (options && "cause" in options) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        value: options.cause,
      });
    }
  }
}

/**
 * Validate and normalize an unknown value as the canonical SigmaDoc v2 model.
 * The implementation is shared with Sigma Studio so migrations and defaults do
 * not drift between the authoring app and the viewer.
 */
export function parseSigmaDocument(input: unknown): SigmaDocument {
  try {
    // Overlay shapes/assets that fail structural validation (e.g. a callout
    // persisted before the tail-based redesign) are dropped up front instead
    // of failing the whole document, exactly like Sigma Studio's own
    // file-open path already does. Everything else in the document still
    // goes through the normal strict schema below.
    const recoveredInput = recoverOverlaySnapshotsBeforeParse(input);
    const document = parseInternalSigmaDocument(recoveredInput) as unknown as SigmaDocument;
    assertViewerSafeDocument(document);
    return document;
  } catch (cause) {
    throw new SigmaDocParseError(getParseIssues(cause), { cause });
  }
}

/**
 * Recovers each `pageLayout.{overlay,header.overlay,footer.overlay}.overlaySnapshot`
 * independently before the strict schema runs, so one shape/asset in an
 * obsolete format can't reject an otherwise-valid document.
 */
function recoverOverlaySnapshotsBeforeParse(input: unknown): unknown {
  if (!isPlainObject(input) || !isPlainObject(input.pageLayout)) {
    return input;
  }

  const pageLayout = input.pageLayout;
  let layoutChanged = false;
  const nextLayout: Record<string, unknown> = { ...pageLayout };

  const overlayResult = recoverOverlayField(pageLayout.overlay);
  if (overlayResult.changed) {
    nextLayout.overlay = overlayResult.value;
    layoutChanged = true;
  }

  for (const region of ["header", "footer"] as const) {
    if (!isPlainObject(pageLayout[region])) {
      continue;
    }
    const regionValue = pageLayout[region];
    const regionOverlayResult = recoverOverlayField(regionValue.overlay);
    if (regionOverlayResult.changed) {
      nextLayout[region] = { ...regionValue, overlay: regionOverlayResult.value };
      layoutChanged = true;
    }
  }

  if (!layoutChanged) {
    return input;
  }
  return { ...input, pageLayout: nextLayout };
}

function recoverOverlayField(overlay: unknown): { value: unknown; changed: boolean } {
  if (!isPlainObject(overlay) || overlay.overlaySnapshot === undefined) {
    return { value: overlay, changed: false };
  }
  const recovered = recoverOverlaySnapshot(overlay.overlaySnapshot);
  if (recovered.issues.length === 0) {
    return { value: overlay, changed: false };
  }
  return { value: { ...overlay, overlaySnapshot: recovered.snapshot }, changed: true };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function SigmaDocViewer({
  document,
  visibleParts,
  hideProblemNumbers = false,
  maxHeightPx,
  className,
  style,
  onError,
}: SigmaDocViewerProps) {
  const [hydrated, setHydrated] = useState(false);
  const [fontRevision, setFontRevision] = useState(0);
  const normalizedVisibleParts = useMemo(() => normalizeVisibleParts(visibleParts), [visibleParts]);
  const prepared = useMemo(
    () => prepareViewerDocument(document, normalizedVisibleParts, hideProblemNumbers),
    [document, normalizedVisibleParts, hideProblemNumbers],
  );

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated || prepared.kind !== "ready" || !onError) {
      return;
    }

    for (const error of prepared.errors) {
      safelyReportError(onError, error);
    }
  }, [hydrated, onError, prepared]);

  useEffect(() => {
    if (!hydrated || typeof globalThis.document === "undefined") {
      return;
    }

    const fonts = globalThis.document.fonts;
    if (!fonts) {
      return;
    }

    let cancelled = false;
    void fonts.ready.then(() => {
      if (!cancelled) {
        setFontRevision((revision) => revision + 1);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [hydrated, prepared.key]);

  const rootClassName = ["sigma-viewer", className].filter(Boolean).join(" ");

  if (!hydrated) {
    return (
      <section
        className={rootClassName}
        data-sigma-viewer="true"
        data-sigma-viewer-state="loading"
        aria-busy="true"
        style={style}
      >
        <span className="sigma-viewer__status">文書を準備しています。</span>
      </section>
    );
  }

  if (prepared.kind === "error") {
    if (onError) {
      // Invalid input is known before any render work. Reporting in an effect
      // would require conditionally calling a hook, so use a child reporter.
      return (
        <section
          className={rootClassName}
          data-sigma-viewer="true"
          data-sigma-viewer-state="error"
          style={style}
        >
          <ErrorReporter callback={onError} error={prepared.error} />
          <ViewerErrorMessage message={prepared.error.message} />
        </section>
      );
    }

    return (
      <section
        className={rootClassName}
        data-sigma-viewer="true"
        data-sigma-viewer-state="error"
        style={style}
      >
        <ViewerErrorMessage message={prepared.error.message} />
      </section>
    );
  }

  const pageWidthPx = prepared.document.pageLayout!.pageSize.widthMm * CSS_PX_PER_MM;
  const pageHeightPx = prepared.document.pageLayout!.pageSize.heightMm * CSS_PX_PER_MM;
  const renderKey = `${prepared.key}:${fontRevision}`;

  return (
    <section
      className={rootClassName}
      data-sigma-viewer="true"
      data-sigma-viewer-state="ready"
      style={style}
    >
      <ViewerHeightLimit maxHeightPx={maxHeightPx} resetKey={renderKey}>
        <ViewerRenderBoundary key={renderKey} onError={onError}>
          <SigmaDocPrintSurface
            document={prepared.document}
            displayMode="vertical"
            includePrintPageStyle={false}
            stackClassName="sigma-viewer__pages"
            renderPageFrame={({ page, pageNode }) => (
              <ResponsivePageFrame
                key={page.id}
                pageNumber={page.number}
                pageWidthPx={pageWidthPx}
                pageHeightPx={pageHeightPx}
              >
                {pageNode}
              </ResponsivePageFrame>
            )}
          />
          {prepared.placeholderAssetIds.map((assetId) => (
            <span
              key={assetId}
              className="sigma-viewer__asset-placeholder-marker"
              data-sigma-viewer-asset-placeholder={assetId}
              aria-hidden="true"
            />
          ))}
        </ViewerRenderBoundary>
      </ViewerHeightLimit>
    </section>
  );
}

function ViewerHeightLimit({
  maxHeightPx,
  resetKey,
  children,
}: {
  maxHeightPx?: number;
  resetKey: string;
  children: ReactNode;
}) {
  const contentId = useId();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const resolvedMaxHeight = positiveFiniteNumber(maxHeightPx);

  useLayoutEffect(() => {
    setExpanded(false);
  }, [resetKey, resolvedMaxHeight]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || resolvedMaxHeight === undefined) {
      setOverflows(false);
      return;
    }

    const measureOverflow = () => {
      setOverflows(content.scrollHeight > resolvedMaxHeight + 0.5);
    };

    measureOverflow();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(measureOverflow);
      observer.observe(content);
      return () => observer.disconnect();
    }

    globalThis.addEventListener?.("resize", measureOverflow);
    return () => globalThis.removeEventListener?.("resize", measureOverflow);
  }, [resetKey, resolvedMaxHeight]);

  const constrained = resolvedMaxHeight !== undefined && !expanded;
  return (
    <div
      className={`sigma-viewer__viewport ${constrained ? "is-constrained" : ""}`}
      data-sigma-viewer-height-limited={constrained ? "true" : "false"}
      data-sigma-viewer-overflow={overflows ? "true" : "false"}
      style={constrained ? { maxHeight: `${resolvedMaxHeight}px` } : undefined}
    >
      <div className="sigma-viewer__viewport-content" id={contentId} ref={contentRef}>
        {children}
      </div>
      {constrained && overflows ? (
        <div className="sigma-viewer__overflow-control">
          <button
            type="button"
            className="sigma-viewer__expand-button"
            aria-controls={contentId}
            aria-expanded="false"
            onClick={() => setExpanded(true)}
          >
            すべて表示
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ErrorReporter({ callback, error }: { callback: (error: SigmaDocViewerError) => void; error: SigmaDocViewerError }) {
  useEffect(() => {
    safelyReportError(callback, error);
  }, [callback, error]);
  return null;
}

function ViewerErrorMessage({ message }: { message: string }) {
  return (
    <div className="sigma-viewer__error" role="alert">
      {message}
    </div>
  );
}

interface ViewerRenderBoundaryProps {
  children: ReactNode;
  onError?: (error: SigmaDocViewerError) => void;
}

interface ViewerRenderBoundaryState {
  error: SigmaDocViewerError | null;
}

class ViewerRenderBoundary extends Component<ViewerRenderBoundaryProps, ViewerRenderBoundaryState> {
  state: ViewerRenderBoundaryState = { error: null };

  static getDerivedStateFromError(cause: unknown): ViewerRenderBoundaryState {
    return {
      error: {
        code: "render-failed",
        message: cause instanceof Error && cause.message
          ? `SigmaDocの描画に失敗しました: ${cause.message}`
          : "SigmaDocの描画に失敗しました。",
      },
    };
  }

  componentDidCatch(_cause: unknown, _info: ErrorInfo) {
    if (this.state.error && this.props.onError) {
      safelyReportError(this.props.onError, this.state.error);
    }
  }

  render() {
    if (this.state.error) {
      return <ViewerErrorMessage message={this.state.error.message} />;
    }
    return this.props.children;
  }
}

function ResponsivePageFrame({
  pageNumber,
  pageWidthPx,
  pageHeightPx,
  children,
}: {
  pageNumber: number;
  pageWidthPx: number;
  pageHeightPx: number;
  children: ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame || !(pageWidthPx > 0)) {
      return;
    }

    const updateScale = () => {
      const availableWidth = frame.getBoundingClientRect().width;
      if (!(availableWidth > 0)) {
        return;
      }
      const widthRatio = availableWidth / pageWidthPx;
      const nextScale = widthRatio >= 0.999 ? 1 : Math.min(1, widthRatio);
      setScale((current) => Math.abs(current - nextScale) < 0.001 ? current : nextScale);
    };

    updateScale();
    if (typeof ResizeObserver === "undefined") {
      globalThis.addEventListener?.("resize", updateScale);
      return () => globalThis.removeEventListener?.("resize", updateScale);
    }

    const observer = new ResizeObserver(updateScale);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [pageWidthPx]);

  return (
    <div
      ref={frameRef}
      className="sigma-viewer__page"
      data-sigma-viewer-page={pageNumber}
      style={{
        width: "100%",
        maxWidth: `${pageWidthPx}px`,
        height: `${pageHeightPx * scale}px`,
      }}
    >
      <div
        className="sigma-viewer__page-scaler"
        style={{
          width: `${pageWidthPx}px`,
          height: `${pageHeightPx}px`,
          transform: `scale(${scale})`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

type PreparedViewerDocument =
  | {
      kind: "ready";
      document: SigmaDocument;
      errors: SigmaDocViewerError[];
      placeholderAssetIds: string[];
      key: string;
    }
  | {
      kind: "error";
      error: Extract<SigmaDocViewerError, { code: "invalid-document" }>;
      key: string;
    };

function prepareViewerDocument(
  input: unknown,
  visibleParts: readonly SigmaDocViewerPart[] | undefined,
  hideProblemNumbers: boolean,
): PreparedViewerDocument {
  let parsed: SigmaDocument;
  try {
    parsed = parseSigmaDocument(input);
  } catch (cause) {
    const issues = cause instanceof SigmaDocParseError ? cause.issues : getParseIssues(cause);
    return {
      kind: "error",
      error: {
        code: "invalid-document",
        message: "SigmaDocを読み込めませんでした。",
        issues,
      },
      key: `invalid:${stableHash(issues.join("\n"))}`,
    };
  }

  const projectedDocument = visibleParts === undefined
    ? projectFullViewerContent(parsed, hideProblemNumbers)
    : projectPartialViewerContent(parsed, visibleParts, hideProblemNumbers);
  const sanitized = sanitizeDocumentAssets(projectedDocument);
  return {
    kind: "ready",
    document: sanitized.document,
    errors: sanitized.errors,
    placeholderAssetIds: sanitized.placeholderAssetIds,
    key: stableHash(JSON.stringify(sanitized.document)),
  };
}

/**
 * The viewer intentionally ignores outputProfiles. It always exposes all
 * pedagogical material and never exposes authoring comments.
 */
function projectFullViewerContent(document: SigmaDocument, hideProblemNumbers: boolean): SigmaDocument {
  return {
    ...document,
    comments: undefined,
    content: document.content.map((block) => projectFullViewerBlock(block, hideProblemNumbers)),
  };
}

function projectFullViewerBlock(block: SigmaBlock, hideProblemNumbers: boolean): SigmaBlock {
  if (block.type !== "problem") {
    return block;
  }

  const numbering = hideProblemNumbers ? { ...block.numbering, enabled: false } : block.numbering;
  if (!block.answer) {
    return numbering === block.numbering ? block : { ...block, numbering };
  }

  return {
    ...block,
    numbering,
    prompt: [...block.prompt, createViewerAnswerBlock(block.id, block.answer)],
  };
}

function projectPartialViewerContent(
  document: SigmaDocument,
  visibleParts: readonly SigmaDocViewerPart[],
  hideProblemNumbers: boolean,
): SigmaDocument {
  const selected = new Set(visibleParts);
  const problems = document.content.filter((block): block is ProblemNode => block.type === "problem");
  const content = problems.map((problem) => projectPartialViewerProblem(problem, selected, hideProblemNumbers));
  const visibleBlockIds = collectVisibleProblemBlockIds(content);

  return {
    ...document,
    comments: undefined,
    content,
    pageLayout: projectPartialPageLayout(document.pageLayout, visibleBlockIds),
  };
}

function projectPartialViewerProblem(
  problem: ProblemNode,
  selected: ReadonlySet<SigmaDocViewerPart>,
  hideProblemNumbers: boolean,
): ProblemNode {
  const showProblem = selected.has("problem");
  const showSolution = selected.has("solution");
  const showComments = selected.has("comments");
  const visibleAreas = new Set<ProblemAreaKind>([
    ...(showProblem ? (["lead", "prompt"] as const) : []),
    ...(showSolution ? (["solution"] as const) : []),
    ...(showComments ? (["hints"] as const) : []),
  ]);
  const areaLayoutEntries = Object.entries(problem.areaLayout ?? {}).filter(([area]) => (
    visibleAreas.has(area as ProblemAreaKind)
  ));

  return {
    ...problem,
    lead: showProblem ? problem.lead : [],
    prompt: showProblem ? problem.prompt : [],
    answer: undefined,
    solution: showSolution ? problem.solution : [],
    hints: showComments ? problem.hints : [],
    areaLayout: areaLayoutEntries.length > 0
      ? Object.fromEntries(areaLayoutEntries) as ProblemNode["areaLayout"]
      : undefined,
    numbering: hideProblemNumbers || !showProblem
      ? { ...problem.numbering, enabled: false }
      : problem.numbering,
  };
}

function collectVisibleProblemBlockIds(problems: readonly ProblemNode[]): Set<string> {
  const ids = new Set<string>();
  const visitBlock = (block: ProblemAreaBlock | LayoutSectionChildBlock | BoxBlockChildBlock) => {
    ids.add(block.id);
    if (block.type === "layoutSection") {
      block.children.forEach(visitBlock);
    } else if (block.type === "boxBlock") {
      block.blocks.forEach(visitBlock);
    } else if (block.type === "list") {
      for (const item of block.items) {
        ids.add(item.id);
        item.nested?.forEach(visitBlock);
      }
    }
  };

  for (const problem of problems) {
    ids.add(problem.id);
    problem.lead.forEach(visitBlock);
    problem.prompt.forEach(visitBlock);
    problem.solution.forEach(visitBlock);
    problem.hints.forEach(visitBlock);
  }
  return ids;
}

function projectPartialPageLayout(pageLayout: PageLayout | undefined, visibleBlockIds: Set<string>): PageLayout | undefined {
  if (!pageLayout) {
    return pageLayout;
  }

  const snapshot = pageLayout.overlay?.overlaySnapshot;
  return {
    ...pageLayout,
    header: undefined,
    footer: undefined,
    overlay: snapshot
      ? {
          ...pageLayout.overlay,
          overlaySnapshot: {
            ...snapshot,
            shapes: filterPartialOverlayShapes(snapshot.shapes, visibleBlockIds),
          },
        }
      : undefined,
  };
}

function filterPartialOverlayShapes(shapes: readonly OverlayShape[], visibleBlockIds: Set<string>): OverlayShape[] {
  const shapeById = new Map(shapes.map((shape) => [shape.id, shape]));
  const visibilityCache = new Map<string, boolean>();

  const isVisible = (shape: OverlayShape, visiting = new Set<string>()): boolean => {
    const cached = visibilityCache.get(shape.id);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(shape.id)) {
      visibilityCache.set(shape.id, false);
      return false;
    }

    visiting.add(shape.id);
    let visible = false;
    if (shape.anchor?.type === "block") {
      visible = visibleBlockIds.has(shape.anchor.blockId);
    } else if (shape.anchor?.type === "shape") {
      const anchorShape = shapeById.get(shape.anchor.shapeId);
      visible = anchorShape ? isVisible(anchorShape, visiting) : false;
    } else if (shape.parentId) {
      const parentShape = shapeById.get(shape.parentId);
      visible = parentShape ? isVisible(parentShape, visiting) : false;
    }

    visiting.delete(shape.id);
    visibilityCache.set(shape.id, visible);
    return visible;
  };

  const visibleShapeIds = new Set(shapes.filter((shape) => isVisible(shape)).map((shape) => shape.id));
  const includeParentChain = (shape: OverlayShape, visiting = new Set<string>()) => {
    if (!shape.parentId || visiting.has(shape.id)) {
      return;
    }
    const parent = shapeById.get(shape.parentId);
    if (!parent) {
      return;
    }
    visiting.add(shape.id);
    visibleShapeIds.add(parent.id);
    includeParentChain(parent, visiting);
  };
  for (const shape of shapes) {
    if (visibleShapeIds.has(shape.id)) {
      includeParentChain(shape);
    }
  }

  return shapes.filter((shape) => visibleShapeIds.has(shape.id));
}

function createViewerAnswerBlock(problemId: string, answer: AnswerDefinition): ProblemAreaBlock {
  return {
    type: "paragraph",
    id: `${problemId}__viewer_answer`,
    children: answer.type === "math"
      ? [
          { type: "text", text: "答　", marks: ["bold"] },
          {
            type: "mathInline",
            id: `${problemId}__viewer_answer_math`,
            tex: answer.expected,
            display: "inline",
            semanticRole: "expression",
          },
        ]
      : [
          { type: "text", text: "答　", marks: ["bold"] },
          { type: "text", text: answer.expected },
        ],
  };
}

function sanitizeDocumentAssets(document: SigmaDocument): {
  document: SigmaDocument;
  errors: SigmaDocViewerError[];
  placeholderAssetIds: string[];
} {
  const errors: SigmaDocViewerError[] = [];
  const placeholderAssetIds = new Set<string>();
  const seenErrors = new Set<string>();

  const sanitizeOverlay = (overlay: PageOverlay | undefined): PageOverlay | undefined => {
    if (!overlay?.overlaySnapshot) {
      return overlay;
    }

    const snapshot = sanitizeOverlaySnapshot(
      overlay.overlaySnapshot,
      errors,
      placeholderAssetIds,
      seenErrors,
    );
    return {
      ...overlay,
      overlaySnapshot: snapshot,
    };
  };

  const layout = document.pageLayout!;
  return {
    document: {
      ...document,
      pageLayout: {
        ...layout,
        overlay: sanitizeOverlay(layout.overlay),
        header: layout.header
          ? { ...layout.header, overlay: sanitizeOverlay(layout.header.overlay) }
          : undefined,
        footer: layout.footer
          ? { ...layout.footer, overlay: sanitizeOverlay(layout.footer.overlay) }
          : undefined,
      },
    },
    errors,
    placeholderAssetIds: [...placeholderAssetIds],
  };
}

function sanitizeOverlaySnapshot(
  snapshot: OverlaySnapshot,
  errors: SigmaDocViewerError[],
  placeholderAssetIds: Set<string>,
  seenErrors: Set<string>,
): OverlaySnapshot {
  const assets = { ...snapshot.assets };

  for (const shape of snapshot.shapes) {
    const referencedAsset = shape.type === "image"
      ? { id: shape.props.assetId, width: shape.props.w, height: shape.props.h }
      : shape.type === "graph3dShape" && shape.props.previewAssetId
        ? { id: shape.props.previewAssetId, width: shape.props.w, height: shape.props.h }
        : null;
    if (!referencedAsset) {
      continue;
    }

    const assetId = referencedAsset.id;
    const asset = assets[assetId];
    const validation = asset ? validateImageDataUrl(asset.props.src) : null;
    if (asset && validation?.ok) {
      const { storage: _storage, ...props } = asset.props;
      assets[assetId] = {
        ...asset,
        props: {
          ...props,
          src: validation.value.src,
          mimeType: validation.value.mimeType,
        },
      };
      continue;
    }

    placeholderAssetIds.add(assetId);
    const reason = !asset
      ? "画像アセットが見つかりません。"
      : validation && !validation.ok
        ? validation.reason
        : "画像はPNG・JPEG・WebP・SVGのdata URLのみ表示できます。";
    reportUnsupportedAsset(assetId, reason, errors, seenErrors);
    assets[assetId] = createPlaceholderAsset(
      assetId,
      asset,
      referencedAsset.width,
      referencedAsset.height,
    );
  }

  return {
    ...snapshot,
    assets,
  };
}

function createPlaceholderAsset(
  assetId: string,
  original: OverlayAsset | undefined,
  fallbackWidth: number,
  fallbackHeight: number,
): OverlayAsset {
  const width = positiveNumber(original?.props.w, fallbackWidth);
  const height = positiveNumber(original?.props.h, fallbackHeight);
  return {
    id: assetId,
    type: "image",
    props: {
      w: width,
      h: height,
      name: original?.props.name || "unsupported-image",
      isAnimated: false,
      mimeType: "image/svg+xml",
      src: createPlaceholderDataUrl(assetId, width, height),
      fileSize: 0,
    },
  };
}

function createPlaceholderDataUrl(assetId: string, width: number, height: number): string {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const label = escapeXml(assetId.length > 28 ? `${assetId.slice(0, 25)}…` : assetId);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${safeWidth}" height="${safeHeight}" viewBox="0 0 ${safeWidth} ${safeHeight}">`,
    `<rect width="100%" height="100%" fill="#f8fafc"/>`,
    `<path d="M0 0L${safeWidth} ${safeHeight}M${safeWidth} 0L0 ${safeHeight}" stroke="#cbd5e1" stroke-width="2"/>`,
    `<rect x="1" y="1" width="${Math.max(0, safeWidth - 2)}" height="${Math.max(0, safeHeight - 2)}" fill="none" stroke="#94a3b8"/>`,
    `<text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle" fill="#475569" font-family="sans-serif" font-size="12">${label}</text>`,
    "</svg>",
  ].join("");
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function reportUnsupportedAsset(
  assetId: string,
  message: string,
  errors: SigmaDocViewerError[],
  seenErrors: Set<string>,
) {
  if (seenErrors.has(assetId)) {
    return;
  }
  seenErrors.add(assetId);
  errors.push({ code: "unsupported-asset", assetId, message: `${message} (${assetId})` });
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : Math.max(1, fallback);
}

function getParseIssues(cause: unknown): string[] {
  if (cause && typeof cause === "object" && "issues" in cause && Array.isArray(cause.issues)) {
    const issues = cause.issues.map((issue) => {
      if (issue && typeof issue === "object" && "message" in issue) {
        const path = "path" in issue && Array.isArray(issue.path) && issue.path.length
          ? `${issue.path.join(".")}: `
          : "";
        return `${path}${String(issue.message)}`;
      }
      return String(issue);
    });
    if (issues.length) {
      return issues;
    }
  }

  return [cause instanceof Error && cause.message ? cause.message : "不正なSigmaDocです。"];
}

function safelyReportError(callback: (error: SigmaDocViewerError) => void, error: SigmaDocViewerError) {
  try {
    callback(error);
  } catch {
    // A host callback must not make a read-only document disappear.
  }
}

function normalizeVisibleParts(parts: readonly SigmaDocViewerPart[] | undefined): SigmaDocViewerPart[] | undefined {
  if (parts === undefined) {
    return undefined;
  }
  const selected = new Set(parts);
  return VIEWER_PARTS.filter((part) => selected.has(part));
}

function positiveFiniteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
