import type {
  BoxBlockChildBlock,
  InlineNode,
  LayoutSectionChildBlock,
  ListItemNode,
  ProblemAreaBlock,
  RichBlock,
  SigmaDocument,
} from "@/features/document";
import {
  getReferenceDisplayLabel,
  type AiEditOverlaySelectionContext,
  type AiEditReference,
} from "@/lib/ai/ai-edit-reference";
import { toAiResourceProvider, type AiProvider } from "@/lib/ai/ai-providers";
import { resolveAiResourceDisplayMetadata } from "@/lib/ai/ai-resource-display";
import type { AiEditMentionedDocumentContext } from "@/lib/ai/sigma-doc-agent-tools";
import { resolveDocumentTitle } from "@/lib/document-title";
import type { EditableBlock } from "@/lib/document-tree";
import { type Translate } from "@/lib/i18n";
import type { DesktopAiResourceManifestEntry, DesktopDocumentMetadata } from "@/types/desktop";
import { tAiNow, tEditorNow } from "./ai-chat-translator";
export const MAX_AI_EDIT_MENTIONED_DOCUMENTS = 4;
export const MAX_SIGMA_DOC_MENTION_CANDIDATES = 8;
const MAX_MENTIONED_DOCUMENT_EXCERPT = 1600;
export interface ActiveMentionQuery {
  start: number;
  end: number;
  query: string;
}

export interface ActiveSlashQuery {
  start: number;
  end: number;
  query: string;
}

/** 統一コンテキストピッカーの1候補。↑↓キー移動を「ドキュメント→スキル」でひと続きに
 * 扱えるよう、両セクションをこの共通形にフラット化して並べる。 */
export type ContextPickerItem =
  | { kind: "doc"; candidate: DesktopDocumentMetadata }
  | { kind: "skill"; candidate: DesktopAiResourceManifestEntry };

export function getOverlaySelectionTargetBlockId(selection: AiEditOverlaySelectionContext | null): string | null {
  if (!selection) {
    return null;
  }

  const shapesById = new Map(selection.shapes.map((shape) => [shape.id, shape]));
  for (const shape of selection.shapes) {
    const blockId = getShapeAnchorBlockId(shape, shapesById, new Set());
    if (blockId) {
      return blockId;
    }
  }

  return null;
}

function getShapeAnchorBlockId(
  shape: AiEditOverlaySelectionContext["shapes"][number],
  shapesById: Map<string, AiEditOverlaySelectionContext["shapes"][number]>,
  visited: Set<string>,
): string | null {
  if (visited.has(shape.id)) {
    return null;
  }
  visited.add(shape.id);

  const anchor = shape.anchor;
  if (!anchor) {
    return null;
  }

  if (anchor.type === "block") {
    return anchor.blockId;
  }

  if (anchor.type === "shape") {
    const parentShape = shapesById.get(anchor.shapeId);
    return parentShape ? getShapeAnchorBlockId(parentShape, shapesById, visited) : null;
  }

  return null;
}

export function getReferenceContextText(reference: AiEditReference): string {
  const overlayText = reference.overlaySelection?.shapes.length
    ? tAiNow(reference.overlaySelection.shapes.some((shape) => shape.type === "image")
      ? "panel.selectedImagesAndShapes"
      : "panel.selectedShapes", { replace: {
        shapes: reference.overlaySelection.shapes.map((shape) => `${shape.type}:${shape.id}`).join(", "),
      } })
    : "";
  const baseText = (() => {
    if (reference.overlaySelection && reference.targetType.startsWith("overlayShape:")) {
      return getReferenceDisplayLabel(reference, tAiNow, tEditorNow);
    }

    if (reference.kind === "textSelection") {
      return reference.selectedText || reference.excerpt;
    }

    if (reference.kind === "inlineMath") {
      return reference.tex ? `$${reference.tex}$` : reference.excerpt;
    }

    return reference.excerpt;
  })();

  return [baseText, overlayText].filter(Boolean).join("\n");
}

function blockToPreviewText(block: EditableBlock): string {
  if (block.type === "section") {
    return block.title;
  }

  if (block.type === "heading" || block.type === "paragraph") {
    return inlineNodesToPreviewText(block.children);
  }

  if (block.type === "list") {
    return listToPreviewText(block.items);
  }

  if (block.type === "listItem") {
    return listItemToPreviewText(block);
  }

  if (block.type === "layoutSection") {
    return block.children.map(blockToPreviewText).filter(Boolean).join("\n");
  }

  if (block.type === "boxBlock") {
    return [
      inlineNodesToPreviewText(block.title ?? []),
      boxBlockChildrenToPreviewText(tEditorNow("block.paragraph"), block.blocks),
    ].filter(Boolean).join("\n");
  }

  if (block.type === "divider") {
    return "";
  }

  if (block.type === "quote") {
    return block.blocks.map(blockToPreviewText).filter(Boolean).join("\n");
  }

  if (block.type === "codeBlock") {
    return inlineNodesToPreviewText(block.children);
  }

  const answer = block.answer
    ? tAiNow("panel.answerLine", { replace: { answer: block.answer.expected } })
    : "";
  return [
    richBlocksToPreviewText(tEditorNow("block.problemLead"), block.lead),
    richBlocksToPreviewText(tEditorNow("block.problemPrompt"), block.prompt),
    answer,
    richBlocksToPreviewText(tEditorNow("block.problemHints"), block.hints),
    richBlocksToPreviewText(tEditorNow("block.problemSolution"), block.solution),
  ]
    .filter(Boolean)
    .join("\n");
}

function richBlocksToPreviewText(label: string, blocks: ProblemAreaBlock[]): string {
  if (blocks.length === 0) {
    return "";
  }

  return `${label}:\n${blocks.map(problemAreaBlockToPreviewText).join("\n")}`;
}

function problemAreaBlockToPreviewText(block: ProblemAreaBlock): string {
  if (block.type === "layoutSection") {
    return block.children.map(layoutSectionChildToPreviewText).filter(Boolean).join("\n");
  }
  if (block.type === "boxBlock" || block.type === "quote" || block.type === "codeBlock") {
    return blockToPreviewText(block);
  }
  if (block.type === "divider") {
    return "";
  }
  return richBlockToPreviewText(block);
}

function boxBlockChildrenToPreviewText(label: string, blocks: BoxBlockChildBlock[]): string {
  if (blocks.length === 0) {
    return "";
  }

  return `${label}:\n${blocks.map(boxBlockChildToPreviewText).filter(Boolean).join("\n")}`;
}

function boxBlockChildToPreviewText(block: BoxBlockChildBlock): string {
  if (block.type === "problem") return blockToPreviewText(block);
  if (block.type === "layoutSection") {
    return block.children.map(layoutSectionChildToPreviewText).filter(Boolean).join("\n");
  }
  return layoutSectionChildToPreviewText(block);
}

function layoutSectionChildToPreviewText(block: LayoutSectionChildBlock): string {
  if (block.type === "section") {
    return block.title;
  }
  if (block.type === "divider") {
    return "";
  }
  if (block.type === "boxBlock" || block.type === "quote" || block.type === "codeBlock") {
    return blockToPreviewText(block);
  }
  return richBlockToPreviewText(block);
}

function richBlockToPreviewText(block: RichBlock): string {
  if (block.type === "list") {
    return listToPreviewText(block.items);
  }

  return inlineNodesToPreviewText(block.children);
}

function listToPreviewText(items: ListItemNode[], depth = 0): string {
  return items.map((item) => {
    const marker = `${"  ".repeat(depth)}- `;
    const nested = (item.nested ?? []).map((list) => listToPreviewText(list.items, depth + 1)).filter(Boolean);
    return [marker + listItemToPreviewText(item), ...nested].filter(Boolean).join("\n");
  }).join("\n");
}

function listItemToPreviewText(item: ListItemNode): string {
  return inlineNodesToPreviewText(item.children);
}

function inlineNodesToPreviewText(children: InlineNode[]): string {
  return children
    .map((child) => {
      if (child.type === "text") {
        return child.text;
      }
      return `$${child.tex}$`;
    })
    .join("");
}

export function getActiveSigmaDocMentionQuery(value: string, cursor: number): ActiveMentionQuery | null {
  if (cursor < 0 || cursor > value.length) {
    return null;
  }

  const beforeCursor = value.slice(0, cursor);
  const lineStart = Math.max(beforeCursor.lastIndexOf("\n") + 1, 0);
  const atIndex = beforeCursor.lastIndexOf("@");
  if (atIndex < lineStart) {
    return null;
  }

  const query = value.slice(atIndex + 1, cursor);
  if (/[\t\r\n]/.test(query) || /\s$/.test(query)) {
    return null;
  }

  return {
    start: atIndex,
    end: cursor,
    query,
  };
}

export function getActiveAiResourceSlashQuery(value: string, cursor: number): ActiveSlashQuery | null {
  if (cursor < 0 || cursor > value.length) {
    return null;
  }

  const beforeCursor = value.slice(0, cursor);
  const lineStart = Math.max(beforeCursor.lastIndexOf("\n") + 1, 0);
  const slashIndex = beforeCursor.lastIndexOf("/");
  if (slashIndex < lineStart) {
    return null;
  }
  if (slashIndex > 0 && !/[\s(「『（]$/.test(value.slice(0, slashIndex))) {
    return null;
  }

  const query = value.slice(slashIndex + 1, cursor);
  if (/[\t\r\n]/.test(query) || /\s$/.test(query)) {
    return null;
  }

  return {
    start: slashIndex,
    end: cursor,
    query,
  };
}

// @/ の候補選択は入力欄にタイトルを挿入せず、トリガー文字列そのものを削除してチップだけ
// 残す (チップと入力欄テキストの二重管理をやめるため)。ActiveMentionQuery/ActiveSlashQuery
// はどちらも `{ start, end }` のトリガー範囲を持つので、共通の1関数で両方に使える。
export function removeActiveTriggerRange(value: string, range: { start: number; end: number }): string {
  const before = value.slice(0, range.start);
  const after = value.slice(range.end);
  // トリガーの手前にあった区切り空白は、後ろが空/空白/改行で始まる (=もう区切りが要らない)
  // なら畳む。両側とも空白付きの場合(前後の連結)にも、末尾で消える場合(afterが空)にも効く。
  if (before.endsWith(" ") && (after.length === 0 || after.startsWith(" ") || after.startsWith("\n"))) {
    return `${before.slice(0, -1)}${after}`;
  }
  // 行頭のトリガーを消したら、後ろに残った区切り空白だけが浮くので落とす。
  if (before.length === 0 && after.startsWith(" ")) {
    return after.slice(1);
  }
  return `${before}${after}`;
}

export function filterAiResourceSlashCandidates({
  resources,
  query,
  selectedIds,
  provider,
  translate,
}: {
  resources: DesktopAiResourceManifestEntry[];
  query: string;
  selectedIds: string[];
  provider: AiProvider;
  translate?: Translate<"ai">;
}): DesktopAiResourceManifestEntry[] {
  const selected = new Set(selectedIds);
  const providerKey = toAiResourceProvider(provider);
  const normalizedQuery = query.trim().toLowerCase();
  return resources
    .filter((resource) => resource.enabled && resource.providers.includes(providerKey) && !selected.has(resource.id))
    .filter((resource) => {
      if (!normalizedQuery) {
        return true;
      }
      const display = translate ? resolveAiResourceDisplayMetadata(resource, translate) : resource;
      const text = [
        resource.title,
        resource.description,
        ...resource.tags,
        display.title,
        display.description,
        ...display.tags,
        resource.sourcePath,
      ].join(" ").toLowerCase();
      return text.includes(normalizedQuery);
    })
    .slice(0, 8);
}

/** スキルのトグル選択: 選択済みなら外し、そうでなければ追加する。`/`スキルポップオーバー
 * (常に追加のみ) と統一ピッカー (トグル) の両方で共有するので `addOnly` で分岐する。 */
export function toggleAiResourceSelection(
  current: string[],
  resourceId: string,
  options: { addOnly?: boolean } = {},
): string[] {
  if (!current.includes(resourceId)) {
    return [...current, resourceId];
  }
  return options.addOnly ? current : current.filter((id) => id !== resourceId);
}

/** 統一ピッカー/@メンションの「追加」側: 既に同じ fileId があれば何もせず、なければ上限
 * (cap) でクランプして追加する。 */
export function upsertMentionedDocument(
  current: AiEditMentionedDocumentContext[],
  next: AiEditMentionedDocumentContext,
  cap: number,
): AiEditMentionedDocumentContext[] {
  if (current.some((item) => item.fileId === next.fileId)) {
    return current;
  }
  return [...current, next].slice(0, cap);
}

/** 統一ピッカーの「解除」側: 指定した fileId のドキュメントを取り除く。 */
export function removeMentionedDocumentByFileId(
  current: AiEditMentionedDocumentContext[],
  fileId: string,
): AiEditMentionedDocumentContext[] {
  return current.filter((item) => item.fileId !== fileId);
}

export function filterSigmaDocMentionCandidates({
  files,
  query,
  currentFileId,
  mentionedFileIds,
}: {
  files: DesktopDocumentMetadata[];
  query: string;
  currentFileId: string;
  mentionedFileIds: string[];
}): DesktopDocumentMetadata[] {
  const normalizedQuery = normalizeMentionSearchText(query);
  const mentioned = new Set(mentionedFileIds);
  return files
    .filter((file) => file.fileId !== currentFileId && !mentioned.has(file.fileId))
    .filter((file) => {
      if (!normalizedQuery) {
        return true;
      }
      return normalizeMentionSearchText(`${file.title} ${file.documentPath}`).includes(normalizedQuery);
    })
    .slice(0, MAX_SIGMA_DOC_MENTION_CANDIDATES);
}

function normalizeMentionSearchText(value: string): string {
  return value.trim().toLowerCase();
}

export function createMentionedDocumentContext(
  metadata: DesktopDocumentMetadata,
  document: SigmaDocument,
): AiEditMentionedDocumentContext {
  return {
    id: createMentionedDocumentId(metadata.fileId),
    fileId: metadata.fileId,
    title: metadata.title,
    documentPath: metadata.documentPath ?? "",
    revision: metadata.revision,
    excerpt: createMentionedDocumentExcerpt(document),
    document,
  };
}

function createMentionedDocumentExcerpt(document: SigmaDocument): string {
  const title = `title: ${resolveDocumentTitle(document)}`;
  const body = document.content
    .slice(0, 8)
    .map((block) => blockToPreviewText(block))
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
  const excerpt = [title, body].filter(Boolean).join("\n");
  return excerpt.length > MAX_MENTIONED_DOCUMENT_EXCERPT
    ? `${excerpt.slice(0, MAX_MENTIONED_DOCUMENT_EXCERPT)}...`
    : excerpt;
}

function createMentionedDocumentId(fileId: string): string {
  return `sigma-doc-${fileId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

