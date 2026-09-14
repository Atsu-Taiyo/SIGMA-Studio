"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from "react";

import {
  getPageMetrics,
  insertTopLevelDocumentBlocks,
  normalizePageLayout,
  type DocumentBlockClock,
  type DocumentBlockIdFactory,
  type OverlayAsset,
  type OverlayPoint,
  type OverlayShape,
  type SigmaDocument,
} from "@/features/document";
import { getShapesSelectionBounds } from "@/features/drawing";
import { findBlock } from "@/lib/document-tree";
import type { Translate } from "@/lib/i18n";
import {
  cloneMaterialContentForInsert,
  materialMatchesQuery,
  mergeMaterialOverlayIntoDocument,
  replaceMaterialTriggerWithBlocks,
} from "@/lib/materials";
import { fitOfficialBoxToColumnWidth, isOfficialMaterial } from "@/lib/official-materials";
import { getAppRuntime } from "@/lib/runtime";
import type { MaterialRepository } from "@/lib/runtime/types";
import type { MaterialContent, MaterialItem } from "@/types/material";
import { FLUSH_OVERLAY_CHANGES_EVENT } from "../page-overlay-types";
import { getMaterialNameFromBlock } from "./material-capture";
import { createLibraryMaterial, deleteLibraryMaterial, loadMaterialLibrary, updateLibraryMaterial } from "./material-library-commands";
import {
  cloneMaterialContentForEditing,
  createEmptyMaterialMetadataDraft,
  materialToMetadataDraft,
  suggestVisualConceptsForMaterialContent,
  type MaterialMetadataDraft,
} from "./material-metadata-draft";
import { buildSelectedMaterialContent } from "./material-selection";
import type { DocumentChange } from "./types";

export interface MaterialLibraryControllerOptions {
  documentRef: RefObject<SigmaDocument>;
  selectedIdRef: RefObject<string | null>;
  overlaySelectionRef: RefObject<{
    selectedShapes: OverlayShape[];
    selectedAssets: Record<string, OverlayAsset>;
  }>;
  materialBlockSelectionRef: RefObject<string | null>;
  commitDocumentChange: (change: DocumentChange) => boolean;
  setSelectedId: (id: string | null) => void;
  setSelectedInlineMath: (selection: null) => void;
  setStatusMessage: (message: string) => void;
  blockMutationPorts: DocumentBlockClock & DocumentBlockIdFactory;
  tEditor: Translate<"editor">;
  tWorkspace: Translate<"workspace">;
  getRepository?: () => MaterialRepository;
}

/** 素材の一覧・下書き・dialog lifecycle。文書変更は shell の履歴・編集制限を通す。 */
export function useMaterialLibraryController({
  documentRef,
  selectedIdRef,
  overlaySelectionRef,
  materialBlockSelectionRef,
  commitDocumentChange,
  setSelectedId,
  setSelectedInlineMath,
  setStatusMessage,
  blockMutationPorts,
  tEditor,
  tWorkspace,
  getRepository: providedGetRepository,
}: MaterialLibraryControllerOptions) {
  // Keep the default getter stable even in a minified production bundle. A function
  // used only as a default argument can be inlined there and recreated per render,
  // retriggering the loading effect after every materials/loading state update.
  const getRepository = useCallback(
    () => providedGetRepository ? providedGetRepository() : getAppRuntime().materials,
    [providedGetRepository],
  );
  const [materialLibraryOpen, setMaterialLibraryOpen] = useState(false);
  const [materials, setMaterials] = useState<MaterialItem[]>([]);
  const [materialsLoading, setMaterialsLoading] = useState(false);
  const [materialError, setMaterialError] = useState<string | null>(null);
  const [materialSearch, setMaterialSearch] = useState("");
  const [materialNameDraft, setMaterialNameDraft] = useState("");
  const [materialDescriptionDraft, setMaterialDescriptionDraft] = useState("");
  const [materialEditingId, setMaterialEditingId] = useState<string | null>(null);
  const [materialEditingDraft, setMaterialEditingDraft] = useState<MaterialMetadataDraft>(() => createEmptyMaterialMetadataDraft());
  const [materialEditingContent, setMaterialEditingContent] = useState<MaterialContent | null>(null);
  const materialEditingOpenRef = useRef(false);
  const materialEditingContentRef = useRef<MaterialContent | null>(null);
  const [materialMetadataInfoOpen, setMaterialMetadataInfoOpen] = useState(false);
  const [materialAddDialogOpen, setMaterialAddDialogOpen] = useState(false);
  const [materialAddContent, setMaterialAddContent] = useState<MaterialContent | null>(null);
  const [materialAddName, setMaterialAddName] = useState("");
  const [materialAddDraft, setMaterialAddDraft] = useState<MaterialMetadataDraft>(() => createEmptyMaterialMetadataDraft());
  const [materialActionMenu, setMaterialActionMenu] = useState<{ materialId: string; x: number; y: number } | null>(null);
  const updateMaterialEditingContent = useCallback((content: MaterialContent | null) => {
    if (content && !materialEditingOpenRef.current) {
      return;
    }
    materialEditingContentRef.current = content;
    setMaterialEditingContent(content);
  }, []);

  const closeMaterialEditing = useCallback(() => {
    materialEditingOpenRef.current = false;
    setMaterialEditingId(null);
    setMaterialEditingDraft(createEmptyMaterialMetadataDraft());
    updateMaterialEditingContent(null);
    setMaterialMetadataInfoOpen(false);
  }, [updateMaterialEditingContent]);

  const refreshMaterials = useCallback(() => {
    return loadMaterialLibrary({
      getRepository,
      setMaterials,
      setLoading: setMaterialsLoading,
      setError: setMaterialError,
      translate: tEditor,
    });
  }, [getRepository, tEditor]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void refreshMaterials();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [refreshMaterials]);

  useEffect(() => {
    if (!materialActionMenu) {
      return;
    }

    const closeMenu = () => setMaterialActionMenu(null);
    const closeMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", closeMenuOnEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", closeMenuOnEscape);
    };
  }, [materialActionMenu]);

  const visibleMaterials = useMemo(() => {
    return materials.filter((material) => materialMatchesQuery(material, materialSearch));
  }, [materialSearch, materials]);
  const materialActionMenuItem = useMemo(
    () => materialActionMenu ? materials.find((candidate) => candidate.id === materialActionMenu.materialId) ?? null : null,
    [materialActionMenu, materials],
  );
  const materialEditingItem = useMemo(
    () => materialEditingId ? materials.find((candidate) => candidate.id === materialEditingId) ?? null : null,
    [materialEditingId, materials],
  );

  const captureMaterialBlockSelectionFromDom = useCallback(() => {
    const selection = window.getSelection();
    const anchorElement = selection?.anchorNode
      ? selection.anchorNode.nodeType === Node.ELEMENT_NODE
        ? selection.anchorNode as Element
        : selection.anchorNode.parentElement
      : null;
    const blockId = anchorElement?.closest<HTMLElement>("[data-sigma-doc-id]")?.getAttribute("data-sigma-doc-id") ?? null;
    const block = blockId ? findBlock(documentRef.current, blockId) : null;
    if (block && block.type !== "listItem") {
      materialBlockSelectionRef.current = blockId;
    }
    return materialBlockSelectionRef.current;
  }, [documentRef, materialBlockSelectionRef]);

  const getSelectedMaterialContent = useCallback((
    targetBlockId?: string | null,
    targetBlockIds?: readonly string[],
  ): MaterialContent | null => {
    const currentDocument = documentRef.current;
    // `overlaySelection` の state はグラフの spec 差し替えでは進めない (シェルの再レンダーを
    // 避けるため)。素材にはその瞬間の spec が要るので、必ず ref 側を読む。
    const currentSelection = overlaySelectionRef.current;
    const selectedBlockId = targetBlockId === undefined
      ? currentSelection.selectedShapes.length > 0
        ? materialBlockSelectionRef.current
        : selectedIdRef.current ?? materialBlockSelectionRef.current
      : targetBlockId;
    return buildSelectedMaterialContent(
      currentDocument,
      selectedBlockId,
      currentSelection.selectedShapes,
      currentSelection.selectedAssets,
      targetBlockIds,
    );
  }, [documentRef, materialBlockSelectionRef, overlaySelectionRef, selectedIdRef]);

  const createMaterialFromContent = useCallback((content: MaterialContent, requestedName: string, metadataDraft?: MaterialMetadataDraft) => {
    return createLibraryMaterial({
      content,
      requestedName,
      metadataDraft,
      fallbackName: () => content.blocks[0] ? getMaterialNameFromBlock(content.blocks[0], tWorkspace) : tEditor("material.shapeMaterial"),
    }, {
      getRepository,
      setMaterials,
      setLoading: setMaterialsLoading,
      setError: setMaterialError,
      translate: tEditor,
      onCreated: () => setStatusMessage(tEditor("status.materialSaved")),
    });
  }, [getRepository, setStatusMessage, tEditor, tWorkspace]);

  const saveSelectedMaterial = useCallback(async () => {
    const content = getSelectedMaterialContent();
    if (!content || (content.blocks.length === 0 && content.overlaySnapshot.shapes.length === 0)) {
      setMaterialError(tEditor("status.selectMaterialSource"));
      return;
    }

    const material = await createMaterialFromContent(content, materialNameDraft, {
      ...createEmptyMaterialMetadataDraft(),
      description: materialDescriptionDraft,
    });
    if (material) {
      setMaterialNameDraft("");
      setMaterialDescriptionDraft("");
    }
  }, [createMaterialFromContent, getSelectedMaterialContent, materialDescriptionDraft, materialNameDraft, tEditor]);

  const openMaterialAddDialog = useCallback((
    targetBlockId?: string | null,
    targetBlockIds?: readonly string[],
  ) => {
    const content = getSelectedMaterialContent(targetBlockId, targetBlockIds);
    if (!content || (content.blocks.length === 0 && content.overlaySnapshot.shapes.length === 0)) {
      const message = tEditor("status.selectMaterialSource");
      setMaterialError(message);
      setStatusMessage(message);
      return;
    }

    const fallbackName = content.blocks[0] ? getMaterialNameFromBlock(content.blocks[0], tWorkspace) : tEditor("material.shapeMaterial");
    setMaterialAddContent(content);
    setMaterialAddName(fallbackName);
    setMaterialAddDraft({
      ...createEmptyMaterialMetadataDraft(),
      visualConcepts: suggestVisualConceptsForMaterialContent(content).join(", "),
    });
    setMaterialError(null);
    setMaterialAddDialogOpen(true);
  }, [getSelectedMaterialContent, setStatusMessage, tEditor, tWorkspace]);

  const closeMaterialAddDialog = useCallback(() => {
    setMaterialAddDialogOpen(false);
    setMaterialAddContent(null);
    setMaterialAddName("");
    setMaterialAddDraft(createEmptyMaterialMetadataDraft());
  }, []);

  const confirmMaterialAddDialog = useCallback(async () => {
    if (!materialAddContent) {
      return;
    }

    const material = await createMaterialFromContent(materialAddContent, materialAddName, materialAddDraft);
    if (material) {
      closeMaterialAddDialog();
    }
  }, [closeMaterialAddDialog, createMaterialFromContent, materialAddContent, materialAddDraft, materialAddName]);

  const insertContentAt = useCallback((
    content: MaterialContent,
    triggerBlockId: string | null,
    origin: OverlayPoint,
    statusMessage = tEditor("status.materialInserted"),
  ) => {
    const inserted = cloneMaterialContentForInsert(content, {
      origin,
    });
    let nextSelectedId: string | null = null;
    commitDocumentChange((current) => {
      let nextDocument = current;
      if (triggerBlockId && inserted.blocks.length > 0) {
        const replacement = replaceMaterialTriggerWithBlocks(nextDocument, triggerBlockId, inserted.blocks);
        nextDocument = replacement.document;
        nextSelectedId = replacement.selectedId;
      } else if (triggerBlockId && inserted.blocks.length === 0) {
        nextSelectedId = triggerBlockId;
      } else if (inserted.blocks.length > 0) {
        nextDocument = insertTopLevelDocumentBlocks(
          nextDocument,
          selectedIdRef.current,
          inserted.blocks,
          blockMutationPorts,
        );
        nextSelectedId = inserted.blocks[inserted.blocks.length - 1]?.id ?? null;
      }

      nextDocument = mergeMaterialOverlayIntoDocument(nextDocument, inserted.overlaySnapshot);
      return nextDocument;
    });

    if (nextSelectedId) {
      selectedIdRef.current = nextSelectedId;
      setSelectedId(nextSelectedId);
    }
    setSelectedInlineMath(null);
    setStatusMessage(statusMessage);
  }, [blockMutationPorts, commitDocumentChange, selectedIdRef, setSelectedId, setSelectedInlineMath, setStatusMessage, tEditor]);

  const insertMaterialAt = useCallback((material: MaterialItem, triggerBlockId: string | null, origin: OverlayPoint) => {
    let content = material.content;
    let insertOrigin = origin;
    if (isOfficialMaterial(material)) {
      const columnWidthPx = getPageMetrics(normalizePageLayout(documentRef.current.pageLayout)).flow.columnWidthPx;
      content = fitOfficialBoxToColumnWidth(content, columnWidthPx);
      // Boxes are authored in block-relative coordinates where the body text sits at
      // (0, 0) and headers/frames extend into negative space above/left of it. Shift the
      // insertion origin by the box bounds top-left so the body region (not the bounding
      // box top) lands on the trigger, keeping the frame wrapped around the body text.
      const bounds = getShapesSelectionBounds(content.overlaySnapshot.shapes);
      if (bounds) {
        insertOrigin = { x: origin.x + bounds.x, y: origin.y + bounds.y };
      }
    }
    insertContentAt(content, triggerBlockId, insertOrigin);
  }, [documentRef, insertContentAt]);

  const insertMaterialFromDialog = useCallback((material: MaterialItem) => {
    insertMaterialAt(material, null, { x: 24, y: 24 });
    setMaterialActionMenu(null);
    setMaterialLibraryOpen(false);
  }, [insertMaterialAt]);

  const openMaterialActionMenu = useCallback((event: MouseEvent<HTMLButtonElement>, material: MaterialItem) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    const menuWidth = 188;
    const menuHeight = 124;
    const maxX = Math.max(12, window.innerWidth - menuWidth - 12);
    const maxY = Math.max(12, window.innerHeight - menuHeight - 12);
    setMaterialActionMenu((current) => current?.materialId === material.id ? null : {
      materialId: material.id,
      x: Math.min(Math.max(rect.right - menuWidth, 12), maxX),
      y: Math.min(rect.bottom + 6, maxY),
    });
  }, []);

  const startEditingMaterial = useCallback((material: MaterialItem) => {
    setMaterialActionMenu(null);
    setMaterialMetadataInfoOpen(false);
    if (isOfficialMaterial(material)) {
      setMaterialError(tEditor("status.officialMaterialRename"));
      return;
    }
    materialEditingOpenRef.current = true;
    setMaterialEditingId(material.id);
    setMaterialEditingDraft(materialToMetadataDraft(material));
    updateMaterialEditingContent(cloneMaterialContentForEditing(material.content));
  }, [tEditor, updateMaterialEditingContent]);

  const renameMaterial = useCallback((material: MaterialItem) => {
    return updateLibraryMaterial(material, () => {
      window.dispatchEvent(new Event(FLUSH_OVERLAY_CHANGES_EVENT));
      return {
        draft: materialEditingDraft,
        content: materialEditingContentRef.current ?? materialEditingContent ?? material.content,
      };
    }, {
      getRepository,
      setMaterials,
      setLoading: setMaterialsLoading,
      setError: setMaterialError,
      translate: tEditor,
      closeEditing: closeMaterialEditing,
      closeMenu: () => setMaterialActionMenu(null),
      onUpdated: () => setStatusMessage(tEditor("status.materialUpdated")),
    });
  }, [closeMaterialEditing, getRepository, materialEditingContent, materialEditingDraft, setStatusMessage, tEditor]);

  const deleteMaterial = useCallback((material: MaterialItem) => {
    return deleteLibraryMaterial(material, {
      getRepository,
      setMaterials,
      setLoading: setMaterialsLoading,
      setError: setMaterialError,
      translate: tEditor,
      closeMenu: () => setMaterialActionMenu(null),
    });
  }, [getRepository, tEditor]);

  return {
    materialLibraryOpen, setMaterialLibraryOpen,
    materials, materialsLoading, materialError,
    materialSearch, setMaterialSearch,
    materialNameDraft, setMaterialNameDraft,
    materialDescriptionDraft, setMaterialDescriptionDraft,
    materialEditingDraft, setMaterialEditingDraft,
    materialEditingContent, materialEditingOpenRef,
    materialMetadataInfoOpen, setMaterialMetadataInfoOpen,
    materialAddDialogOpen, materialAddContent,
    materialAddName, setMaterialAddName,
    materialAddDraft, setMaterialAddDraft,
    materialActionMenu, setMaterialActionMenu,
    visibleMaterials, materialActionMenuItem, materialEditingItem,
    updateMaterialEditingContent, closeMaterialEditing,
    refreshMaterials, captureMaterialBlockSelectionFromDom,
    getSelectedMaterialContent, createMaterialFromContent, saveSelectedMaterial,
    openMaterialAddDialog, closeMaterialAddDialog, confirmMaterialAddDialog,
    insertContentAt, insertMaterialAt, insertMaterialFromDialog,
    openMaterialActionMenu, startEditingMaterial, renameMaterial, deleteMaterial,
  };
}

export type MaterialLibraryController = ReturnType<typeof useMaterialLibraryController>;
