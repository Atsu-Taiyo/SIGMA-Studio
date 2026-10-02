"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent as ReactChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
} from "react";
import {
  capAiEditTurnReferences,
  createAiEditOverlaySelectionContext,
  createBlockAiEditReference,
  createCanvasRegionAiEditReference,
  getAiEditReferenceKey,
  getDefaultAiEditInsertionTargetId,
  isImplicitAiEditReferenceSuppressed,
  MAX_AI_EDIT_REFERENCES,
  withAiEditOverlaySelection,
  type AiEditReference,
} from "@/lib/ai/ai-edit-reference";
import { getAttachmentDefaultInstruction } from "@/lib/ai/ai-edit-runtime";
import { type AiEditShapeOnlyPreview } from "@/lib/ai/ai-edit-shape-preview";
import type { useAiChatModelController } from "@/features/ai-edit/application/use-ai-chat-model-controller";
import type { AiProvider } from "@/lib/ai/ai-providers";
import { useAiComposerLifetime } from "./use-ai-composer-lifetime";
import { toAiResourceProvider } from "@/lib/ai/ai-providers";
import type { AiEditAttachment, AiEditMentionedDocumentContext } from "@/lib/ai/sigma-doc-agent-tools";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useT } from "@/lib/i18n/react";
import type { DesktopAiResourceManifestEntry, DesktopDocumentMetadata } from "@/types/desktop";
import {
  MAX_AI_EDIT_MENTIONED_DOCUMENTS,
  type ActiveMentionQuery,
  type ActiveSlashQuery,
  type ContextPickerItem,
  getOverlaySelectionTargetBlockId,
  getActiveSigmaDocMentionQuery,
  getActiveAiResourceSlashQuery,
  removeActiveTriggerRange,
  filterAiResourceSlashCandidates,
  toggleAiResourceSelection,
  upsertMentionedDocument,
  removeMentionedDocumentByFileId,
  filterSigmaDocMentionCandidates,
  createMentionedDocumentContext,
} from "@/features/ai-edit/application/ai-chat-context";
import {
  MAX_AI_EDIT_ATTACHMENTS,
  type OverlayReferencePreview,
  buildSelectedOverlayShapePreview,
  buildStoredOverlaySelectionPreview,
  hasSelectedOverlayImageAttachments,
  getClipboardImageFiles,
  createAiEditAttachmentFromFile,
} from "@/features/ai-edit/application/ai-chat-attachments";
import type { AiEditPanelProps } from "@/features/ai-edit/application/ai-chat-panel-contracts";
export type AiChatComposerOptions = Pick<AiEditPanelProps, "document" | "documentIdentityKey" | "documentWorkspaceId" | "selectedId" | "reference" | "pinnedReferences" | "pinnedReferencePreviews" | "overlaySelection"> & { provider: AiProvider; refreshRuntimeModels: ReturnType<typeof useAiChatModelController>["refreshRuntimeModels"] };
const EMPTY_PINNED_REFERENCES: AiEditReference[]=[];
const EMPTY_PINNED_REFERENCE_PREVIEWS: ReadonlyMap<string, AiEditShapeOnlyPreview>=new Map();
/** Owns one unsent draft, references, picker IO and its lifetime; runs stay in the global controller. */
export function useAiChatComposer({document,documentIdentityKey,documentWorkspaceId=null,selectedId,reference,pinnedReferences=EMPTY_PINNED_REFERENCES,pinnedReferencePreviews=EMPTY_PINNED_REFERENCE_PREVIEWS,overlaySelection,provider,refreshRuntimeModels}: AiChatComposerOptions) {
  const t=useT("ai");
  const { invalidate, capture, defer } = useAiComposerLifetime(documentIdentityKey);
  const [instruction, setInstruction] = useState("");
  const [composerError, setComposerError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<AiEditAttachment[]>([]);
  const [mentionedDocuments, setMentionedDocuments] = useState<AiEditMentionedDocumentContext[]>([]);
  const [mentionQuery, setMentionQuery] = useState<ActiveMentionQuery | null>(null);
  const [mentionCandidates, setMentionCandidates] = useState<DesktopDocumentMetadata[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [aiResources, setAiResources] = useState<DesktopAiResourceManifestEntry[]>([]);
  const [selectedAiResourceIds, setSelectedAiResourceIds] = useState<string[]>([]);
  const [slashQuery, setSlashQuery] = useState<ActiveSlashQuery | null>(null);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  // 統一コンテキストピッカー(+メニュー): ドキュメント/スキルを横断検索するローカル状態。
  // 選択済みは mentionedDocuments / selectedAiResourceIds にそのまま反映されるので、
  // このピッカー自身は「検索語」と「読み込んだ候補」だけを持てば足りる。
  const [contextPickerQuery, setContextPickerQuery] = useState("");
  // ピッカーを開いた瞬間に1回だけ取得する生の候補一覧。検索語での絞り込みは
  // contextPickerDocCandidates (useMemo) 側で行う — ここをキーストロークのたびに
  // 再取得すると desktop.storage.listFiles() のIPC往復が入力のたびに発生してしまう。
  const [contextPickerDocFiles, setContextPickerDocFiles] = useState<DesktopDocumentMetadata[]>([]);
  const [contextPickerDocLoading, setContextPickerDocLoading] = useState(false);
  const [contextPickerActiveIndex, setContextPickerActiveIndex] = useState(0);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelFlyout, setModelFlyout] = useState<"model" | "effort" | null>(null);
  const [dismissedReferenceKey, setDismissedReferenceKey] = useState<string | null>(null);
  const mediaInputRef = useRef<HTMLInputElement | null>(null);
  const contextPickerRef = useRef<HTMLDivElement | null>(null);
  const contextPickerSearchRef = useRef<HTMLInputElement | null>(null);
  const contextPickerToggleRef = useRef<HTMLButtonElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const resetComposerState = useCallback((options: { focusComposer?: boolean } = {}) => {
    invalidate();
    setComposerError(null);
    setInstruction("");
    setAttachments([]);
    setMentionedDocuments([]);
    setMentionQuery(null);
    setMentionCandidates([]);
    setMentionLoading(false);
    setMentionActiveIndex(0);
    setSelectedAiResourceIds([]);
    setSlashQuery(null);
    setSlashActiveIndex(0);
    setContextMenuOpen(false);
    setContextPickerQuery("");
    setContextPickerDocFiles([]);
    setContextPickerDocLoading(false);
    setContextPickerActiveIndex(0);
    setModelMenuOpen(false);
    setModelFlyout(null);
    setDismissedReferenceKey(null);
    if (mediaInputRef.current) {
      mediaInputRef.current.value = "";
    }
    if (options.focusComposer) {
      defer(() => composerRef.current?.focus());
    }
  }, [defer, invalidate]);

  useEffect(() => {
    const desktop = getDesktopBridge();
    let cancelled = false;
    let requestId = 0;
    const load = () => {
      const currentRequest = ++requestId;
      if (!desktop?.aiResources) {
        return;
      }
      desktop.aiResources.getTree()
        .then((tree) => {
          if (!cancelled && currentRequest === requestId) {
            // 候補はグローバルskill(workspaceId未設定)と、編集対象ドキュメントが属する
            // ワークスペース専用skillだけ。ここを実行時(buildRunContext)のスコープ判定と
            // 一致させておかないと、選べるのに実行時には無視されるskillが生まれる。
            const enabledResources = tree.resources.filter((resource) =>
              resource.enabled &&
              resource.kind === "skill" &&
              (resource.workspaceId == null || resource.workspaceId === documentWorkspaceId));
            setAiResources(enabledResources);
            const enabledIds = new Set(enabledResources.map((resource) => resource.id));
            setSelectedAiResourceIds((current) => current.filter((id) => enabledIds.has(id)));
          }
        })
        .catch(() => {
          if (!cancelled && currentRequest === requestId) {
            setAiResources([]);
          }
        });
    };
    load();
    const handleResourcesChanged = () => {
      load();
    };
    window.addEventListener("sigma-ai-resources-changed", handleResourcesChanged);
    return () => {
      cancelled = true;
      window.removeEventListener("sigma-ai-resources-changed", handleResourcesChanged);
    };
  }, [documentWorkspaceId]);

  const overlaySelectionContext = useMemo(() => createAiEditOverlaySelectionContext({
    region: overlaySelection.region,
    selectedShapeIds: overlaySelection.selectedShapeIds,
    shapes: overlaySelection.selectedShapes,
    assets: overlaySelection.selectedAssets,
  }), [overlaySelection.region, overlaySelection.selectedAssets, overlaySelection.selectedShapeIds, overlaySelection.selectedShapes]);
  const overlaySelectionTargetBlockId = useMemo(
    () => getOverlaySelectionTargetBlockId(overlaySelectionContext),
    [overlaySelectionContext],
  );
  const aiTargetId =
    (overlaySelectionContext?.region || pinnedReferences.some((item) => item.overlaySelection?.region) ? "CANVAS" : null) ??
    overlaySelectionTargetBlockId ??
    selectedId ??
    (overlaySelectionContext
      ? getDefaultAiEditInsertionTargetId(document) ?? overlaySelectionContext.selectedShapeIds[0] ?? null
      : null);

  // 暗黙参照 (implicit): 本文で選択しているだけのブロック/選択参照。overlaySelection の
  // 合成はこちらにのみ適用する (ピン留め参照はスナップショットのまま)。
  const effectiveReference = useMemo(() => {
    if (overlaySelectionContext?.region) return createCanvasRegionAiEditReference(overlaySelectionContext.region);
    const baseReference = reference && reference.targetId === aiTargetId
      ? reference
      : createBlockAiEditReference(document, aiTargetId);

    return withAiEditOverlaySelection(baseReference, overlaySelectionContext);
  }, [aiTargetId, document, overlaySelectionContext, reference]);

  // 暗黙参照チップの表示規則 (詳細は isImplicitAiEditReferenceSuppressed のコメント参照)。
  const implicitSuppressed = useMemo(
    () => isImplicitAiEditReferenceSuppressed(effectiveReference, pinnedReferences),
    [effectiveReference, pinnedReferences],
  );

  const referenceKey = useMemo(
    () => effectiveReference ? getAiEditReferenceKey(effectiveReference) : null,
    [effectiveReference],
  );
  const referenceDismissed = dismissedReferenceKey !== null && dismissedReferenceKey === referenceKey;
  // pinが上限に達した状態で暗黙参照だけ表示すると、sliceでpayloadから落ちるのにUIには
  // 見える不一致になる。送信枠がない暗黙参照は表示・preview・添付の全てから外す。
  const showReferenceChip = !!effectiveReference
    && !implicitSuppressed
    && !referenceDismissed
    && pinnedReferences.length < MAX_AI_EDIT_REFERENCES;
  const activeReference = showReferenceChip ? effectiveReference : null;
  // このturnでAIに渡す参照 (pinned 全件 + 表示中の暗黙参照)。pinned を優先し、
  // MAX_AI_EDIT_REFERENCES件を超える分 (暗黙参照側) はここで切り詰める — pinned だけで
  // 上限に達している場合は暗黙参照が入らないことになるが、その組み合わせ自体は
  // requestAiEditWithReference側の上限チェックで既に起こらない設計になっている。
  const turnReferences = useMemo<AiEditReference[]>(
    () => capAiEditTurnReferences([...pinnedReferences, ...(activeReference ? [activeReference] : [])]),
    [activeReference, pinnedReferences],
  );
  const selectedOverlayShapeCount = activeReference?.overlaySelection?.shapes.length ?? 0;
  const selectedOverlayImageCount =
    activeReference?.overlaySelection?.shapes.filter((shape) => shape.type === "image").length ?? 0;
  const selectedOverlayNonImageShapeCount = Math.max(0, selectedOverlayShapeCount - selectedOverlayImageCount);
  const activeReferenceKey = activeReference ? getAiEditReferenceKey(activeReference) : null;
  const overlayComposerPreviews = useMemo<OverlayReferencePreview[]>(
    () => turnReferences.flatMap((turnReference) => {
      const selection = turnReference.overlaySelection;
      if (!selection) {
        return [];
      }
      const turnReferenceKey = getAiEditReferenceKey(turnReference);
      const preview = pinnedReferencePreviews.get(turnReferenceKey)
        ?? (turnReferenceKey === activeReferenceKey
          ? buildSelectedOverlayShapePreview(overlaySelection)
          : buildStoredOverlaySelectionPreview(selection));
      return preview
        ? [{
          referenceKey: turnReferenceKey,
          preview,
          shapeCount: selection.shapes.length,
        }]
        : [];
    }),
    [activeReferenceKey, overlaySelection, pinnedReferencePreviews, turnReferences],
  );
  const hasAttachableSelectedImages = useMemo(
    () => Boolean(activeReference?.overlaySelection) && hasSelectedOverlayImageAttachments(overlaySelection),
    [activeReference?.overlaySelection, overlaySelection],
  );
  useEffect(() => {
    if (!mentionQuery) {
      return;
    }

    const desktop = getDesktopBridge();
    if (!desktop?.storage) {
      return;
    }

    let cancelled = false;
    desktop.storage.listFiles()
      .then((files) => {
        if (cancelled) return;
        setMentionCandidates(filterSigmaDocMentionCandidates({
          files,
          query: mentionQuery.query,
          currentFileId: documentIdentityKey,
          mentionedFileIds: mentionedDocuments.map((item) => item.fileId),
        }));
        setMentionActiveIndex(0);
        setComposerError((current) => current === t("composer.mentionCandidatesFailed") ? null : current);
      })
      .catch(() => {
        if (cancelled) return;
        setMentionCandidates([]);
        setMentionActiveIndex(0);
        setComposerError(t("composer.mentionCandidatesFailed"));
      })
      .finally(() => {
        if (!cancelled) {
          setMentionLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [documentIdentityKey, mentionQuery, mentionedDocuments, t]);

  const [pickerSession, setPickerSession] = useState({ open: contextMenuOpen, documentIdentityKey });
  if (pickerSession.open !== contextMenuOpen || pickerSession.documentIdentityKey !== documentIdentityKey) {
    setPickerSession({ open: contextMenuOpen, documentIdentityKey });
    if (contextMenuOpen) {
      setContextPickerQuery("");
      setContextPickerActiveIndex(0);
      setContextPickerDocLoading(Boolean(getDesktopBridge()?.storage));
    }
  }

  // 統一コンテキストピッカー: 開いた瞬間に1回だけドキュメント候補一覧を読み込む。検索語
  // (contextPickerQuery) はここのdepsに入れない — 入力のたびにIPC (listFiles) を叩き直さない
  // ため。絞り込みは読み込んだ一覧に対する useMemo (contextPickerDocCandidates) で行う。
  // @メンションと違い、既に選択済みのドキュメントも一覧に残す(トグルで外せるように)。
  useEffect(() => {
    if (!contextMenuOpen) {
      return;
    }

    const desktop = getDesktopBridge();
    if (!desktop?.storage) {
      return;
    }

    let cancelled = false;
    desktop.storage.listFiles()
      .then((files) => {
        if (cancelled) return;
        setContextPickerDocFiles(files);
      })
      .catch(() => {
        if (cancelled) return;
        setContextPickerDocFiles([]);
      })
      .finally(() => {
        if (!cancelled) {
          setContextPickerDocLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [contextMenuOpen, documentIdentityKey]);

  // ピッカーを開いた瞬間: 検索語をリセットして検索欄にフォーカス。
  useEffect(() => {
    if (!contextMenuOpen) {
      return;
    }
    const frame = window.requestAnimationFrame(() => contextPickerSearchRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [contextMenuOpen]);

  // 外側クリックで閉じる (Escはピッカー内の検索欄キーハンドラで処理)。
  useEffect(() => {
    if (!contextMenuOpen) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }
      if (contextPickerRef.current?.contains(target) || contextPickerToggleRef.current?.contains(target)) {
        return;
      }
      setContextMenuOpen(false);
    };
    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [contextMenuOpen]);

  const clearComposerAfterSubmit = useCallback(() => {
    invalidate();
    setComposerError(null);
    setInstruction("");
    setAttachments([]);
    setMentionedDocuments([]);
    setMentionQuery(null);
    setMentionCandidates([]);
    setMentionLoading(false);
    setMentionActiveIndex(0);
    setSelectedAiResourceIds([]);
    setSlashQuery(null);
    setSlashActiveIndex(0);
    setContextMenuOpen(false);
    setContextPickerQuery("");
    setContextPickerDocFiles([]);
    setContextPickerDocLoading(false);
    setContextPickerActiveIndex(0);
    if (mediaInputRef.current) {
      mediaInputRef.current.value = "";
    }
  }, [invalidate]);

  const addFileAttachments = async (
    files: File[],
    options: { source: "file" | "paste"; fillDefaultInstruction: boolean },
  ) => {
    if (files.length === 0) {
      return;
    }

    const remainingSlots = MAX_AI_EDIT_ATTACHMENTS - attachments.length;
    if (remainingSlots <= 0) {
      setComposerError(t("composer.attachmentLimit", { replace: { max: MAX_AI_EDIT_ATTACHMENTS } }));
      return;
    }

    const request = capture();
    try {
      const nextAttachments = await Promise.all(
        files.slice(0, remainingSlots).map((file) => createAiEditAttachmentFromFile(file, options.source, request.signal)),
      );
      if (!request.isCurrent()) return;
      setAttachments((current) => [...current, ...nextAttachments].slice(0, MAX_AI_EDIT_ATTACHMENTS));
      setContextMenuOpen(false);
      if (options.fillDefaultInstruction) {
        setInstruction((current) => current.trim()
          ? current
          : getAttachmentDefaultInstruction([...attachments, ...nextAttachments]));
      }
      setComposerError(files.length > remainingSlots ? t("composer.attachmentLimit", { replace: { max: MAX_AI_EDIT_ATTACHMENTS } }) : null);
      composerRef.current?.focus();
    } catch {
      if (request.isCurrent()) setComposerError(t("composer.fileReadFailed"));
    }
  };

  const handleAttachmentFiles = (files: FileList | null) => {
    void addFileAttachments(Array.from(files ?? []), {
      source: "file",
      fillDefaultInstruction: true,
    });
  };

  const handleInstructionPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = getClipboardImageFiles(event.clipboardData);
    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    const pastedText = event.clipboardData.getData("text/plain");
    if (pastedText) {
      const textarea = event.currentTarget;
      const selectionStart = textarea.selectionStart;
      const selectionEnd = textarea.selectionEnd;
      const nextInstruction = `${textarea.value.slice(0, selectionStart)}${pastedText}${textarea.value.slice(selectionEnd)}`;
      setInstruction(nextInstruction);
      defer(() => {
        const cursor = selectionStart + pastedText.length;
        textarea.setSelectionRange(cursor, cursor);
      }, true);
    }

    void addFileAttachments(imageFiles, {
      source: "paste",
      fillDefaultInstruction: !pastedText.trim(),
    });
  };

  const applyActionPreset = useCallback((prompt: string) => {
    setInstruction((current) => current.trim() ? `${current.trim()}\n${prompt}` : prompt);
    setContextMenuOpen(false);
    composerRef.current?.focus();
  }, []);

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  };

  const removeMentionedDocument = (id: string) => {
    setMentionedDocuments((current) => current.filter((item) => item.id !== id));
  };

  const removeSelectedAiResource = (id: string) => {
    setSelectedAiResourceIds((current) => current.filter((item) => item !== id));
  };

  const updateMentionQueryFromInput = (value: string, cursor: number | null | undefined) => {
    const nextQuery = getActiveSigmaDocMentionQuery(value, cursor ?? value.length);
    setMentionQuery(nextQuery);
    setMentionCandidates([]);
    setMentionActiveIndex(0);
    setMentionLoading(Boolean(nextQuery));
    const nextSlashQuery = getActiveAiResourceSlashQuery(value, cursor ?? value.length);
    setSlashQuery(nextSlashQuery);
    setSlashActiveIndex(0);
  };

  const handleInstructionChange = (event: ReactChangeEvent<HTMLTextAreaElement>) => {
    const nextInstruction = event.currentTarget.value;
    setInstruction(nextInstruction);
    updateMentionQueryFromInput(nextInstruction, event.currentTarget.selectionStart);
  };

  const handleMentionCandidateSelect = async (candidate: DesktopDocumentMetadata) => {
    const activeQuery = mentionQuery;
    if (!activeQuery) {
      return;
    }

    const alreadyMentioned = mentionedDocuments.some((item) => item.fileId === candidate.fileId);
    if (!alreadyMentioned && mentionedDocuments.length >= MAX_AI_EDIT_MENTIONED_DOCUMENTS) {
      setComposerError(t("composer.mentionLimit", { replace: { max: MAX_AI_EDIT_MENTIONED_DOCUMENTS } }));
      setMentionQuery(null);
      return;
    }

    const desktop = getDesktopBridge();
    if (!desktop?.storage) {
      setComposerError(t("composer.mentionDesktopOnly"));
      setMentionQuery(null);
      return;
    }

    setMentionLoading(true);
    const request = capture();
    try {
      const mentionedDocument = await desktop.storage.loadDocument(candidate.fileId);
      if (!request.isCurrent()) return;
      if (!mentionedDocument) {
        setComposerError(t("composer.mentionLoadFailed"));
        return;
      }

      setMentionedDocuments((current) => upsertMentionedDocument(
        current,
        createMentionedDocumentContext(candidate, mentionedDocument),
        MAX_AI_EDIT_MENTIONED_DOCUMENTS,
      ));
      // @トリガーのテキストはチップに一本化するため挿入しない — トリガー範囲を削除するだけ。
      setInstruction((current) => removeActiveTriggerRange(current, activeQuery));
      setComposerError(null);
      defer(() => {
        composerRef.current?.focus();
        composerRef.current?.setSelectionRange(activeQuery.start, activeQuery.start);
      }, true);
    } catch {
      if (request.isCurrent()) setComposerError(t("composer.mentionLoadFailed"));
    } finally {
      if (request.isCurrent()) {
        setMentionLoading(false);
        setMentionQuery(null);
        setMentionCandidates([]);
        setMentionActiveIndex(0);
      }
    }
  };

  const handleAiResourceSelect = (resource: DesktopAiResourceManifestEntry) => {
    const activeQuery = slashQuery;
    if (!activeQuery) {
      return;
    }
    setSelectedAiResourceIds((current) => toggleAiResourceSelection(current, resource.id, { addOnly: true }));
    // /トリガーのテキストもチップに一本化するため挿入しない — トリガー範囲を削除するだけ。
    setInstruction((current) => removeActiveTriggerRange(current, activeQuery));
    setSlashQuery(null);
    setSlashActiveIndex(0);
    setComposerError(null);
    defer(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(activeQuery.start, activeQuery.start);
    }, true);
  };

  // 統一コンテキストピッカー: ドキュメントのトグル選択 (既に選択済みなら解除)。
  const toggleContextPickerDocument = async (candidate: DesktopDocumentMetadata) => {
    const alreadyMentioned = mentionedDocuments.some((item) => item.fileId === candidate.fileId);
    if (alreadyMentioned) {
      setMentionedDocuments((current) => removeMentionedDocumentByFileId(current, candidate.fileId));
      return;
    }

    if (mentionedDocuments.length >= MAX_AI_EDIT_MENTIONED_DOCUMENTS) {
      setComposerError(t("composer.mentionLimit", { replace: { max: MAX_AI_EDIT_MENTIONED_DOCUMENTS } }));
      return;
    }

    const desktop = getDesktopBridge();
    if (!desktop?.storage) {
      setComposerError(t("composer.mentionDesktopOnly"));
      return;
    }

    const request = capture();
    try {
      const mentionedDocument = await desktop.storage.loadDocument(candidate.fileId);
      if (!request.isCurrent()) return;
      if (!mentionedDocument) {
        setComposerError(t("composer.mentionLoadFailed"));
        return;
      }

      setMentionedDocuments((current) => upsertMentionedDocument(
        current,
        createMentionedDocumentContext(candidate, mentionedDocument),
        MAX_AI_EDIT_MENTIONED_DOCUMENTS,
      ));
      setComposerError(null);
    } catch {
      if (request.isCurrent()) setComposerError(t("composer.mentionLoadFailed"));
    }
  };

  // 統一コンテキストピッカー: スキルのトグル選択。
  const toggleContextPickerSkill = (resource: DesktopAiResourceManifestEntry) => {
    setSelectedAiResourceIds((current) => toggleAiResourceSelection(current, resource.id));
    setComposerError(null);
  };

  const selectContextPickerItem = (item: ContextPickerItem) => {
    if (item.kind === "doc") {
      return toggleContextPickerDocument(item.candidate);
    }
    toggleContextPickerSkill(item.candidate);
  };

  const dismissReferenceChip = () => {
    if (referenceKey) {
      setDismissedReferenceKey(referenceKey);
    }
  };

  const toggleContextMenu = () => {
    setContextMenuOpen((current) => {
      const next = !current;
      if (next) {
        setModelMenuOpen(false);
        setModelFlyout(null);
      }
      return next;
    });
  };

  const toggleModelMenu = () => {
    const next = !modelMenuOpen;
    setModelMenuOpen(next);
    setModelFlyout(null);
    if (next) {
      setContextMenuOpen(false);
      void refreshRuntimeModels(provider);
    }
  };

  const mentionPopoverOpen = !!mentionQuery && (mentionLoading || mentionCandidates.length > 0);
  const activeAiResourceProvider = toAiResourceProvider(provider);
  const slashCandidates = useMemo(
    () => filterAiResourceSlashCandidates({
      resources: aiResources,
      query: slashQuery?.query ?? "",
      selectedIds: selectedAiResourceIds,
      provider,
      translate: t,
    }),
    [aiResources, provider, selectedAiResourceIds, slashQuery?.query, t],
  );
  const slashPopoverOpen = !!slashQuery && slashCandidates.length > 0;
  // 統一コンテキストピッカーのドキュメント候補: 開いた時に読み込んだ生の一覧
  // (contextPickerDocFiles) を検索語で絞り込むだけ。IPC再取得はしない。
  const contextPickerDocCandidates = useMemo(
    () => filterSigmaDocMentionCandidates({
      files: contextPickerDocFiles,
      query: contextPickerQuery,
      currentFileId: documentIdentityKey,
      mentionedFileIds: [],
    }),
    [contextPickerDocFiles, contextPickerQuery, documentIdentityKey],
  );
  // 統一コンテキストピッカーのスキル候補: /ポップオーバーと同じ集合を使うが、選択済みも
  // 一覧に残してトグルで外せるようにする (selectedIds: [] で除外しない)。
  const contextPickerSkillCandidates = useMemo(
    () => filterAiResourceSlashCandidates({
      resources: aiResources,
      query: contextPickerQuery,
      selectedIds: [],
      provider,
      translate: t,
    }),
    [aiResources, contextPickerQuery, provider, t],
  );
  const contextPickerItems = useMemo<ContextPickerItem[]>(() => [
    ...contextPickerDocCandidates.map((candidate) => ({ kind: "doc" as const, candidate })),
    ...contextPickerSkillCandidates.map((candidate) => ({ kind: "skill" as const, candidate })),
  ], [contextPickerDocCandidates, contextPickerSkillCandidates]);
  if (contextPickerActiveIndex >= contextPickerItems.length && contextPickerItems.length > 0) {
    // 候補が絞り込まれてアクティブ行が範囲外になったら、レンダー中に調整 (React推奨の
    // 「前の値から導出するstateはレンダー中に補正する」パターン。setState-in-effectを避ける)。
    setContextPickerActiveIndex(contextPickerItems.length - 1);
  }
  const selectedAiResources = useMemo(
    () => selectedAiResourceIds
      .map((id) => aiResources.find((resource) => resource.id === id))
      .filter((resource): resource is DesktopAiResourceManifestEntry => resource !== undefined && resource.providers.includes(activeAiResourceProvider)),
    [activeAiResourceProvider, aiResources, selectedAiResourceIds],
  );
  const focus = useCallback(() => defer(() => composerRef.current?.focus()), [defer]);

  return {
    draft: { instruction, attachments, mentionedDocuments, selectedAiResourceIds, aiResources, overlayComposerPreviews, activeReferenceKey, hasAttachableSelectedImages, turnReferences, aiTargetId, overlaySelectionContext },
    actions: { focus, capture, resetComposerState, clearComposerAfterSubmit, setInstruction, setComposerError, applyActionPreset },
    view: { instruction, setInstruction, attachments, mentionedDocuments, mentionQuery, setMentionQuery, mentionCandidates, setMentionCandidates, mentionLoading, mentionActiveIndex, setMentionActiveIndex, selectedAiResourceIds, slashQuery, setSlashQuery, slashActiveIndex, setSlashActiveIndex, contextMenuOpen, setContextMenuOpen, contextPickerQuery, setContextPickerQuery, contextPickerDocLoading, contextPickerActiveIndex, setContextPickerActiveIndex, modelMenuOpen, setModelMenuOpen, modelFlyout, setModelFlyout, mediaInputRef, contextPickerRef, contextPickerSearchRef, contextPickerToggleRef, composerRef, referenceKey, showReferenceChip, activeReference, selectedOverlayImageCount, selectedOverlayNonImageShapeCount, overlayComposerPreviews, handleAttachmentFiles, handleInstructionPaste, removeAttachment, removeMentionedDocument, removeSelectedAiResource, updateMentionQueryFromInput, handleInstructionChange, handleMentionCandidateSelect, handleAiResourceSelect, selectContextPickerItem, dismissReferenceChip, toggleContextMenu, toggleModelMenu, mentionPopoverOpen, slashCandidates, slashPopoverOpen, contextPickerDocCandidates, contextPickerSkillCandidates, contextPickerItems, selectedAiResources },
    composerRef,
    composerError,
    hasOpenMenu: Boolean(mentionQuery || slashQuery || contextMenuOpen || modelMenuOpen),
  };
}
export type AiChatComposerController = ReturnType<typeof useAiChatComposer>;
