/** Controls whether inline fractions keep TeX sizing or use display-style fractions. */
export type MathFractionSizing = "uniform" | "texDefault";

export type HeadingNumberingStyle = "decimal" | "sectionSign" | "chapterJa";

export interface HeadingNumberingConfig {
  enabled: boolean;
  style?: HeadingNumberingStyle;
  depth?: 1 | 2 | 3;
}

export interface SigmaMetadata {
  title: string;
  source?: SigmaDocumentSourceMetadata;
  styleUnits?: SigmaDocumentStyleUnits;
  mathFractionSizing?: MathFractionSizing;
  /** Display-only hierarchical numbering derived from document-order headings. */
  headingNumbering?: HeadingNumberingConfig;
  /** File-scoped TeX macro declarations used by MathLive, KaTeX, and print output. */
  texPreamble?: string;
}

export interface SigmaDocumentSourceMetadata {
  /** Descriptive provenance supplied by an external authoring tool. */
  format?: string;
  layoutMode?: "fixedOverlay";
  printFlowContent?: boolean;
  /** Import provenance. Descriptive only - never an input to layout or rendering. */
  originalFileName?: string;
  importedAt?: string;
  slideCount?: number;
  pageSize?: {
    widthPx?: number;
    heightPx?: number;
    widthMm?: number;
    heightMm?: number;
  };
}

export interface SigmaDocumentStyleUnits {
  fontSize?: "pt";
}
