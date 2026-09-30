"use client";

import { Copy, FileUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";

import { Button } from "@/components/ui/Button";
import { Tabs } from "@/components/ui/settings";
import {
  useEditorExtensions,
  type ProblemFrameDrawingExtension,
  type ProblemFrameDrawingPanelProps,
} from "./editor-extension-context";
import {
  clampCustomFrameSlice,
  createCustomFrameGeometry,
  CUSTOM_FRAME_BORDER_RANGE,
  CUSTOM_FRAME_PADDING_RANGE,
  EMPTY_TIKZ_ENVIRONMENT,
  getMaxCustomFrameSlice,
  normalizeFrameSvg,
  type CustomFrameRejection,
  type ProblemCustomFrame,
  type ProblemNode,
  type TikzImageSource,
} from "@/features/document";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useT } from "@/lib/i18n/react";
import {
  applyProblemFrameDrawing,
  getProblemCustomFrameStyle,
  problemFrameClassName,
  setProblemCustomFrame,
} from "@/lib/problem-frame";
import {
  addProblemFrameToLibrary,
  getProblemFrameLibrary,
  removeProblemFrameFromLibrary,
  updateProblemFrameInLibrary,
  useProblemFrameLibrary,
} from "@/lib/problem-frame-library";
import { PROBLEM_FRAME_PRESETS } from "@/lib/problem-frame-presets";
import styles from "./ProblemCustomFrameEditor.module.css";

type SourceTab = "svg" | "tikz" | "ai";

const TIKZ_RENDER_DELAY_MS = 600;
const DEFAULT_TIKZ_SOURCE = String.raw`\begin{tikzpicture}
  \draw[line width=3pt, rounded corners=10pt, blue!60!black] (0,0) rectangle (8,5);
  \draw[line width=1pt, rounded corners=6pt, blue!40] (0.35,0.35) rectangle (7.65,4.65);
\end{tikzpicture}`;

interface Drawing {
  svg: string;
  width: number;
  height: number;
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function decodeSvgDataUrl(src: string): string {
  const payload = src.slice(src.indexOf(",") + 1);
  if (!/;base64,/i.test(src.slice(0, src.indexOf(",") + 1))) {
    return decodeURIComponent(payload);
  }
  const bytes = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function ProblemCustomFrameEditor({
  problem,
  onChange,
  activeId,
  onActiveChange,
  fresh,
  onFreshChange,
}: {
  problem: ProblemNode;
  onChange: (updater: (problem: ProblemNode) => ProblemNode) => void;
  /** The library entry being edited, or null when the frame is not on the shelf (yet). */
  activeId: string | null;
  onActiveChange: (id: string | null) => void;
  /** Starting a new frame: what the problem has now is not shown until a drawing is made. */
  fresh: boolean;
  onFreshChange: (fresh: boolean) => void;
}) {
  const t = useT("settings");
  const drawingExtension = useEditorExtensions().problemFrameDrawing;
  const library = useProblemFrameLibrary();
  const activeEntry = activeId ? library.find((entry) => entry.id === activeId) : undefined;
  const liveCustom = problem.frame?.custom;
  const custom = fresh ? undefined : liveCustom;
  const [tab, setTab] = useState<SourceTab>(custom?.tikz ? "tikz" : "svg");
  const [svgText, setSvgText] = useState(custom?.svg ?? "");
  const [svgError, setSvgError] = useState<CustomFrameRejection | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * Every edit made here is kept on the shelf too. `armed` marks "the next change of the problem's
   * frame came from this editor", and the effect below carries it over once React has applied it —
   * so the shelf always gets exactly what the problem got, not a second computation of it.
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
    if (current && !pending.asNew && updateProblemFrameInLibrary(current, { custom: liveCustom })) {
      return;
    }
    const name = pending.name
      ?? translate("problem.custom.libraryDefaultName", { number: getProblemFrameLibrary().length + 1 });
    const entry = addProblemFrameToLibrary(liveCustom, name);
    setActive(entry?.id ?? null);
  }, [liveCustom]);

  /**
   * One place that turns a finished drawing into the problem's frame. The previous frame is read
   * from the problem being updated, not from props, so two quick edits never overwrite each other,
   * and the thickness / padding the user already chose survive a new drawing.
   */
  const commitDrawing = (
    drawing: Drawing,
    extra?: { tikz?: TikzImageSource; slice?: number; asNew?: boolean; name?: string },
  ) => {
    armed.current = { asNew: Boolean(extra?.asNew) || fresh, name: extra?.name };
    onFreshChange(false);
    onChange((current) => applyProblemFrameDrawing(current, drawing, { slice: extra?.slice, tikz: extra?.tikz }));
  };

  const updateGeometry = (patch: Partial<Pick<ProblemCustomFrame, "slice" | "borderPx" | "paddingPx">>) => {
    if (!custom) {
      return;
    }
    armed.current = { asNew: false };
    onChange((current) => {
      const previous = current.frame?.custom;
      if (!previous) {
        return current;
      }
      const geometry = createCustomFrameGeometry(previous, { ...previous, ...patch });
      const { tikz } = previous;
      return setProblemCustomFrame(current, { ...geometry, ...(tikz ? { tikz } : {}) });
    });
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
    applySvgText(await file.text());
  };

  const previewStyle = useMemo(
    () => custom ? getProblemCustomFrameStyle(custom, "px") as CSSProperties : undefined,
    [custom],
  );

  return (
    <div className={styles.editor} data-testid="problem-custom-frame-editor">
      <p className={styles.hint}>{t("problem.custom.hint")}</p>

      <div className={styles.shelf} data-testid="problem-custom-frame-shelf">
        {fresh ? (
          <p className={styles.note}>{t("problem.custom.shelfNew")}</p>
        ) : activeEntry ? (
          <>
            <label className={styles.nameField}>
              <span>{t("problem.custom.nameLabel")}</span>
              <input
                type="text"
                maxLength={40}
                data-testid="problem-custom-frame-name"
                value={activeEntry.name}
                onChange={(event) => updateProblemFrameInLibrary(activeEntry.id, { name: event.target.value })}
              />
            </label>
            <div className={styles.row}>
              <Button
                size="sm"
                data-testid="problem-custom-frame-duplicate"
                disabled={!liveCustom}
                onClick={() => {
                  if (!liveCustom) return;
                  const copy = addProblemFrameToLibrary(liveCustom, t("problem.custom.copyName", { name: activeEntry.name }));
                  if (copy) onActiveChange(copy.id);
                }}
              >
                <Copy size={14} aria-hidden="true" />
                {t("problem.custom.duplicate")}
              </Button>
              <Button
                size="sm"
                tone="danger"
                data-testid="problem-custom-frame-delete"
                onClick={() => {
                  removeProblemFrameFromLibrary(activeEntry.id);
                  onActiveChange(null);
                }}
              >
                <Trash2 size={14} aria-hidden="true" />
                {t("problem.custom.deleteFromShelf")}
              </Button>
            </div>
            <p className={styles.note}>{t("problem.custom.shelfNote")}</p>
          </>
        ) : liveCustom ? (
          <div className={styles.row}>
            <Button
              size="sm"
              data-testid="problem-custom-frame-save"
              onClick={() => {
                const entry = addProblemFrameToLibrary(liveCustom, t("problem.custom.libraryDefaultName", { number: library.length + 1 }));
                if (entry) onActiveChange(entry.id);
              }}
            >
              <Plus size={14} aria-hidden="true" />
              {t("problem.custom.addToShelf")}
            </Button>
            <span className={styles.note}>{t("problem.custom.notOnShelf")}</span>
          </div>
        ) : null}
      </div>

      <span className={styles.previewLabel}>{t("problem.custom.presetsLabel")}</span>
      <div className={styles.presets} role="group" aria-label={t("problem.custom.presetsAria")}>
        {PROBLEM_FRAME_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={styles.preset}
            data-testid={`problem-frame-preset-${preset.id}`}
            onClick={() => {
              setSvgText(preset.drawing.svg);
              setSvgError(null);
              commitDrawing(preset.drawing, { slice: preset.slice, asNew: true, name: t(preset.labelKey) });
            }}
          >
            {/* The drawing is previewed as an image, where it cannot run anything. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={svgDataUrl(preset.drawing.svg)} alt="" className={styles.presetImage} />
            <span>{t(preset.labelKey)}</span>
          </button>
        ))}
      </div>

      <Tabs
        label={t("problem.custom.sourceAria")}
        value={tab}
        onValueChange={setTab}
        items={[
          { value: "svg", label: t("problem.custom.tabSvg") },
          { value: "tikz", label: t("problem.custom.tabTikz") },
          ...(drawingExtension ? [{ value: "ai" as const, label: t("problem.custom.tabAi") }] : []),
        ]}
      >
        {tab === "svg" && (
          <div className={styles.panel}>
            <textarea
              className={styles.code}
              data-testid="problem-custom-frame-svg"
              spellCheck={false}
              aria-label={t("problem.custom.svgLabel")}
              placeholder={t("problem.custom.svgPlaceholder")}
              value={svgText}
              onChange={(event) => applySvgText(event.target.value)}
            />
            {svgError && <p role="alert" className={styles.error}>{t(`problem.custom.errors.${svgError}`)}</p>}
            <div className={styles.row}>
              <Button size="sm" onClick={() => fileInputRef.current?.click()}>
                <FileUp size={14} aria-hidden="true" />
                {t("problem.custom.svgFile")}
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
            problemId={problem.id}
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
              label={t("problem.custom.corner")}
              testId="problem-custom-frame-corner"
              min={1}
              max={getMaxCustomFrameSlice(custom.width, custom.height)}
              step={0.5}
              value={custom.slice}
              onChange={(value) => updateGeometry({ slice: clampCustomFrameSlice(value, custom.width, custom.height) })}
            />
            <RangeField
              label={t("problem.custom.thickness")}
              testId="problem-custom-frame-thickness"
              min={CUSTOM_FRAME_BORDER_RANGE.min}
              max={CUSTOM_FRAME_BORDER_RANGE.max}
              step={1}
              value={custom.borderPx}
              onChange={(value) => updateGeometry({ borderPx: value })}
            />
            <RangeField
              label={t("problem.custom.padding")}
              testId="problem-custom-frame-padding"
              min={CUSTOM_FRAME_PADDING_RANGE.min}
              max={CUSTOM_FRAME_PADDING_RANGE.max}
              step={1}
              value={custom.paddingPx}
              onChange={(value) => updateGeometry({ paddingPx: value })}
            />
          </div>

          <div className={styles.previewBlock}>
            <span className={styles.previewLabel}>{t("problem.custom.preview")}</span>
            {/* Same classes and stylesheet as the real problem, so what is shown is what is printed. */}
            <div
              className={`${problemFrameClassName("problem-area-flow-unit with-frame", "custom")} first-frame-area last-frame-area ${styles.previewPaper}`}
              style={previewStyle}
              data-testid="problem-custom-frame-preview"
            >
              {t("problem.custom.previewSample")}
            </div>
            <span className={styles.note}>{t("problem.custom.transparentNote")}</span>
          </div>
        </>
      )}
    </div>
  );
}

/** Hosts the feature-owned drawing panel; it only ever sees the current drawing and a callback. */
function DrawingExtensionPanel({
  extension,
  problemId,
  currentSvg,
  onDrawn,
}: ProblemFrameDrawingPanelProps & { extension: ProblemFrameDrawingExtension }) {
  return <>{extension.renderPanel({ problemId, currentSvg, onDrawn })}</>;
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
  onRendered: (tikz: TikzImageSource, drawing: Drawing) => void;
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
        setStatus({ kind: "error", message: callbacks.current.t(`problem.custom.errors.${normalized.reason}`) });
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
        data-testid="problem-custom-frame-tikz"
        spellCheck={false}
        aria-label={t("problem.custom.tikzLabel")}
        value={source}
        onChange={(event) => edit(event.target.value)}
      />
      <p className={styles.note}>{t("problem.custom.tikzNote")}</p>
      {!bridge?.tikz && <p role="alert" className={styles.error}>{t("tikz.desktopRequired")}</p>}
      {status.kind === "rendering" && <p role="status" className={styles.note}>{t("tikz.rendering")}</p>}
      {status.kind === "error" && <p role="alert" className={styles.error}>{status.message}</p>}
      <div className={styles.row}>
        <Button
          size="sm"
          tone="primary"
          data-testid="problem-custom-frame-tikz-apply"
          disabled={!source.trim() || status.kind === "rendering"}
          onClick={() => void render(source)}
        >
          {t("problem.custom.tikzApply")}
        </Button>
      </div>
    </div>
  );
}
