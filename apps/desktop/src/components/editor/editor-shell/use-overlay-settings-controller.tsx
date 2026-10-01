"use client";

import { ChartSettingsPanel } from "@/components/editor/ChartSettingsPanel";
import { areGraphSpecsEqual,areSelectedOverlayChartsEqual,areSelectedOverlayGraphsEqual } from "@/components/editor/editor-shell/document-helpers";
import { applyOverlayGraphAxisLabelEdit,mergeOverlayGraphDetailWithPending,recordPendingOverlayGraphAxisLabelEdit,recordPendingOverlayGraphSpecEdit,type PendingOverlayGraphEdits } from "@/components/editor/editor-shell/overlay-graph-pending-edits";
import { OPEN_OVERLAY_CHART_SETTINGS_EVENT,OPEN_OVERLAY_GRAPH_SETTINGS_EVENT,SELECT_OVERLAY_CHART_EVENT,SELECT_OVERLAY_GRAPH_EVENT,type SelectedOverlayChart,type SelectedOverlayGraph } from "@/components/editor/EditorSettings";
import { OPEN_OVERLAY_GRAPH3D_SETTINGS_EVENT } from "@/components/editor/Graph3DSettingsPanel";
import { GraphSettingsPanel } from "@/components/editor/GraphSettingsPanel";
import { type SigmaDocument } from "@/features/document";
import { useCallback,useEffect,useMemo,useRef,useState } from "react";

export function useOverlaySettingsController(document: SigmaDocument, getDocument: () => SigmaDocument) {
  const [selectedOverlayGraph, setSelectedOverlayGraph] = useState<SelectedOverlayGraph | null>(null);
  const [selectedOverlayChart, setSelectedOverlayChart] = useState<SelectedOverlayChart | null>(null);
  const pendingOverlayGraphEditsRef = useRef<PendingOverlayGraphEdits | null>(null);
  const recordPendingAxisLabelEdit = useCallback((
    shapeId: string,
    key: Parameters<typeof recordPendingOverlayGraphAxisLabelEdit>[2],
    edit: Parameters<typeof recordPendingOverlayGraphAxisLabelEdit>[3],
  ) => {
    pendingOverlayGraphEditsRef.current = recordPendingOverlayGraphAxisLabelEdit(
      pendingOverlayGraphEditsRef.current,
      shapeId,
      key,
      edit,
    );
  }, []);
  const recordPendingSpecEdit = useCallback((
    shapeId: string,
    spec: Parameters<typeof recordPendingOverlayGraphSpecEdit>[2],
  ) => {
    pendingOverlayGraphEditsRef.current = recordPendingOverlayGraphSpecEdit(
      pendingOverlayGraphEditsRef.current,
      shapeId,
      spec,
    );
  }, []);
  const [graphSettingsShapeId, setGraphSettingsShapeId] = useState<string | null>(null);
  const [graph3DSettingsShapeId, setGraph3DSettingsShapeId] = useState<string | null>(null);
  const graphSettingsShapeIdRef = useRef<string | null>(null);
  const [chartSettingsShapeId, setChartSettingsShapeId] = useState<string | null>(null);
  const chartSettingsShapeIdRef = useRef<string | null>(null);
  const chartSettingsShapeWasInDocumentRef = useRef(false);
  const graph3DSettingsShapeWasInDocumentRef = useRef(false);
  const graphSettingsShapeWasInDocumentRef = useRef(false);
  const closeGraphSettings = useCallback(() => {
    pendingOverlayGraphEditsRef.current = null;
    graphSettingsShapeIdRef.current = null;
    graphSettingsShapeWasInDocumentRef.current = false;
    setGraphSettingsShapeId(null);
  }, []);
  const openGraphSettings = useCallback((shapeId: string) => {
    graphSettingsShapeIdRef.current = shapeId;
    graphSettingsShapeWasInDocumentRef.current = Boolean(
      getDocument().pageLayout?.overlay?.overlaySnapshot?.shapes.some(
        (shape) => shape.id === shapeId && shape.type === "graph2dShape",
      ),
    );
    setGraphSettingsShapeId(shapeId);
  }, [getDocument]);
  const closeChartSettings = useCallback(() => {
    chartSettingsShapeIdRef.current = null;
    chartSettingsShapeWasInDocumentRef.current = false;
    setChartSettingsShapeId(null);
  }, []);
  const openChartSettings = useCallback((shapeId: string) => {
    chartSettingsShapeIdRef.current = shapeId;
    chartSettingsShapeWasInDocumentRef.current = Boolean(getDocument().pageLayout?.overlay?.overlaySnapshot?.shapes.some((shape) => shape.id === shapeId && shape.type === "chartShape"));
    setChartSettingsShapeId(shapeId);
  }, [getDocument]);
  const closeGraph3DSettings = useCallback(() => {
    graph3DSettingsShapeWasInDocumentRef.current = false;
    setGraph3DSettingsShapeId(null);
  }, []);
  const openGraph3DSettings = useCallback((shapeId: string) => {
    graph3DSettingsShapeWasInDocumentRef.current = Boolean(getDocument().pageLayout?.overlay?.overlaySnapshot?.shapes.some((shape) => shape.id === shapeId && shape.type === "graph3dShape"));
    setGraph3DSettingsShapeId(shapeId);
  }, [getDocument]);

  useEffect(() => {
    if (!graphSettingsShapeId) {
      return;
    }

    const shapeExists = Boolean(
      document.pageLayout?.overlay?.overlaySnapshot?.shapes.some(
        (shape) => shape.id === graphSettingsShapeId && shape.type === "graph2dShape",
      ),
    );
    if (shapeExists) {
      graphSettingsShapeWasInDocumentRef.current = true;
      return;
    }
    if (!graphSettingsShapeWasInDocumentRef.current) {
      return;
    }

    closeGraphSettings();
    setSelectedOverlayGraph((current) => (
      current?.shapeId === graphSettingsShapeId ? null : current
    ));
  }, [closeGraphSettings, document.pageLayout?.overlay?.overlaySnapshot?.shapes, graphSettingsShapeId]);

  useEffect(() => {
    const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    if (chartSettingsShapeId) {
      if (shapes.some((shape) => shape.id === chartSettingsShapeId && shape.type === "chartShape")) chartSettingsShapeWasInDocumentRef.current = true;
      else if (chartSettingsShapeWasInDocumentRef.current) {
        closeChartSettings();
        setSelectedOverlayChart((current) => current?.shapeId === chartSettingsShapeId ? null : current);
      }
    }
    if (graph3DSettingsShapeId) {
      if (shapes.some((shape) => shape.id === graph3DSettingsShapeId && shape.type === "graph3dShape")) graph3DSettingsShapeWasInDocumentRef.current = true;
      else if (graph3DSettingsShapeWasInDocumentRef.current) closeGraph3DSettings();
    }
  }, [chartSettingsShapeId, closeChartSettings, closeGraph3DSettings, document.pageLayout?.overlay?.overlaySnapshot?.shapes, graph3DSettingsShapeId]);

  useEffect(() => {
    const handleOverlayGraphSelect = (event: Event) => {
      const detail = event instanceof CustomEvent ? (event.detail as SelectedOverlayGraph | null) : null;
      if (!detail) {
        pendingOverlayGraphEditsRef.current = null;
      }
      if (!detail && graphSettingsShapeIdRef.current) {
        // パネル自体は非モーダルなので、その内部を操作してもグラフ選択は維持される。
        // 本文・空白・別図形へ選択が移り detail が null になった時だけ閉じる。
        closeGraphSettings();
      }
      if (detail && graphSettingsShapeIdRef.current && detail.shapeId !== graphSettingsShapeIdRef.current) {
        // 別のグラフへ選択が移ったら閉じる。閉じないと state だけ残り、
        // 元のグラフを選び直したときにパネルが独りでに復活する。
        closeGraphSettings();
      }

      const merged = detail
        ? mergeOverlayGraphDetailWithPending(detail, pendingOverlayGraphEditsRef.current)
        : { detail: null, pending: null };
      pendingOverlayGraphEditsRef.current = merged.pending;
      setSelectedOverlayGraph((current) => (
        areSelectedOverlayGraphsEqual(current, merged.detail) ? current : merged.detail
      ));
    };

    window.addEventListener(SELECT_OVERLAY_GRAPH_EVENT, handleOverlayGraphSelect);
    return () => window.removeEventListener(SELECT_OVERLAY_GRAPH_EVENT, handleOverlayGraphSelect);
  }, [closeGraphSettings]);

  useEffect(() => {
    const handleOverlayChartSelect = (event: Event) => {
      const detail = event instanceof CustomEvent ? (event.detail as SelectedOverlayChart | null) : null;
      if (chartSettingsShapeIdRef.current && (!detail || detail.shapeId !== chartSettingsShapeIdRef.current)) {
        // Selection left this chart: close, or the panel state lingers and the panel reappears by
        // itself the next time the same chart is selected.
        closeChartSettings();
      }
      // The canvas re-dispatches on every commit, so an equal payload must not call `setState` —
      // that is the shell/canvas re-render loop the graph panel already guards against.
      setSelectedOverlayChart((current) => (
        areSelectedOverlayChartsEqual(current, detail) ? current : detail
      ));
    };

    window.addEventListener(SELECT_OVERLAY_CHART_EVENT, handleOverlayChartSelect);
    return () => window.removeEventListener(SELECT_OVERLAY_CHART_EVENT, handleOverlayChartSelect);
  }, [closeChartSettings]);

  useEffect(() => {
    const handleOpenOverlayChartSettings = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail as { shapeId?: unknown } | null : null;
      if (typeof detail?.shapeId === "string") {
        openChartSettings(detail.shapeId);
      }
    };

    window.addEventListener(OPEN_OVERLAY_CHART_SETTINGS_EVENT, handleOpenOverlayChartSettings);
    return () => window.removeEventListener(OPEN_OVERLAY_CHART_SETTINGS_EVENT, handleOpenOverlayChartSettings);
  }, [openChartSettings]);

  useEffect(() => {
    const handleOpenOverlayGraphSettings = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail as { shapeId?: unknown } | null : null;
      if (typeof detail?.shapeId === "string") {
        openGraphSettings(detail.shapeId);
      }
    };

    window.addEventListener(OPEN_OVERLAY_GRAPH_SETTINGS_EVENT, handleOpenOverlayGraphSettings);
    return () => window.removeEventListener(OPEN_OVERLAY_GRAPH_SETTINGS_EVENT, handleOpenOverlayGraphSettings);
  }, [openGraphSettings]);

  useEffect(() => {
    const handleOpenOverlayGraph3DSettings = (event: Event) => {
      const detail = event instanceof CustomEvent
        ? event.detail as { shapeId?: unknown } | null
        : null;
      if (typeof detail?.shapeId === "string") openGraph3DSettings(detail.shapeId);
    };
    window.addEventListener(OPEN_OVERLAY_GRAPH3D_SETTINGS_EVENT, handleOpenOverlayGraph3DSettings);
    return () => window.removeEventListener(OPEN_OVERLAY_GRAPH3D_SETTINGS_EVENT, handleOpenOverlayGraph3DSettings);
  }, [openGraph3DSettings]);

  const selectedOverlayGraphForSettings = useMemo((): SelectedOverlayGraph | null => {
    if (!selectedOverlayGraph) {
      return null;
    }

    return {
      ...selectedOverlayGraph,
      onAxisLabelChange: (key, visible) => {
        recordPendingAxisLabelEdit(
          selectedOverlayGraph.shapeId,
          key,
          { visible },
        );
        setSelectedOverlayGraph((current) => {
          if (!current || current.shapeId !== selectedOverlayGraph.shapeId) {
            return current;
          }

          return applyOverlayGraphAxisLabelEdit(current, key, { visible });
        });
        selectedOverlayGraph.onAxisLabelChange(key, visible);
      },
      onAxisLabelTextChange: (key, text) => {
        const edit = {
          visible: Boolean(text.trim()),
          text,
        };
        recordPendingAxisLabelEdit(
          selectedOverlayGraph.shapeId,
          key,
          edit,
        );
        setSelectedOverlayGraph((current) => {
          if (!current || current.shapeId !== selectedOverlayGraph.shapeId) {
            return current;
          }

          return applyOverlayGraphAxisLabelEdit(current, key, edit);
        });
        selectedOverlayGraph.onAxisLabelTextChange(key, text);
      },
      onSpecChange: (nextSpec) => {
        recordPendingSpecEdit(
          selectedOverlayGraph.shapeId,
          nextSpec,
        );
        setSelectedOverlayGraph((current) => {
          if (!current || current.shapeId !== selectedOverlayGraph.shapeId) {
            return current;
          }

          return areGraphSpecsEqual(current.spec, nextSpec) ? current : { ...current, spec: nextSpec };
        });
        selectedOverlayGraph.onSpecChange(nextSpec);
      },
    };
  }, [recordPendingAxisLabelEdit, recordPendingSpecEdit, selectedOverlayGraph]);
  // The ref-backed callbacks on this value run only from panel events, never while rendering.
  const overlayGraphSettingsDialog = graphSettingsShapeId
    // eslint-disable-next-line react-hooks/refs
    && selectedOverlayGraphForSettings?.shapeId === graphSettingsShapeId
    ? (
        <GraphSettingsPanel
          selectedOverlayGraph={selectedOverlayGraphForSettings}
          onClose={closeGraphSettings}
        />
      )
    : null;
  const overlayChartSettingsDialog = chartSettingsShapeId
    && selectedOverlayChart?.shapeId === chartSettingsShapeId
    ? (
        <ChartSettingsPanel
          chart={selectedOverlayChart}
          onClose={closeChartSettings}
          onSpecChange={(_shapeId, spec) => selectedOverlayChart.onSpecChange(spec)}
        />
      )
    : null;
  return { selectedOverlayGraph, selectedOverlayChart, setSelectedOverlayGraph, setSelectedOverlayChart, closeGraphSettings, closeChartSettings, closeGraph3DSettings, graph3DSettingsShapeId, overlayGraphSettingsDialog, overlayChartSettingsDialog };
}
