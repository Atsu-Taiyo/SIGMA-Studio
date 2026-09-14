import { SELECTED_SHAPES_ATTACHMENT_PREFIX } from "@/lib/ai/ai-edit-attachment-names";
import { tv, tvStable } from "@/lib/ai/validation-locale";
import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";
import { findBlock, type EditableBlock } from "@/lib/document-tree";
import { listItemContinuationInlineNodes } from "@/features/document";
import { estimateBlockRects, getPageMetrics, PAGE_GAP_PX } from "@/features/document";
import type {
  EstimatedBlockRect,
  OverlayAsset,
  OverlayShape,
  BoxBlockChildBlock,
  SigmaBlock,
  SigmaDocument,
  InlineNode,
  LayoutSectionChildBlock,
  ListItemNode,
  ProblemAreaBlock,
  ProblemAreaKind,
  ProblemNode,
  RichBlock,
  SigmaTextRangeCommentAnchor,
} from "@/features/document";

export type AiEditReference = AiEditBlockReference | AiEditTextSelectionReference | AiEditInlineMathReference;

export interface AiEditReferenceBase {
  kind: "block" | "textSelection" | "inlineMath";
  targetId: string;
  targetType: string;
  excerpt: string;
  overlaySelection?: AiEditOverlaySelectionContext;
}

export interface AiEditOverlaySelectionContext {
  region?: { x: number; y: number; w: number; h: number };
  selectedShapeIds: string[];
  shapes: OverlayShape[];
  assets: Record<string, AiEditOverlayAssetContext>;
}

export interface AiEditOverlayAssetContext {
  id: string;
  type: OverlayAsset["type"];
  props: {
    w: number;
    h: number;
    name: string;
    isAnimated: boolean;
    mimeType: string | null;
    fileSize: number;
    storage?: OverlayAsset["props"]["storage"];
    srcKind: "data-url" | "remote-url" | "storage-ref" | "local-or-inline" | "empty";
  };
}

export interface AiEditBlockReference extends AiEditReferenceBase {
  kind: "block";
}

export interface AiEditTextSelectionReference extends AiEditReferenceBase {
  kind: "textSelection";
  selectedText: string;
  mathTex: string[];
  textRange?: SigmaTextRangeCommentAnchor;
  /** textRange が実際に覆うブロックID。複数ブロック選択をMCPまで欠落なく運ぶ。 */
  selectedBlockIds?: string[];
}

export interface AiEditInlineMathReference extends AiEditReferenceBase {
  kind: "inlineMath";
  mathInlineId: string;
  tex: string;
}

export interface AiEditInsertionCandidate {
  id: string;
  type: EditableBlock["type"];
  scope: "topLevel" | "problemArea";
  label: string;
  excerpt: string;
  index: number;
  isFallbackTarget: boolean;
  parentProblemId?: string;
  area?: ProblemAreaKind;
  /**
   * このブロックの推定ページ矩形 (連続キャンバス座標)。insert_shape / insert_table /
   * insert_graph の x/y と同じ絶対座標系なので、AIはここを基準に配置座標を決められる。
   * DOM計測ではなく概算なので `estimated: true` を明示する。
   */
  rect?: AiEditInsertionCandidateRect;
}

export interface AiEditInsertionCandidateRect {
  pageIndex: number;
  left: number;
  top: number;
  width: number;
  height: number;
  estimated: true;
}

const MAX_REFERENCE_TEXT = 1200;
const MAX_REFERENCE_EXCERPT = 220;
const MAX_OVERLAY_CONTEXT_SHAPES = 12;
const MAX_INSERTION_CANDIDATES = 80;

/** ピン留めできる参照(ワンドボタン「AIに追加」)の上限。超過時は追加を拒否する。 */
export const MAX_AI_EDIT_REFERENCES = 8;

/**
 * 参照の同一性キー (dedupe用)。kind / targetId / 選択テキスト or TeX / textRangeオフセット /
 * overlay図形IDから合成する。同じ箇所を同じ形で参照していれば同一とみなす。
 */
export function getAiEditReferenceKey(reference: AiEditReference): string {
  const selectionPart = reference.kind === "textSelection"
    ? reference.selectedText
    : reference.kind === "inlineMath"
      ? `${reference.mathInlineId}:${reference.tex ?? ""}`
      : "";
  const rangePart = reference.kind === "textSelection" && reference.textRange
    ? `${reference.textRange.start.blockId}@${reference.textRange.start.offset}-${reference.textRange.end.blockId}@${reference.textRange.end.offset}`
    : "";
  const overlayPart = reference.overlaySelection
    ? `overlay:${getOverlaySelectionIdentity(reference.overlaySelection)}`
    : "";
  return `${reference.kind}:${reference.targetId}:${selectionPart}:${rangePart}:${overlayPart}`;
}

/**
 * 暗黙参照 (implicit: 本文で今選んでいるだけの参照。ワンドボタンでピン留めしたものでは
 * ない) を、ピン留め済み参照との重複を理由にチップ表示から抑制すべきか判定する。
 * - kind:"block" の暗黙参照は、targetId が pinned のどれかと一致するなら (同じブロックの
 *   チップが二重になるため) 抑制する。加えて pinned が1件以上あれば、単なる block 参照は
 *   常に抑制する(「今選んでいるブロック」チップが常に割り込むのはノイズなため)。
 * - kind:"textSelection"/"inlineMath" の暗黙参照は、pin済みブロック内であってもライブの
 *   選択/数式という別コンテキストなので出す — pin と完全に同一の参照
 *   (getAiEditReferenceKey が一致する厳密な重複) のときだけ抑制する。
 * - overlay 図形選択を伴う暗黙参照は、同じ図形snapshotが既にpin済みのときだけ抑制する。
 *   別の図形snapshotなら、図形コンテキストを失わないよう表示する。
 */
export function isImplicitAiEditReferenceSuppressed(
  effectiveReference: AiEditReference | null,
  pinnedReferences: readonly AiEditReference[],
): boolean {
  if (!effectiveReference) {
    return false;
  }
  if (effectiveReference.overlaySelection) {
    const effectiveShapeKey = getOverlaySelectionIdentity(effectiveReference.overlaySelection);
    return pinnedReferences.some((item) => (
      item.overlaySelection
      && getOverlaySelectionIdentity(item.overlaySelection) === effectiveShapeKey
    ));
  }
  if (effectiveReference.kind === "block") {
    if (pinnedReferences.some((item) => item.targetId === effectiveReference.targetId)) {
      return true;
    }
    return pinnedReferences.length > 0;
  }
  const effectiveKey = getAiEditReferenceKey(effectiveReference);
  return pinnedReferences.some((item) => getAiEditReferenceKey(item) === effectiveKey);
}

function getOverlaySelectionIdentity(selection: AiEditOverlaySelectionContext): string {
  return JSON.stringify([[...selection.selectedShapeIds].sort(), selection.region]);
}

/**
 * このturnでAIに渡す参照配列を MAX_AI_EDIT_REFERENCES 件までに切り詰める。呼び出し側は
 * pinned参照を先頭、暗黙参照を末尾に並べてから渡すことで、pinned優先で切り詰められる。
 */
export function capAiEditTurnReferences(references: readonly AiEditReference[]): AiEditReference[] {
  return references.slice(0, MAX_AI_EDIT_REFERENCES);
}

export function createBlockAiEditReference(
  document: SigmaDocument,
  targetId: string | null,
): AiEditBlockReference | null {
  if (!targetId) {
    return null;
  }

  const block = findBlock(document, targetId);
  if (!block) {
    return null;
  }

  return {
    kind: "block",
    targetId,
    targetType: block.type,
    excerpt: truncateReferenceText(blockToReferenceText(block), MAX_REFERENCE_EXCERPT),
  };
}

/**
 * 図形選択をAI参照へ変換する。通常ページでは近接する本文ブロックを配置基準として
 * 引き継ぎ、本文を持たないホワイトボードでは選択図形そのものを編集対象にする。
 */
export function createOverlaySelectionAiEditReference({
  document,
  targetId,
  selectedShapeIds,
  shapes,
  assets,
}: {
  document: SigmaDocument;
  targetId: string | null;
  selectedShapeIds: string[];
  shapes: OverlayShape[];
  assets: Record<string, OverlayAsset>;
}): AiEditBlockReference | null {
  const overlaySelection = createAiEditOverlaySelectionContext({
    selectedShapeIds,
    shapes,
    assets,
  });
  if (!overlaySelection) {
    return null;
  }

  const blockReference = createBlockAiEditReference(document, targetId);
  if (blockReference) {
    return {
      ...blockReference,
      overlaySelection,
    };
  }

  const selectedShapeId = overlaySelection.selectedShapeIds.find((shapeId) =>
    overlaySelection.shapes.some((shape) => shape.id === shapeId))
    ?? overlaySelection.shapes[0]?.id;
  const selectedShape = overlaySelection.shapes.find((shape) => shape.id === selectedShapeId);
  if (!selectedShapeId || !selectedShape) {
    return null;
  }

  const hasImage = overlaySelection.shapes.some((shape) => shape.type === "image");
  const selectedShapeCount = overlaySelection.selectedShapeIds.length;
  const excerpt = hasImage
    ? tv("reference.selectedImageShapeExcerpt", { p0: selectedShapeCount })
    : tv("reference.selectedShapeExcerpt", { p0: selectedShapeCount });
  return {
    kind: "block",
    targetId: selectedShapeId,
    targetType: `overlayShape:${selectedShape.type}`,
    excerpt,
    overlaySelection,
  };
}

/** An empty whiteboard range is a placement reference, not a synthetic shape/block. */
export function createCanvasRegionAiEditReference(
  region: { x: number; y: number; w: number; h: number },
): AiEditBlockReference {
  return {
    kind: "block",
    targetId: "CANVAS",
    targetType: "canvasRegion",
    excerpt: DEFAULT_AI_TRANSLATE("reference.canvasRegion"),
    overlaySelection: { region: { ...region }, selectedShapeIds: [], shapes: [], assets: {} },
  };
}

export function getDefaultAiEditInsertionTargetId(document: SigmaDocument): string | null {
  return document.content[document.content.length - 1]?.id ?? null;
}

export function collectAiEditInsertionCandidates(
  document: SigmaDocument,
  options: {
    fallbackTargetId?: string | null;
    maxCandidates?: number;
  } = {},
): AiEditInsertionCandidate[] {
  const fallbackTargetId = options.fallbackTargetId ?? getDefaultAiEditInsertionTargetId(document);
  const maxCandidates = options.maxCandidates ?? MAX_INSERTION_CANDIDATES;
  const candidates: AiEditInsertionCandidate[] = [];
  const blockRects = estimateBlockRects(document);
  const pageStride = getPageMetrics(document.pageLayout).page.heightPx + PAGE_GAP_PX;

  for (let index = 0; index < document.content.length; index += 1) {
    const block = document.content[index];
    const rect = blockRects.get(block.id);
    candidates.push({
      id: block.id,
      type: block.type,
      scope: "topLevel",
      label: `${index + 1}. ${getBlockTypeLabel(block.type)}`,
      excerpt: truncateReferenceText(blockToReferenceText(block), MAX_REFERENCE_EXCERPT),
      index,
      isFallbackTarget: block.id === fallbackTargetId,
      ...(rect ? { rect: toInsertionCandidateRect(rect, pageStride) } : {}),
    });

    if (block.type === "problem") {
      collectProblemAreaInsertionCandidates(block, index, fallbackTargetId, candidates, {
        blockRects,
        pageStride,
      });
    }
  }

  return candidates.slice(0, maxCandidates);
}

export function createTextSelectionAiEditReference({
  document,
  targetId,
  selectedText,
  mathTex = [],
  textRange,
}: {
  document: SigmaDocument;
  targetId: string;
  selectedText: string;
  mathTex?: string[];
  textRange?: SigmaTextRangeCommentAnchor;
}): AiEditTextSelectionReference | null {
  const block = findBlock(document, targetId);
  const normalizedText = selectedText.trim();
  if (!block || !normalizedText) {
    return null;
  }

  const selectedBlockIds = textRange
    ? resolveAiEditTextRangeBlockIds(document, textRange)
    : [];

  return {
    kind: "textSelection",
    targetId,
    targetType: block.type,
    selectedText: truncateReferenceText(normalizedText, MAX_REFERENCE_TEXT),
    mathTex: uniqueNonEmpty(mathTex).slice(0, 12),
    excerpt: truncateReferenceText(normalizedText, MAX_REFERENCE_EXCERPT),
    ...(textRange ? { textRange } : {}),
    ...(selectedBlockIds.length > 0 ? { selectedBlockIds } : {}),
  };
}

/**
 * 永続化されたrun-contextのunknown値から、安全にテキスト範囲だけを復元する。
 * quote/math情報は選択ブロック解決には不要なので、存在する場合だけ引き継ぐ。
 */
export function parseAiEditTextRange(value: unknown): SigmaTextRangeCommentAnchor | null {
  if (!isUnknownRecord(value) || value.type !== "textRange") {
    return null;
  }
  const start = parseTextPosition(value.start);
  const end = parseTextPosition(value.end);
  if (!start || !end) {
    return null;
  }
  const mathInlineIds = readUnknownStringArray(value.mathInlineIds);
  const mathTex = readUnknownStringArray(value.mathTex);
  return {
    type: "textRange",
    start,
    end,
    quote: typeof value.quote === "string" ? value.quote : "",
    ...(mathInlineIds.length > 0 ? { mathInlineIds } : {}),
    ...(mathTex.length > 0 ? { mathTex } : {}),
  };
}

/**
 * SigmaDoc上のテキスト範囲を、文書順の編集可能ブロックID列へ解決する。
 * - 複数ブロック・逆方向選択に対応する。
 * - 終端offset=0のブロックは範囲外として除外する。
 * - 開始offsetがブロック末尾の場合も、その開始ブロックを除外する。
 */
export function resolveAiEditTextRangeBlockIds(
  document: SigmaDocument,
  textRange: SigmaTextRangeCommentAnchor,
): string[] {
  const documentBlockIds = document.content.flatMap(collectAiEditReferenceBlockIds);
  const startIndex = documentBlockIds.indexOf(textRange.start.blockId);
  const endIndex = documentBlockIds.indexOf(textRange.end.blockId);

  if (startIndex < 0 || endIndex < 0) {
    return uniqueNonEmpty([
      ...(startIndex >= 0 ? [textRange.start.blockId] : []),
      ...(endIndex >= 0 ? [textRange.end.blockId] : []),
    ]);
  }

  if (startIndex === endIndex) {
    return textRange.start.offset === textRange.end.offset
      ? []
      : [textRange.start.blockId];
  }

  const rangeRunsForward = startIndex < endIndex;
  const firstPosition = rangeRunsForward ? textRange.start : textRange.end;
  const lastPosition = rangeRunsForward ? textRange.end : textRange.start;
  const from = Math.min(startIndex, endIndex);
  const to = Math.max(startIndex, endIndex);
  const selectedIds = documentBlockIds.slice(from, to + 1);

  const firstBlock = findBlock(document, firstPosition.blockId);
  if (firstBlock && firstPosition.offset >= blockToStableReferenceText(firstBlock).length) {
    selectedIds.shift();
  }
  if (lastPosition.offset <= 0) {
    selectedIds.pop();
  }

  return uniqueNonEmpty(selectedIds);
}

export interface AiEditTextRangeBlockSpan {
  blockId: string;
  from: number;
  to: number;
}

/**
 * Resolves a SigmaDoc text selection into block-local plain-text spans. These
 * offsets use the same `$TeX$` representation as the DOM range capture path,
 * so the renderer can shimmer only the characters/math atoms actually selected
 * instead of widening the visual target to whole boundary blocks.
 */
export function resolveAiEditTextRangeBlockSpans(
  document: SigmaDocument,
  textRange: SigmaTextRangeCommentAnchor,
): AiEditTextRangeBlockSpan[] {
  const blockIds = resolveAiEditTextRangeBlockIds(document, textRange);
  if (blockIds.length === 0) {
    return [];
  }

  const documentBlockIds = document.content.flatMap(collectAiEditReferenceBlockIds);
  const startIndex = documentBlockIds.indexOf(textRange.start.blockId);
  const endIndex = documentBlockIds.indexOf(textRange.end.blockId);
  if (startIndex < 0 || endIndex < 0) {
    return [];
  }

  const forward = startIndex < endIndex
    || (startIndex === endIndex && textRange.start.offset <= textRange.end.offset);
  const start = forward ? textRange.start : textRange.end;
  const end = forward ? textRange.end : textRange.start;
  const startOrder = Math.min(startIndex, endIndex);
  const endOrder = Math.max(startIndex, endIndex);

  return blockIds.flatMap((blockId) => {
    const block = findBlock(document, blockId);
    const blockOrder = documentBlockIds.indexOf(blockId);
    if (!block || blockOrder < startOrder || blockOrder > endOrder) {
      return [];
    }
    const length = blockToStableReferenceText(block).length;
    const from = blockOrder === startOrder ? Math.max(0, Math.min(length, start.offset)) : 0;
    const to = blockOrder === endOrder ? Math.max(0, Math.min(length, end.offset)) : length;
    return to > from ? [{ blockId, from, to }] : [];
  });
}

export function createInlineMathAiEditReference({
  document,
  targetId,
  mathInlineId,
  tex,
}: {
  document: SigmaDocument;
  targetId: string;
  mathInlineId: string;
  tex: string;
}): AiEditInlineMathReference | null {
  const block = findBlock(document, targetId);
  if (!block || !mathInlineId) {
    return null;
  }

  return {
    kind: "inlineMath",
    targetId,
    targetType: block.type,
    mathInlineId,
    tex,
    excerpt: truncateReferenceText(tex || blockToReferenceText(block), MAX_REFERENCE_EXCERPT),
  };
}

/**
 * 複数参照のプロンプト整形。0件は「選択中ブロック全体」、1件は単数版と同一、
 * N件は「参照 i/N:」見出し付きで連結する。
 */
/**
 * ここから下の `*ForPrompt` 系と `getBlockTypeLabel` / `blockToReferenceText` が作る
 * 日本語は、**画面には出ずモデルへ渡るプロンプト本文**なので `ai` namespace には
 * 入れない。多言語化するなら WI-8 (`prompt` namespace) が扱うこと — 教材の言語と
 * プロンプトの言語の関係も、あちらの方針が決める。
 */
export function formatAiEditReferencesForPrompt(references: AiEditReference[]): string {
  if (references.length === 0) {
    return formatAiEditReferenceForPrompt(null);
  }
  if (references.length === 1) {
    return formatAiEditReferenceForPrompt(references[0]);
  }
  return references
    .map((reference, index) => tv("reference.formatAiEditReferencesForPrompt1", { p0: index + 1, p1: references.length, p2: formatAiEditReferenceForPrompt(reference) }))
    .join("\n\n");
}

export function formatAiEditReferenceForPrompt(reference: AiEditReference | null | undefined): string {
  if (!reference) {
    return tv("reference.formatAiEditReferenceForPrompt1");
  }

  const overlayContext = formatAiEditOverlaySelectionForPrompt(reference.overlaySelection);
  if (reference.targetType === "canvasRegion") return overlayContext;

  if (reference.kind === "textSelection") {
    const rangeContext = reference.textRange
      ? tv("reference.formatAiEditReferenceForPrompt2", { p0: reference.textRange.start.blockId, p1: reference.textRange.start.offset, p2: reference.textRange.end.blockId, p3: reference.textRange.end.offset })
      : tv("reference.formatAiEditReferenceForPrompt3");
    const selectedBlockIds = reference.selectedBlockIds?.length
      ? reference.selectedBlockIds
      : reference.textRange
        ? uniqueNonEmpty([reference.textRange.start.blockId, reference.textRange.end.blockId])
        : [reference.targetId];
    return [
      tv("reference.formatAiEditReferenceForPrompt4"),
      tv("reference.formatAiEditReferenceForPrompt5", { p0: reference.targetId }),
      tv("reference.formatAiEditReferenceForPrompt6", { p0: reference.targetType }),
      rangeContext,
      tv("reference.formatAiEditReferenceForPrompt7", { p0: selectedBlockIds.join(", ") }),
      tv("reference.formatAiEditReferenceForPrompt8", { p0: reference.selectedText }),
      tv("reference.formatAiEditReferenceForPrompt9", { p0: reference.mathTex.length ? reference.mathTex.join(", ") : tv("reference.none") }),
      overlayContext,
    ].join("\n");
  }

  if (reference.kind === "inlineMath") {
    return [
      tv("reference.formatAiEditReferenceForPrompt10"),
      tv("reference.formatAiEditReferenceForPrompt11", { p0: reference.targetId }),
      tv("reference.formatAiEditReferenceForPrompt12", { p0: reference.targetType }),
      `mathInline ID: ${reference.mathInlineId}`,
      tv("reference.formatAiEditReferenceForPrompt13", { p0: reference.tex || tv("reference.empty") }),
      overlayContext,
    ].join("\n");
  }

  if (reference.overlaySelection && reference.targetType.startsWith("overlayShape:")) {
    return [
      tv("reference.overlayReferenceTarget"),
      tv("reference.overlayTargetId", { p0: reference.targetId }),
      tv("reference.overlayTargetType", { p0: reference.targetType.slice("overlayShape:".length) }),
      overlayContext,
    ].join("\n");
  }

  return [
    tv("reference.formatAiEditReferenceForPrompt14"),
    tv("reference.formatAiEditReferenceForPrompt15", { p0: reference.targetId }),
    tv("reference.formatAiEditReferenceForPrompt16", { p0: reference.targetType }),
    tv("reference.formatAiEditReferenceForPrompt17", { p0: reference.excerpt || tv("reference.noContent") }),
    overlayContext,
  ].join("\n");
}

export function createAiEditOverlaySelectionContext({
  selectedShapeIds,
  shapes,
  assets,
  region,
}: {
  region?: { x: number; y: number; w: number; h: number };
  selectedShapeIds: string[];
  shapes: OverlayShape[];
  assets: Record<string, OverlayAsset>;
}): AiEditOverlaySelectionContext | null {
  if (region) return { region: { ...region }, selectedShapeIds: [], shapes: [], assets: {} };
  if (selectedShapeIds.length === 0 || shapes.length === 0) {
    return null;
  }

  return {
    selectedShapeIds: uniqueNonEmpty(selectedShapeIds).slice(0, MAX_OVERLAY_CONTEXT_SHAPES),
    shapes: shapes.slice(0, MAX_OVERLAY_CONTEXT_SHAPES),
    assets: Object.fromEntries(
      Object.entries(assets)
        .slice(0, MAX_OVERLAY_CONTEXT_SHAPES)
        .map(([assetId, asset]) => [assetId, summarizeOverlayAssetForAiContext(asset)]),
    ),
  };
}

export function withAiEditOverlaySelection(
  reference: AiEditReference | null,
  overlaySelection: AiEditOverlaySelectionContext | null,
): AiEditReference | null {
  if (!reference) {
    return null;
  }

  const base = { ...reference };
  delete base.overlaySelection;
  if (!overlaySelection) {
    return base;
  }

  return {
    ...base,
    overlaySelection,
  };
}

/** `tv` と同じ形の訳文解決器。機械可読な用途では {@link tvStable} を渡す。 */
type ReferenceTranslate = (key: string, values?: Record<string, unknown>) => string;

/**
 * ブロックの内容をテキスト化する。ラベル (「問題文」など) を含むので**ロケール依存**。
 *
 * **比較シグネチャや文字オフセットの基準長に使うときは `tvStable` を渡すこと**
 * (`blockToStableReferenceText`)。`tv` のまま使うと、内容が変わっていないのに
 * 言語を切り替えただけで pin 参照が無効化され、renderer と MCP サーバーで
 * オフセットが食い違う。
 */
export function blockToReferenceText(block: EditableBlock, translate: ReferenceTranslate = tv): string {
  if (block.type === "section") {
    return block.title;
  }

  if (block.type === "heading" || block.type === "paragraph") {
    return inlineNodesToReferenceText(block.children);
  }

  if (block.type === "list") {
    return listToReferenceText(block.items);
  }

  if (block.type === "listItem") {
    return listItemToReferenceText(block);
  }

  if (block.type === "layoutSection") {
    return block.children.map((child) => blockToReferenceText(child, translate)).filter(Boolean).join("\n");
  }

  if (block.type === "boxBlock") {
    const body = block.blocks.map((child) => boxBlockChildToReferenceText(child, translate)).filter(Boolean).join("\n");
    return [
      inlineNodesToReferenceText(block.title ?? []),
      body ? translate("reference.blockToReferenceText1", { p0: body }) : "",
    ].filter(Boolean).join("\n");
  }

  if (block.type === "divider") {
    return "";
  }

  if (block.type === "quote") {
    return block.blocks.map((child) => blockToReferenceText(child, translate)).filter(Boolean).join("\n");
  }

  if (block.type === "codeBlock") {
    return inlineNodesToReferenceText(block.children);
  }

  const lead = richBlocksToReferenceText(translate("reference.blockToReferenceText2"), block.lead, translate);
  const prompt = richBlocksToReferenceText(translate("reference.blockToReferenceText3"), block.prompt, translate);
  const answer = block.answer ? translate("reference.blockToReferenceText4", { p0: block.answer.expected }) : "";
  const comments = richBlocksToReferenceText(translate("reference.blockToReferenceText5"), block.hints, translate);
  const solution = richBlocksToReferenceText(translate("reference.blockToReferenceText6"), block.solution, translate);
  return [lead, prompt, answer, comments, solution].filter(Boolean).join("\n");
}

function collectAiEditReferenceBlockIds(
  block: SigmaBlock | ProblemAreaBlock | LayoutSectionChildBlock | BoxBlockChildBlock,
): string[] {
  if (block.type === "problem") {
    return [
      block.id,
      ...block.lead.flatMap(collectAiEditReferenceBlockIds),
      ...block.prompt.flatMap(collectAiEditReferenceBlockIds),
      ...block.hints.flatMap(collectAiEditReferenceBlockIds),
      ...block.solution.flatMap(collectAiEditReferenceBlockIds),
    ];
  }
  if (block.type === "layoutSection") {
    return [block.id, ...block.children.flatMap(collectAiEditReferenceBlockIds)];
  }
  if (block.type === "boxBlock") {
    return [block.id, ...block.blocks.flatMap(collectAiEditReferenceBlockIds)];
  }
  if (block.type === "list") {
    return [
      block.id,
      ...block.items.flatMap((item) => [
        item.id,
        ...(item.nested ?? []).flatMap(collectAiEditReferenceBlockIds),
      ]),
    ];
  }
  return [block.id];
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTextPosition(value: unknown): SigmaTextRangeCommentAnchor["start"] | null {
  if (
    !isUnknownRecord(value)
    || typeof value.blockId !== "string"
    || value.blockId.trim().length === 0
    || typeof value.offset !== "number"
    || !Number.isFinite(value.offset)
    || value.offset < 0
  ) {
    return null;
  }
  return { blockId: value.blockId.trim(), offset: value.offset };
}

function readUnknownStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? uniqueNonEmpty(value.filter((item): item is string => typeof item === "string"))
    : [];
}

export function inlineNodesToReferenceText(children: InlineNode[]): string {
  return children
    .map((child) => {
      if (child.type === "text") {
        return child.text;
      }
      return `$${child.tex}$`;
    })
    .join("");
}

export function truncateReferenceText(text: string, maxLength = MAX_REFERENCE_EXCERPT): string {
  const normalized = text.trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function richBlocksToReferenceText(label: string, blocks: ProblemAreaBlock[], translate: ReferenceTranslate): string {
  if (blocks.length === 0) {
    return "";
  }

  return `${label}:\n${blocks.map((block) => problemAreaBlockToReferenceText(block, translate)).join("\n")}`;
}

function boxBlockChildToReferenceText(block: BoxBlockChildBlock, translate: ReferenceTranslate): string {
  if (block.type === "problem") return blockToReferenceText(block, translate);
  if (block.type === "layoutSection") {
    return block.children.map((child) => layoutSectionChildToReferenceText(child, translate)).filter(Boolean).join("\n");
  }
  return layoutSectionChildToReferenceText(block, translate);
}

function layoutSectionChildToReferenceText(block: LayoutSectionChildBlock, translate: ReferenceTranslate): string {
  if (block.type === "section") {
    return block.title;
  }
  if (block.type === "divider") {
    return "";
  }
  if (block.type === "boxBlock" || block.type === "quote" || block.type === "codeBlock") {
    return blockToReferenceText(block, translate);
  }
  return richBlockToReferenceText(block);
}

function richBlockToReferenceText(block: RichBlock): string {
  if (block.type === "list") {
    return listToReferenceText(block.items);
  }

  return inlineNodesToReferenceText(block.children);
}

function problemAreaBlockToReferenceText(block: ProblemAreaBlock, translate: ReferenceTranslate): string {
  if (block.type === "layoutSection") {
    return block.children.map((child) => layoutSectionChildToReferenceText(child, translate)).filter(Boolean).join("\n");
  }
  if (block.type === "boxBlock" || block.type === "quote" || block.type === "codeBlock") {
    return blockToReferenceText(block, translate);
  }
  if (block.type === "divider") {
    return "";
  }
  return richBlockToReferenceText(block);
}

function listToReferenceText(items: ListItemNode[], depth = 0): string {
  return items.map((item) => {
    const marker = `${"  ".repeat(depth)}- `;
    const nested = (item.nested ?? []).map((list) => listToReferenceText(list.items, depth + 1)).filter(Boolean);
    return [marker + listItemToReferenceText(item), ...nested].filter(Boolean).join("\n");
  }).join("\n");
}

function listItemToReferenceText(item: ListItemNode): string {
  return [
    inlineNodesToReferenceText(item.children),
    ...(item.continuations ?? []).map((continuation) => inlineNodesToReferenceText(listItemContinuationInlineNodes(continuation))),
  ].filter(Boolean).join("\n");
}

function collectProblemAreaInsertionCandidates(
  problem: ProblemNode,
  topLevelIndex: number,
  fallbackTargetId: string | null,
  candidates: AiEditInsertionCandidate[],
  // 問題エリアの子ブロックこそが図形挿入の実アンカー
  // (resolveOverlayInsertionTarget が problem → prompt[0] へ付け替える) なので、
  // ここに rect が無いと AI は絶対座標を決める基準を持てない。
  rectSource: { blockRects: Map<string, EstimatedBlockRect>; pageStride: number },
): void {
  const areas: Array<{ area: ProblemAreaKind; blocks: ProblemAreaBlock[] }> = [
    { area: "lead", blocks: problem.lead },
    { area: "prompt", blocks: problem.prompt },
    { area: "hints", blocks: problem.hints },
    { area: "solution", blocks: problem.solution },
  ];

  for (const { area, blocks } of areas) {
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      const rect = rectSource.blockRects.get(block.id);
      candidates.push({
        id: block.id,
        type: block.type,
        scope: "problemArea",
        label: `${topLevelIndex + 1}. ${getProblemAreaLabel(area)} ${index + 1}`,
        excerpt: truncateReferenceText(problemAreaBlockToReferenceText(block, tv), MAX_REFERENCE_EXCERPT),
        index,
        isFallbackTarget: block.id === fallbackTargetId,
        parentProblemId: problem.id,
        area,
        ...(rect ? { rect: toInsertionCandidateRect(rect, rectSource.pageStride) } : {}),
      });
    }
  }
}

function getBlockTypeLabel(type: EditableBlock["type"]): string {
  if (type === "section") {
    return tv("reference.getBlockTypeLabel1");
  }
  if (type === "heading") {
    return tv("reference.getBlockTypeLabel2");
  }
  if (type === "problem") {
    return tv("reference.getBlockTypeLabel3");
  }
  if (type === "list") {
    return tv("reference.getBlockTypeLabel4");
  }
  if (type === "listItem") {
    return tv("reference.getBlockTypeLabel5");
  }
  return tv("reference.getBlockTypeLabel6");
}

function getProblemAreaLabel(area: ProblemAreaKind): string {
  if (area === "lead") {
    return tv("reference.getProblemAreaLabel1");
  }
  if (area === "prompt") {
    return tv("reference.getProblemAreaLabel2");
  }
  if (area === "hints") {
    return tv("reference.getProblemAreaLabel3");
  }
  return tv("reference.getProblemAreaLabel4");
}

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function formatAiEditOverlaySelectionForPrompt(selection: AiEditOverlaySelectionContext | undefined): string {
  if (selection?.region) {
    return [
      tv("reference.canvasRegionTitle"),
      tv("reference.canvasRegionPlacement"),
      JSON.stringify({ bounds: selection.region }),
    ].join("\n");
  }
  if (!selection || selection.shapes.length === 0) {
    return tv("reference.formatAiEditOverlaySelectionForPrompt1");
  }
  const hasImage = selection.shapes.some((shape) => shape.type === "image");

  return [
    tv("reference.formatAiEditOverlaySelectionForPrompt2", { p0: hasImage ? tv("reference.imagesAndShapes") : tv("reference.shapes"), p1: selection.shapes.length }),
    tv("reference.formatAiEditOverlaySelectionForPrompt3", { pattern: `${SELECTED_SHAPES_ATTACHMENT_PREFIX}*.png` }),
    tv("reference.formatAiEditOverlaySelectionForPrompt4", { p0: hasImage ? tv("reference.imagesAndShapes") : tv("reference.shapes") }),
    JSON.stringify(selection, null, 2),
  ].filter(Boolean).join("\n");
}

function summarizeOverlayAssetForAiContext(asset: OverlayAsset): AiEditOverlayAssetContext {
  return {
    id: asset.id,
    type: asset.type,
    props: {
      w: asset.props.w,
      h: asset.props.h,
      name: asset.props.name,
      isAnimated: asset.props.isAnimated,
      mimeType: asset.props.mimeType,
      fileSize: asset.props.fileSize,
      ...(asset.props.storage ? { storage: asset.props.storage } : {}),
      srcKind: getOverlayAssetSrcKind(asset.props.src),
    },
  };
}

export function formatReferenceSnippet(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "…";
  }
  if (normalized.length <= 6) {
    return normalized;
  }
  return `${normalized.slice(0, 3)}...${normalized.slice(-3)}`;
}

/**
 * `t` を省略したときの解決器。**呼び出し時点の表示言語**で引く。
 * 固定ロケールにすると渡し忘れが静かに日本語で出るバグになるため (WI-7 で実測)。
 * `window` の無い環境では既定ロケール (日本語) に落ちるので既存の期待値は不変。
 */
const DEFAULT_AI_TRANSLATE = createCurrentLocaleTranslator("ai");
const DEFAULT_EDITOR_TRANSLATE = createCurrentLocaleTranslator("editor");

export function getReferenceDisplayLabel(
  reference: AiEditReference,
  t: Translate<"ai"> = DEFAULT_AI_TRANSLATE,
  tEditor: Translate<"editor"> = DEFAULT_EDITOR_TRANSLATE,
): string {
  if (reference.overlaySelection && reference.targetType.startsWith("overlayShape:")) {
    const count = reference.overlaySelection.selectedShapeIds.length;
    const hasImage = reference.overlaySelection.shapes.some((shape) => shape.type === "image");
    return t(hasImage ? "reference.selectedImageShapeCount" : "reference.selectedShapeCount", {
      replace: { count },
    });
  }
  if (reference.targetType === "canvasRegion") return t("reference.canvasRegion");
  const text = reference.kind === "textSelection"
    ? (reference.selectedText || reference.excerpt)
    : reference.kind === "inlineMath"
      ? (reference.tex || reference.excerpt)
      : reference.excerpt;
  const snippet = formatReferenceSnippet(text);
  if (snippet !== "…") {
    return snippet;
  }
  if (reference.kind === "inlineMath") {
    return t("reference.kind.inlineMath");
  }
  if (reference.kind === "textSelection") {
    return t("reference.kind.textSelection");
  }
  return getTargetTypeLabel(reference.targetType, t, tEditor);
}

/**
 * 参照チップに出すブロックの呼び名。
 *
 * 見出し / 問題 / 本文は**本文編集面と同じ語**なので `editor.block.*` を引く
 * (同じラベルの出典を 2 つ作らない)。`section` だけは、この面が昔から「章」と
 * 呼んでいて `editor.block.section`「セクション」と語が違う。**呼び名を揃えるのは
 * i18n の仕事ではない**ので、意図的な差として別キーに置いてある。
 */
function getTargetTypeLabel(
  targetType: AiEditReference["targetType"],
  t: Translate<"ai">,
  tEditor: Translate<"editor">,
): string {
  if (targetType === "heading") {
    return tEditor("block.heading");
  }
  if (targetType === "problem") {
    return tEditor("block.problem");
  }
  if (targetType === "section") {
    return t("reference.targetType.section");
  }
  return tEditor("block.paragraph");
}

function getOverlayAssetSrcKind(src: string | undefined): AiEditOverlayAssetContext["props"]["srcKind"] {
  if (!src) {
    return "empty";
  }

  if (src.startsWith("data:")) {
    return "data-url";
  }

  if (src.startsWith("http://") || src.startsWith("https://")) {
    return "remote-url";
  }

  if (src.startsWith("sigma-doc-storage://")) {
    return "storage-ref";
  }

  return "local-or-inline";
}

function toInsertionCandidateRect(
  rect: EstimatedBlockRect,
  pageStridePx: number,
): AiEditInsertionCandidateRect {
  return {
    pageIndex: pageStridePx > 0 ? Math.max(0, Math.floor(rect.top / pageStridePx)) : 0,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    estimated: true,
  };
}

/**
 * 言語に依存しないブロックテキスト。**変更検知のシグネチャと文字オフセットの
 * 基準長はこれを使う** — 表示用の `blockToReferenceText` を使うと、内容が同じでも
 * UI 言語を切り替えた瞬間に別物と判定される。
 */
export function blockToStableReferenceText(block: EditableBlock): string {
  return blockToReferenceText(block, tvStable);
}
