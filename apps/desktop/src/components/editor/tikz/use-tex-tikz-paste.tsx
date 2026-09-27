"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getPageMetrics, type SigmaDocument } from "@/features/document";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { planTexTikzPaste, renderTexTikzPaste, type TexTikzPastePlan } from "@/lib/tex-tikz-import";
import { useT } from "@/lib/i18n/react";
import { Button } from "@/components/ui/Button";
import { Shimmer } from "@/components/ui/Shimmer";
import { Stack } from "@/components/ui/layout";
import { GraphSettingsPanelFrame } from "../GraphSettingsPanel";
import styles from "./Tikz.module.css";

export interface TexTikzPastePorts {
  document: SigmaDocument;
  fileId: string | null;
  writable: boolean;
  getPasteAnchor: () => string | null;
  insertDocument: (document: SigmaDocument, afterBlockId: string | null) => boolean;
}

export function useTexTikzPaste(ports: TexTikzPastePorts) {
  const t = useT("settings");
  const tc = useT("common");
  const live = useRef(ports);
  useLayoutEffect(() => { live.current = ports; });
  const [batch, setBatch] = useState<{ plan: TexTikzPastePlan; docId: string; fileId: string | null; anchor: string | null } | null>(null);
  const [progress, setProgress] = useState(0);
  const [failures, setFailures] = useState<number | null>(null);
  const cancel = useCallback(() => setBatch(null), []);
  const visible = batch && ports.writable && batch.docId === ports.document.docId && batch.fileId === ports.fileId;
  if (batch && !visible) setBatch(null);
  const paste = useCallback((text: string): boolean => {
    const current = live.current;
    if (!current.writable || !getDesktopBridge()?.tikz || !/\\begin\s*\{(?:tikzpicture|tikzcd|circuitikz)\}/.test(text)) return false;
    let plan: TexTikzPastePlan | null;
    try { plan = planTexTikzPaste(text, current.document.metadata.tikzEnvironment); }
    // Let the ordinary paste preserve the source if the TeX importer rejects it.
    catch { return false; }
    if (!plan || (plan.figures.length === 1 && plan.document.content.length === 1
      && plan.document.content[0].id === plan.figures[0].blockId)) return false;
    setProgress(0);
    setFailures(null);
    setBatch({ plan, docId: current.document.docId, fileId: current.fileId, anchor: current.getPasteAnchor() });
    return true;
  }, []);

  useEffect(() => {
    if (!batch) return;
    if (!ports.writable || ports.document.docId !== batch.docId || ports.fileId !== batch.fileId) {
      return;
    }
    let active = true;
    const api = getDesktopBridge()!.tikz!;
    void renderTexTikzPaste(batch.plan, input => api.render(input), {
      maxWidth: Math.min(480, getPageMetrics(live.current.document.pageLayout).flow.columnWidthPx),
      cancelled: () => !active,
      onProgress: completed => { if (active) setProgress(completed); },
    }).then(result => {
      const current = live.current;
      if (!active || !result || !current.writable || current.document.docId !== batch.docId || current.fileId !== batch.fileId) return;
      if (!current.insertDocument(result.document, batch.anchor)) { setBatch(null); return; }
      if (result.failures) setFailures(result.failures);
      else setBatch(null);
    });
    return () => { active = false; };
  }, [batch, ports.document.docId, ports.fileId, ports.writable]);

  return { paste, cancel, dialog: visible ? <GraphSettingsPanelFrame shapeId="" width={320} minWidth={280}
    title={t("tikz.importTitle")} ariaLabel={t("tikz.importTitle")} onClose={() => setBatch(null)}>
    <Stack gap="md" className={styles.editor}>
      <div role="status">{failures === null
        ? <Shimmer>{t("tikz.importProgress", { completed: progress, total: batch.plan.figures.length })}</Shimmer>
        : t("tikz.importFailures", { count: failures })}</div>
      <Button size="sm" onClick={() => setBatch(null)}>{tc(failures === null ? "actions.cancel" : "actions.close")}</Button>
    </Stack>
  </GraphSettingsPanelFrame> : null };
}
