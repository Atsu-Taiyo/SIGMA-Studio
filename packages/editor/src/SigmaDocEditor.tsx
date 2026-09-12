import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { EditorShell } from "@sigma-studio/editor-internal/editor-shell";
import { setAppLocale } from "@sigma-studio/editor-internal/i18n";
import type { SigmaDocument } from "@sigma-studio/viewer";

import { warmEmbeddedEditorFonts } from "./embedded-font-warmup.js";

export interface SigmaDocEditorChange {
  document: SigmaDocument;
  path: "$";
  source: "desktop-editor" | "reset";
}

export type SigmaDocEditorSaveState = "idle" | "saving" | "saved" | "error";

export interface SigmaDocEditorHandle {
  getDocument: () => SigmaDocument;
  reset: (document?: SigmaDocument) => void;
  focus: () => void;
}

export interface SigmaDocEditorProps {
  document: SigmaDocument;
  onChange: (document: SigmaDocument, change: SigmaDocEditorChange) => void;
  onSave?: (document: SigmaDocument) => void | Promise<void>;
  className?: string;
  style?: CSSProperties;
  editorRef?: { current: SigmaDocEditorHandle | null };
  /**
   * UI 表示言語。
   *
   * 省略時は「以前この端末で選ばれた言語 → ブラウザ / OS ロケール → 日本語」の順で
   * 決まる。一度渡した `locale` はホストページの `localStorage`
   * (`sigma-studio:ui-locale`) に残るため、後から prop を外しても直前の言語のままになる。
   *
   * ホストページの `<html lang>` は変更しない。ページ全体の言語指定はホストのもの
   * なので、読み上げ等を合わせたい場合はホスト側で設定すること。
   *
   * ロケールはモジュールグローバルなので、1 ページに 2 つの `SigmaDocEditor` を
   * 別々の言語で置くことはできない。
   */
  locale?: "ja" | "en";
}

type EmbeddedLoadPhase = "loading" | "leaving" | "ready";

/** Must match the `.sigma-studio-editor-loading-cover` opacity transition in styles.css. */
const LOAD_COVER_FADE_MS = 220;

/**
 * Covers the editor until math/body fonts are warmed, so the first paint the
 * host sees is already laid out correctly instead of blank-math-then-snap
 * (see embedded-font-warmup.ts). There's no APP_READY_EVENT-style signal to
 * wait on here: EditorShell's `workspaceReady` is `true` from the very first
 * embedded render (no workspace/file loading to wait for), so that event
 * fires immediately and can't tell us anything. Font-load completion plus a
 * couple of rAF ticks (for the now-correct layout to actually paint) is the
 * signal that matters instead.
 */
function useEmbeddedLoadPhase(): EmbeddedLoadPhase {
  const [phase, setPhase] = useState<EmbeddedLoadPhase>("loading");

  useEffect(() => {
    let cancelled = false;
    let fadeTimeoutId = 0;

    warmEmbeddedEditorFonts().then(() => {
      if (cancelled) {
        return;
      }
      requestAnimationFrame(() => {
        if (cancelled) {
          return;
        }
        requestAnimationFrame(() => {
          if (cancelled) {
            return;
          }
          setPhase("leaving");
          fadeTimeoutId = window.setTimeout(() => {
            if (!cancelled) {
              setPhase("ready");
            }
          }, LOAD_COVER_FADE_MS);
        });
      });
    });

    return () => {
      cancelled = true;
      window.clearTimeout(fadeTimeoutId);
    };
  }, []);

  return phase;
}

/**
 * Sigma Studio desktop の EditorShell をそのまま組み込み、SigmaDoc の
 * 入出力だけをホストへ委譲する薄いアダプター。
 */
export function SigmaDocEditor({
  document,
  onChange,
  onSave,
  className,
  style,
  editorRef,
  locale,
}: SigmaDocEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const initialDocumentRef = useRef(document);
  const latestDocumentRef = useRef(document);
  const loadPhase = useEmbeddedLoadPhase();

  useEffect(() => {
    latestDocumentRef.current = document;
  }, [document]);

  useEffect(() => {
    // 未指定ならエディタ内部の検出・永続化に任せる (ホストの既定を上書きしない)。
    if (locale) {
      setAppLocale(locale);
    }
  }, [locale]);

  useEffect(() => {
    if (!editorRef) {
      return;
    }
    editorRef.current = {
      getDocument: () => latestDocumentRef.current,
      reset: (nextDocument = initialDocumentRef.current) => {
        latestDocumentRef.current = nextDocument;
        onChange(nextDocument, {
          document: nextDocument,
          path: "$",
          source: "reset",
        });
      },
      focus: () => {
        hostRef.current
          ?.querySelector<HTMLElement>("input, textarea, button, select, [contenteditable='true']")
          ?.focus();
      },
    };
    return () => {
      editorRef.current = null;
    };
  }, [editorRef, onChange]);

  return (
    <div
      ref={hostRef}
      className={["sigma-studio-editor-host", className].filter(Boolean).join(" ")}
      style={style}
    >
      <EditorShell
        embeddedHost={{
          document,
          onChange: (nextDocument) => {
            latestDocumentRef.current = nextDocument;
            onChange(nextDocument, {
              document: nextDocument,
              path: "$",
              source: "desktop-editor",
            });
          },
          onSave,
        }}
      />
      {loadPhase !== "ready" && (
        <div
          className={[
            "sigma-studio-editor-loading-cover",
            loadPhase === "leaving" ? "is-leaving" : "",
          ].filter(Boolean).join(" ")}
          aria-hidden="true"
        >
          <span className="sigma-studio-editor-loading-spinner" />
        </div>
      )}
    </div>
  );
}
