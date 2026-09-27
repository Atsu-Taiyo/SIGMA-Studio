"use client";

import { Settings2 } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button, IconButton } from "@/components/ui/Button";
import { Inline, Stack } from "@/components/ui/layout";
import { Shimmer } from "@/components/ui/Shimmer";
import { MAX_TIKZ_SOURCE_LENGTH, type TikzImageSource } from "@/features/document";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useT } from "@/lib/i18n/react";
import type { TikzRenderResult } from "@/lib/tikz-contract";
import { GraphSettingsPanelFrame } from "../GraphSettingsPanel";
import { TikzEnvironmentFields } from "./TikzEnvironmentFields";
import styles from "./Tikz.module.css";

export function TikzEditorDialog({ initial, initialImage, shapeId, autoInsert = false, onPreview, onApply, onClose }: {
  initial: TikzImageSource;
  initialImage?: TikzRenderResult;
  shapeId?: string;
  autoInsert?: boolean;
  onPreview: (image: TikzRenderResult) => void;
  onApply: (input: TikzImageSource, image: TikzRenderResult) => boolean;
  onClose: () => void;
}) {
  const t = useT("settings");
  const tc = useT("common");
  const [draft, setDraft] = useState(initial);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [rendered, setRendered] = useState(initialImage ? { input: initial, image: initialImage } : null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const environmentId = useId();
  const sourceId = useId();
  const work = useRef<Promise<void>>(Promise.resolve());
  const callbacks = useRef({ onPreview, onApply, onClose, t });
  useLayoutEffect(() => { callbacks.current = { onPreview, onApply, onClose, t }; });
  const draftKey = JSON.stringify(draft);
  const currentKey = useRef<string | null>(draftKey);
  useLayoutEffect(() => {
    currentKey.current = draftKey;
    return () => { currentKey.current = null; };
  }, [draftKey]);
  const ready = rendered !== null && JSON.stringify(rendered.input) === draftKey;
  const error = failure?.key === draftKey ? failure.message : "";
  const pending = !ready && !error && Boolean(draft.source.trim());

  useEffect(() => {
    let active = true;
    // Serialize compiles, and ignore obsolete drafts even if the worker finishes after
    // another keystroke or the panel is closed. Typing never waits for the engine.
    const timer = window.setTimeout(() => {
      const previous = work.current;
      work.current = (async () => {
        await previous;
        if (!active || !draft.source.trim()) return;
        try {
          let image: TikzRenderResult;
          if (JSON.stringify(initial) === draftKey && initialImage) {
            image = initialImage;
          } else {
            const api = getDesktopBridge()?.tikz;
            if (!api) throw new Error(callbacks.current.t("tikz.desktopRequired"));
            const response = await api.render(draft);
            if (!active || currentKey.current !== draftKey) return;
            if (!response.ok) {
              const detail = response.error === "timeout" ? callbacks.current.t("tikz.timeout")
                : response.error === "unsupported-unicode" ? callbacks.current.t("tikz.unsupportedUnicode")
                : response.error.startsWith("!") ? response.error : callbacks.current.t("tikz.renderFailed");
              throw new Error(detail);
            }
            image = response.image;
          }
          if (!active || currentKey.current !== draftKey) return;
          setRendered({ input: draft, image });
          setFailure(null);
          if (autoInsert) {
            if (callbacks.current.onApply(draft, image)) callbacks.current.onClose();
            else throw new Error(callbacks.current.t("tikz.targetChanged"));
          } else callbacks.current.onPreview(image);
        } catch (cause) {
          if (active && currentKey.current === draftKey) {
            setFailure({ key: draftKey, message: cause instanceof Error ? cause.message : callbacks.current.t("tikz.renderFailed") });
          }
        }
      })();
    }, autoInsert && draft === initial ? 0 : 500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [autoInsert, draft, draftKey, initial, initialImage]);

  return <GraphSettingsPanelFrame shapeId={shapeId ?? ""} width={420} minWidth={300}
    title={t("tikz.title")} ariaLabel={t("tikz.title")} closeLabel={tc("actions.close")} onClose={onClose}
    headerActions={<IconButton label={t("tikz.settingsTitle")} tone="ghost" size="sm"
      aria-expanded={environmentOpen} aria-controls={environmentId} aria-pressed={environmentOpen}
      onClick={() => setEnvironmentOpen((open) => !open)}>
      <Settings2 size={15} aria-hidden="true" />
    </IconButton>}>
    <Stack gap="md" className={styles.editor}>
      <div hidden={environmentOpen}>
        <label htmlFor={sourceId} className={styles.sourceLabel}>{t("tikz.source")}</label>
        <textarea id={sourceId} className={`${styles.code} ${styles.source}`} spellCheck={false}
          maxLength={MAX_TIKZ_SOURCE_LENGTH} value={draft.source}
          onChange={(event) => setDraft({ ...draft, source: event.target.value })} />
      </div>
      {environmentOpen && <div id={environmentId}>
        <TikzEnvironmentFields value={draft.environment} onChange={(environment) => setDraft({ ...draft, environment })} />
      </div>}
      {error && <div role="alert" className={styles.error}>{error}</div>}
      <Inline gap="sm" justify="between">
        <span role="status" className={styles.hint}>{pending && <Shimmer>{t("tikz.rendering")}</Shimmer>}</span>
        <Inline gap="sm">
          <Button size="sm" onClick={onClose}>{tc("actions.cancel")}</Button>
          <Button size="sm" tone="primary" disabled={!ready || Boolean(error)} onClick={() => {
            if (!rendered || !ready) return;
            if (onApply(draft, rendered.image)) onClose();
            else setFailure({ key: draftKey, message: t("tikz.targetChanged") });
          }}>{t("tikz.apply")}</Button>
        </Inline>
      </Inline>
    </Stack>
  </GraphSettingsPanelFrame>;
}
