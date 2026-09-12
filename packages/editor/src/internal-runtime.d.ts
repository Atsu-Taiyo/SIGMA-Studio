/**
 * Build-only boundary for the canonical Sigma Studio desktop editor.
 * The editor build aliases this module id to the real EditorShell implementation
 * and bundles it, while public declarations stay independent of repository paths.
 */
declare module "@sigma-studio/editor-internal/editor-shell" {
  interface EmbeddedEditorHost {
    document: import("@sigma-studio/viewer").SigmaDocument;
    onChange: (document: import("@sigma-studio/viewer").SigmaDocument) => void;
    onSave?: (
      document: import("@sigma-studio/viewer").SigmaDocument,
    ) => void | Promise<void>;
  }

  interface EditorShellProps {
    embeddedHost: EmbeddedEditorHost;
  }

  export const EditorShell: import("react").ComponentType<EditorShellProps>;
}

declare module "@sigma-studio/editor-internal/page-canvas-editor" {
  export const PageCanvasEditor: import("react").ComponentType<Record<string, unknown>>;
}

/**
 * Build-only boundary for the desktop i18n runtime. Declared (rather than
 * imported through the `@/` alias) so the published declarations never leak a
 * repository-internal path.
 */
declare module "@sigma-studio/editor-internal/i18n" {
  export function setAppLocale(locale: "ja" | "en"): void;
  export function getAppLocale(): "ja" | "en";
}

declare module "@sigma-studio/editor-internal/tex-import" {
  export function importTexDocument(input: string, filename?: string): import("@sigma-studio/viewer").SigmaDocument;
  export function importTexProblem(input: import("./tex-import.js").TexProblemInput): import("@sigma-studio/viewer").SigmaDocument;
}
