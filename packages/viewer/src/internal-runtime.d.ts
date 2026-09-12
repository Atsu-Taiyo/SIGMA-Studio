/**
 * Build-only module boundaries. The package build aliases these module ids to
 * Sigma Studio's canonical static renderer and validator, then bundles them.
 * Keeping the declarations local prevents desktop source paths from leaking
 * into the published `.d.ts` files.
 */
declare module "@sigma-studio/viewer-internal/print-surface" {
  interface SigmaDocPrintSurfaceProps {
    document: import("./types.js").SigmaDocument;
    displayMode?: "vertical" | "spread" | "grid";
    includePrintPageStyle?: boolean;
    maxPages?: number;
    stackClassName?: string;
    renderPageFrame?: (args: {
      page: { id: string; number: number };
      totalPages: number;
      pageNode: import("react").ReactNode;
    }) => import("react").ReactNode;
  }

  export const SigmaDocPrintSurface: import("react").ComponentType<SigmaDocPrintSurfaceProps>;
}

declare module "@sigma-studio/viewer-internal/schema" {
  export function parseSigmaDocument(input: unknown): import("./types.js").SigmaDocument;
  /**
   * Read-only tolerant recovery for one overlay snapshot: drops shapes/assets
   * that fail structural validation (e.g. a callout persisted before the
   * tail-based redesign) instead of failing, mirroring what Sigma Studio's
   * own file-open path already does for the whole document.
   */
  export function recoverOverlaySnapshot(snapshot: unknown): {
    snapshot: import("./overlay-types.js").OverlaySnapshot;
    issues: ReadonlyArray<{ kind: "shape" | "asset" | "snapshot"; index?: number; key?: string; id?: string; type?: string }>;
  };
}

declare module "@sigma-studio/viewer-internal/css-safety" {
  /** No control characters, CSS escape, delimiter, or fetching/evaluating token. */
  export function isSafeCssScalar(value: unknown): value is string;
  /** A safe scalar shaped like a color: `#rgb[a]`, a keyword, or `rgb()`/`hsl()`. */
  export function isSafeCssColor(value: unknown): value is string;
  /** A safe scalar shaped like a font family list. */
  export function isSafeCssFontFamily(value: unknown): value is string;
}
