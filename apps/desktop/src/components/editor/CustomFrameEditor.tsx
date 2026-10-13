"use client";

import { Copy, FileUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from "react";

import { Button } from "@/components/ui/Button";
import { Tabs } from "@/components/ui/settings";
import {
  useEditorExtensions,
  type FrameDrawingExtension,
  type FrameDrawingPanelProps,
} from "./editor-extension-context";
import {
  clampCustomFrameSlice,
  CUSTOM_FRAME_BORDER_RANGE,
  CUSTOM_FRAME_PADDING_RANGE,
  EMPTY_TIKZ_ENVIRONMENT,
  getMaxCustomFrameSlice,
  normalizeFrameSvg,
  type CustomFrame,
  type CustomFrameRejection,
  type TikzImageSource,
} from "@/features/document";
import {
  applyCustomFrameDrawing,
  customFrameImageSrc,
  updateCustomFrameGeometry,
  type CustomFrameDrawing,
  type CustomFrameTarget,
} from "@/lib/custom-frame";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useT } from "@/lib/i18n/react";
import {
  addFrameToLibrary,
  getFrameLibrary,
  removeFrameFromLibrary,
  updateFrameInLibrary,
  useFrameLibrary,
} from "@/lib/frame-library";
import { FRAME_PRESETS } from "@/lib/frame-presets";
import styles from "./CustomFrameEditor.module.css";

type SourceTab = "svg" | "tikz" | "ai";

const TIKZ_RENDER_DELAY_MS = 600;
const DEFAULT_TIKZ_SOURCE = String.raw`\begin{tikzpicture}
  \draw[line width=3pt, rounded corners=10pt, blue!60!black] (0,0) rectangle (8,5);
  \draw[line width=1pt, rounded corners=6pt, blue!40] (0.35,0.35) rectangle (7.65,4.65);
\end{tikzpicture}`;

function decodeSvgDataUrl(src: string): string {
  const payload = src.slice(src.indexOf(",") + 1);
  if (!/;base64,/i.test(src.slice(0, src.indexOf(",") + 1))) {
    return decodeURIComponent(payload);
  }
  const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export interface CustomFrameEditorProps {
  /** The problem or box the frame is for. The AI conversation is kept per target. */
  target: CustomFrameTarget;
  /** The frame the target uses now (its own copy), or undefined when it has none. */
  custom: CustomFrame | undefined;
  /**
   * The one way this editor writes the frame. The updater receives the target's frame at the moment
   * of writing (not the props), so two quick edits never overwrite each other; returning undefined
   * leaves the target as it is.
   */
  onCustomChange: (updater: (previous: CustomFrame | undefined) => CustomFrame | undefined) => void;
  /** The library entry being edited, or null when the frame is not on the shelf (yet). */
  activeId: string | null;
  onActiveChange: (id: string | null) => void;
  /** Starting a new frame: what the target has now is not shown until a drawing is made. */
  fresh: boolean;
  onFreshChange: (fresh: boolean) => void;
  /**
   * The frame drawn on the target, for hosts without a preview of their own. `paperClassName` gives
   * the preview the editor's paper look.
   */
  renderPreview?: (custom: CustomFrame, paperClassName: string) => ReactNode;
  /**
   * Bumped by the host each time the user picks another frame (a shelf entry, or starting a new
   * one). The SVG / TikZ drafts belong to the frame they were written for, so they are replaced
   * then — never while the user is drawing, when the frame changes under the same pick.
   */
  pick?: number;
}

/**
 * Making a frame of your own: the examples, SVG / TikZ / AI, the corner, thickness and padding, and
 * the shelf entry the frame is kept as. The same editor serves the problem and the box dialogs; the
 * host says which block it is for and how a frame is written onto it.
 */
export function CustomFrameEditor({
  target,
  custom: liveCustom,
  onCustomChange,
  activeId,
  onActiveChange,
  fresh,
  onFreshChange,
  renderPreview,
  pick = 0,
}: CustomFrameEditorProps) {
  const t = useT("settings");
  const drawingExtension = useEditorExtensions().frameDrawing;
  const library = useFrameLibrary();
  const activeEntry = activeId ? library.find((entry) => entry.id === activeId) : undefined;
  const custom = fresh ? undefined : liveCustom;
  const [tab, setTab] = useState<SourceTab>(custom?.tikz ? "tikz" : "svg");
  const [svgText, setSvgText] = useState(custom?.svg ?? "");
  const [svgError, setSvgError] = useState<CustomFrameRejection | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Another frame was picked: left as they were, the drafts of the previous one would be committed
  // onto this one (and onto its shelf entry) by the next keystroke.
  const [draftsPick, setDraftsPick] = useState(pick);
  if (draftsPick !== pick) {
    setDraftsPick(pick);
    setSvgText(custom?.svg ?? "");
    setSvgError(null);
  }
  const pickRef = useRef(pick);
  useEffect(() => {
    pickRef.current = pick;
  });

  /**
   * Every edit made here is kept on the shelf too. `armed` marks "the next change of the target's
   * frame came from this editor", and the effect below carries it over once React has applied it —
   * so the shelf always gets exactly what the target got, not a second computation of it.
   * A drawing that is a starting point (an example, "draw a new one") becomes its own entry
   * instead of overwriting the one being edited.
   */
  const armed = useRef<{ asNew: boolean; name?: string } | null>(null);
  const libraryRef = useRef({ activeId, onActiveChange, t });
  useEffect(() => {
    libraryRef.current = { activeId, onActiveChange, t };
  });
  useEffect(() => {
    const pending = armed.current;
    if (!pending || !liveCustom) {
      return;
    }
    armed.current = null;
    const { activeId: current, onActiveChange: setActive, t: translate } = libraryRef.current;
    if (current && !pending.asNew && updateFrameInLibrary(current, { custom: liveCustom })) {
      return;
    }
    const name = pending.name
      ?? translate("frame.libraryDefaultName", { number: getFrameLibrary().length + 1 });
    const entry = addFrameToLibrary(liveCustom, name);
    setActive(entry?.id ?? null);
  }, [liveCustom]);

  /**
   * One place that turns a finished drawing into the target's frame. The thickness / padding the
   * user already chose survive a new drawing (`applyCustomFrameDrawing`).
   */
  const commitDrawing = (
    drawing: CustomFrameDrawing,
    extra?: { tikz?: TikzImageSource; slice?: number; asNew?: boolean; name?: string },
  ) => {
    armed.current = { asNew: Boolean(extra?.asNew) || fresh, name: extra?.name };
    onFreshChange(false);
    onCustomChange((previous) => applyCustomFrameDrawing(previous, drawing, { slice: extra?.slice, tikz: extra?.tikz }));
  };

  const updateGeometry = (patch: Partial<Pick<CustomFrame, "slice" | "borderPx" | "paddingPx">>) => {
    if (!custom) {
      return;
    }
    armed.current = { asNew: false };
    onCustomChange((previous) => previous ? updateCustomFrameGeometry(previous, patch) : undefined);
  };

  const applySvgText = (text: string) => {
    setSvgText(text);
    if (!text.trim()) {
      setSvgError(null);
      return;
    }
    const result = normalizeFrameSvg(text);
    if (!result.ok) {
      setSvgError(result.reason);
      return;
    }
    setSvgError(null);
    commitDrawing(result);
  };

  const readSvgFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    const startedFor = pickRef.current;
    const text = await file.text();
    // Read for a frame the user has since moved away from.
    if (startedFor !== pickRef.current) {
      return;
    }
    applySvgText(text);
  };

  return (
    <div className={styles.editor} data-testid="custom-frame-editor">
      <p className={styles.hint}>{t("frame.hint")}</p>

      <div className={styles.shelf} data-testid="custom-frame-shelf">
        {fresh ? (
          <p className={styles.note}>{t("frame.shelfNew")}</p>
        ) : activeEntry ? (
          <>
            <label className={styles.nameField}>
              <span>{t("frame.nameLabel")}</span>
              <input
                type="text"
                maxLength={40}
                data-testid="custom-frame-name"
                value={activeEntry.name}
                onChange={(event) => updateFrameInLibrary(activeEntry.id, { name: event.target.value })}
              />
            </label>
            <div className={styles.row}>
              <Button
                size="sm"
                data-testid="custom-frame-duplicate"
                disabled={!liveCustom}
                onClick={() => {
                  if (!liveCustom) return;
                  const copy = addFrameToLibrary(liveCustom, t("frame.copyName", { name: activeEntry.name }));
                  if (copy) onActiveChange(copy.id);
                }}
              >
                <Copy size={14} aria-hidden="true" />
                {t("frame.duplicate")}
              </Button>
              <Button
                size="sm"
                tone="danger"
                data-testid="custom-frame-delete"
                onClick={() => {
                  removeFrameFromLibrary(activeEntry.id);
                  onActiveChange(null);
                }}
              >
                <Trash2 size={14} aria-hidden="true" />
                {t("frame.deleteFromShelf")}
              </Button>
            </div>
            <p className={styles.note}>{t("frame.shelfNote")}</p>
          </>
        ) : liveCustom ? (
          <div className={styles.row}>
            <Button
              size="sm"
              data-testid="custom-frame-save"
              onClick={() => {
                const entry = addFrameToLibrary(liveCustom, t("frame.libraryDefaultName", { number: library.length + 1 }));
                if (entry) onActiveChange(entry.id);
              }}
            >
              <Plus size={14} aria-hidden="true" />
              {t("frame.addToShelf")}
            </Button>
            <span className={styles.note}>{t(`frame.target.${target.kind}.notOnShelf`)}</span>
          </div>
        ) : null}
      </div>

      <span className={styles.previewLabel}>{t("frame.presetsLabel")}</span>
      <div className={styles.presets} role="group" aria-label={t("frame.presetsAria")}>
        {FRAME_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={styles.preset}
            data-testid={`custom-frame-preset-${preset.id}`}
            onClick={() => {
              setSvgText(preset.drawing.svg);
              setSvgError(null);
              commitDrawing(preset.drawing, { slice: preset.slice, asNew: true, name: t(preset.labelKey) });
            }}
          >
            {/* The drawing is previewed as an image, where it cannot run anything. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={customFrameImageSrc(preset.drawing.svg)} alt="" className={styles.presetImage} />
            <span>{t(preset.labelKey)}</span>
          </button>
        ))}
      </div>

      <Tabs
        label={t("frame.sourceAria")}
        value={tab}
        onValueChange={setTab}
        items={[
          { value: "svg", label: t("frame.tabSvg") },
          { value: "tikz", label: t("frame.tabTikz") },
          ...(drawingExtension ? [{ value: "ai" as const, label: t("frame.tabAi") }] : []),
        ]}
      >
        {tab === "svg" && (
          <div className={styles.panel}>
            <textarea
              className={styles.code}
              data-testid="custom-frame-svg"
              spellCheck={false}
              aria-label={t("frame.svgLabel")}
              placeholder={t("frame.svgPlaceholder")}
              value={svgText}
              onChange={(event) => applySvgText(event.target.value)}
            />
            {svgError && <p role="alert" className={styles.error}>{t(`frame.errors.${svgError}`)}</p>}
            <div className={styles.row}>
              <Button size="sm" onClick={() => fileInputRef.current?.click()}>
                <FileUp size={14} aria-hidden="true" />
                {t("frame.svgFile")}
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".svg,image/svg+xml"
                className={styles.fileInput}
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => void readSvgFile(event)}
              />
            </div>
          </div>
        )}
        {tab === "tikz" && (
          <TikzPanel
            key={pick}
            initial={custom?.tikz}
            onRendered={(tikz, drawing) => {
              setSvgText(drawing.svg);
              commitDrawing(drawing, { tikz });
            }}
          />
        )}
        {tab === "ai" && drawingExtension && (
          <DrawingExtensionPanel
            extension={drawingExtension}
            target={target}
            currentSvg={custom?.svg ?? ""}
            onDrawn={(drawing) => {
              setSvgText(drawing.svg);
              setSvgError(null);
              commitDrawing(drawing, { slice: drawing.slice, asNew: drawing.asNew });
            }}
          />
        )}
      </Tabs>

      {custom && (
        <>
          <div className={styles.controls}>
            <RangeField
              label={t("frame.corner")}
              testId="custom-frame-corner"
              min={1}
              max={getMaxCustomFrameSlice(custom.width, custom.height)}
              step={0.5}
              value={custom.slice}
              onChange={(value) => updateGeometry({ slice: clampCustomFrameSlice(value, custom.width, custom.height) })}
            />
            <RangeField
              label={t("frame.thickness")}
              testId="custom-frame-thickness"
              min={CUSTOM_FRAME_BORDER_RANGE.min}
              max={CUSTOM_FRAME_BORDER_RANGE.max}
              step={1}
              value={custom.borderPx}
              onChange={(value) => updateGeometry({ borderPx: value })}
            />
            <RangeField
              label={t("frame.padding")}
              testId="custom-frame-padding"
              min={CUSTOM_FRAME_PADDING_RANGE.min}
              max={CUSTOM_FRAME_PADDING_RANGE.max}
              step={1}
              value={custom.paddingPx}
              onChange={(value) => updateGeometry({ paddingPx: value })}
            />
          </div>

          {renderPreview && (
            <div className={styles.previewBlock}>
              <span className={styles.previewLabel}>{t("frame.preview")}</span>
              {renderPreview(custom, styles.previewPaper)}
              <span className={styles.note}>{t("frame.transparentNote")}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Hosts the feature-owned drawing panel; it only ever sees the target, the current drawing and a callback. */
function DrawingExtensionPanel({
  extension,
  target,
  currentSvg,
  onDrawn,
}: FrameDrawingPanelProps & { extension: FrameDrawingExtension }) {
  return <>{extension.renderPanel({ target, currentSvg, onDrawn })}</>;
}

function RangeField({
  label,
  testId,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  testId: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  const fill = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <label className={styles.rangeField}>
      <span>{label}</span>
      <input
        className={styles.slider}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        data-testid={testId}
        style={{ "--slider-fill": `${fill}%` } as CSSProperties}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output className={styles.rangeValue}>{value}</output>
    </label>
  );
}

function TikzPanel({
  initial,
  onRendered,
}: {
  initial: TikzImageSource | undefined;
  onRendered: (tikz: TikzImageSource, drawing: CustomFrameDrawing) => void;
}) {
  const t = useT("settings");
  const [source, setSource] = useState(initial?.source ?? DEFAULT_TIKZ_SOURCE);
  const [status, setStatus] = useState<{ kind: "idle" } | { kind: "rendering" } | { kind: "error"; message: string }>({ kind: "idle" });
  const environment = initial?.environment ?? EMPTY_TIKZ_ENVIRONMENT;
  const latest = useRef(0);
  const callbacks = useRef({ onRendered, t });
  useEffect(() => {
    callbacks.current = { onRendered, t };
  });
  const bridge = getDesktopBridge();

  const render = async (text: string) => {
    if (!text.trim()) {
      return;
    }
    const request = ++latest.current;
    const api = getDesktopBridge()?.tikz;
    if (!api) {
      setStatus({ kind: "error", message: callbacks.current.t("tikz.desktopRequired") });
      return;
    }
    setStatus({ kind: "rendering" });
    try {
      const input: TikzImageSource = { source: text, environment };
      const response = await api.render(input);
      if (request !== latest.current) {
        return;
      }
      if (!response.ok) {
        const message = response.error === "timeout" ? callbacks.current.t("tikz.timeout")
          : response.error === "unsupported-unicode" ? callbacks.current.t("tikz.unsupportedUnicode")
          : response.error.startsWith("!") ? response.error : callbacks.current.t("tikz.renderFailed");
        setStatus({ kind: "error", message });
        return;
      }
      const normalized = normalizeFrameSvg(decodeSvgDataUrl(response.image.src));
      if (!normalized.ok) {
        setStatus({ kind: "error", message: callbacks.current.t(`frame.errors.${normalized.reason}`) });
        return;
      }
      setStatus({ kind: "idle" });
      callbacks.current.onRendered(input, normalized);
    } catch (cause) {
      if (request === latest.current) {
        setStatus({ kind: "error", message: cause instanceof Error ? cause.message : callbacks.current.t("tikz.renderFailed") });
      }
    }
  };

  // Only what the user types is compiled on its own: opening the tab on an existing TikZ frame, or
  // on the example, must not rewrite the saved frame until they ask for it.
  const renderRef = useRef(render);
  useEffect(() => {
    renderRef.current = render;
  });
  const timerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    // A render still running belongs to the frame this panel was opened for; it must not land on
    // whatever frame is picked next.
    latest.current += 1;
  }, []);
  const edit = (text: string) => {
    setSource(text);
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => void renderRef.current(text), TIKZ_RENDER_DELAY_MS);
  };

  return (
    <div className={styles.panel}>
      <textarea
        className={styles.code}
        data-testid="custom-frame-tikz"
        spellCheck={false}
        aria-label={t("frame.tikzLabel")}
        value={source}
        onChange={(event) => edit(event.target.value)}
      />
      <p className={styles.note}>{t("frame.tikzNote")}</p>
      {!bridge?.tikz && <p role="alert" className={styles.error}>{t("tikz.desktopRequired")}</p>}
      {status.kind === "rendering" && <p role="status" className={styles.note}>{t("tikz.rendering")}</p>}
      {status.kind === "error" && <p role="alert" className={styles.error}>{status.message}</p>}
      <div className={styles.row}>
        <Button
          size="sm"
          tone="primary"
          data-testid="custom-frame-tikz-apply"
          disabled={!source.trim() || status.kind === "rendering"}
          onClick={() => void render(source)}
        >
          {t("frame.tikzApply")}
        </Button>
      </div>
    </div>
  );
}
