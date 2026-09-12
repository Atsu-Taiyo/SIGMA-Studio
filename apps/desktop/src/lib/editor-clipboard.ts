import { createTranslator, getAppLocale } from "@/lib/i18n";
import { createId } from "@/lib/id";
import { normalizeOverlayAssetSource } from "@/features/document/asset-source";
import { SigmaBlockSchema } from "@/lib/sigma-doc-schema";
import { isTextFlowBlock } from "@/features/text-editing";
import { inlineNodesToPlainText } from "@/lib/tiptap-adapter";
import {
  listItemContinuationInlineNodes,
  isValidOverlaySnapshot,
  normalizeOrderedListMarkerStyle,
  normalizeOverlaySnapshot,
  type OverlayAsset,
  type OverlayPoint,
  type OverlayShape,
  type OverlayTextBlock,
  type SigmaTableSpec,
  PROBLEM_AREA_ORDER,
  type BoxBlockChildBlock,
  type BoxBlockNode,
  type CodeBlockNode,
  type DividerNode,
  type QuoteBlockNode,
  type SigmaBlock,
  type Graph2DSpec,
  type HeadingNode,
  type InlineNode,
  type LayoutSectionChildBlock,
  type LayoutSectionNode,
  type ListNode,
  type ParagraphNode,
  type ProblemAreaBlock,
  type RichBlock,
  type SectionNode,
} from "@/features/document";

export const EDITOR_CLIPBOARD_MIME = "application/x-sigma-studio";
export const EDITOR_TEXT_SLICE_MIME = "application/x-sigma-studio-text-slice";
const EDITOR_CLIPBOARD_TYPE = "application/sigma-studio";
const EDITOR_CLIPBOARD_VERSION = 1;
const EDITOR_CLIPBOARD_ATTRIBUTE = "data-sigma-studio-clipboard";
const EDITOR_CLIPBOARD_PAYLOAD_ATTRIBUTE = "data-sigma-studio-payload";
let localEditorClipboardPayload: EditorClipboardPayload | null = null;

export type ClipboardTextFlowBlock =
  | SectionNode
  | HeadingNode
  | ParagraphNode
  | ListNode
  | QuoteBlockNode
  | CodeBlockNode
  | DividerNode
  | BoxBlockNode
  | LayoutSectionNode
  | Extract<SigmaBlock, { type: "problem" }>;
export type ClipboardDocumentBlock = SigmaBlock;

export type EditorClipboardPayload =
  | {
      type: typeof EDITOR_CLIPBOARD_TYPE;
      version: typeof EDITOR_CLIPBOARD_VERSION;
      kind: "inlineMath";
      tex: string;
    }
  | {
      type: typeof EDITOR_CLIPBOARD_TYPE;
      version: typeof EDITOR_CLIPBOARD_VERSION;
      kind: "tiptapSlice";
      slice: unknown;
      text: string;
    }
  | {
      type: typeof EDITOR_CLIPBOARD_TYPE;
      version: typeof EDITOR_CLIPBOARD_VERSION;
      kind: "textFlowBlocks";
      blocks: ClipboardTextFlowBlock[];
    }
  | {
      type: typeof EDITOR_CLIPBOARD_TYPE;
      version: typeof EDITOR_CLIPBOARD_VERSION;
      kind: "documentBlocks";
      blocks: ClipboardDocumentBlock[];
    }
  | {
      type: typeof EDITOR_CLIPBOARD_TYPE;
      version: typeof EDITOR_CLIPBOARD_VERSION;
      kind: "overlayShapes";
      shapes: OverlayShape[];
      assets: Record<string, OverlayAsset>;
      /**
       * Document the copy was taken from, so a paste can tell "same document" from "another tab".
       * Optional: clipboard payloads written by older builds simply do not have it, and a missing
       * value is treated as "not the same document" (the conservative side).
       */
      sourceDocId?: string;
    }
  | {
      type: typeof EDITOR_CLIPBOARD_TYPE;
      version: typeof EDITOR_CLIPBOARD_VERSION;
      /** 本文範囲選択と図形選択が同時に立っている混在選択のコピー。overlayShapes に本文 slice を足したもの。 */
      kind: "textAndShapes";
      text: { slice: unknown; text: string };
      shapes: OverlayShape[];
      assets: Record<string, OverlayAsset>;
      sourceDocId?: string;
    };

export function createInlineMathClipboardPayload(tex: string): Extract<EditorClipboardPayload, { kind: "inlineMath" }> {
  return {
    type: EDITOR_CLIPBOARD_TYPE,
    version: EDITOR_CLIPBOARD_VERSION,
    kind: "inlineMath",
    tex,
  };
}

export function createTiptapSliceClipboardPayload(
  slice: unknown,
  text: string,
): Extract<EditorClipboardPayload, { kind: "tiptapSlice" }> {
  return {
    type: EDITOR_CLIPBOARD_TYPE,
    version: EDITOR_CLIPBOARD_VERSION,
    kind: "tiptapSlice",
    slice,
    text,
  };
}

export function createTextFlowClipboardPayload(
  blocks: ClipboardTextFlowBlock[],
): Extract<EditorClipboardPayload, { kind: "textFlowBlocks" }> {
  return {
    type: EDITOR_CLIPBOARD_TYPE,
    version: EDITOR_CLIPBOARD_VERSION,
    kind: "textFlowBlocks",
    blocks: structuredClone(blocks),
  };
}

export function createDocumentBlocksClipboardPayload(
  blocks: ClipboardDocumentBlock[],
): Extract<EditorClipboardPayload, { kind: "documentBlocks" }> {
  return {
    type: EDITOR_CLIPBOARD_TYPE,
    version: EDITOR_CLIPBOARD_VERSION,
    kind: "documentBlocks",
    blocks: structuredClone(blocks),
  };
}

export function createOverlayClipboardPayload(
  shapes: OverlayShape[],
  assets: Record<string, OverlayAsset>,
  sourceDocId?: string,
): Extract<EditorClipboardPayload, { kind: "overlayShapes" }> {
  return createOverlayShapeFields(shapes, assets, sourceDocId, "overlayShapes");
}

export function createTextAndShapesClipboardPayload(
  text: { slice: unknown; text: string },
  shapes: OverlayShape[],
  assets: Record<string, OverlayAsset>,
  sourceDocId?: string,
): Extract<EditorClipboardPayload, { kind: "textAndShapes" }> {
  return {
    ...createOverlayShapeFields(shapes, assets, sourceDocId, "textAndShapes"),
    text: structuredClone(text),
  };
}

/**
 * コピーした本文 slice が連れているブロック id。
 *
 * 貼り付け側はこの id を「貼り付けで生まれた新しい id」へ読み替える (`anchorBlockIdMap`) ので、
 * ここに載っているブロックにぶら下がった図形だけが、貼り付け先を基準に置き直せる。コピー時に
 * 図形のアンカーをこの集合の中へ寄せておくのはそのため。
 */
export function collectClipboardSliceBlockIds(slice: unknown): string[] {
  const ids: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const node = value as { attrs?: unknown; content?: unknown };
    if (node.attrs && typeof node.attrs === "object") {
      const blockId = (node.attrs as { sigmaDocId?: unknown }).sigmaDocId;
      if (typeof blockId === "string" && blockId) {
        ids.push(blockId);
      }
    }
    visit(node.content);
  };

  const root = slice && typeof slice === "object" ? (slice as { content?: unknown }).content : null;
  visit(root ?? slice);
  return [...new Set(ids)];
}

function createOverlayShapeFields<K extends "overlayShapes" | "textAndShapes">(
  shapes: OverlayShape[],
  assets: Record<string, OverlayAsset>,
  sourceDocId: string | undefined,
  kind: K,
): Extract<EditorClipboardPayload, { kind: K }> {
  const copiedShapes = structuredClone(shapes);
  const assetIds = new Set(
    copiedShapes.flatMap((shape) => {
      if (shape.type === "image") {
        return [shape.props.assetId];
      }
      if (shape.type === "graph3dShape" && shape.props.previewAssetId) {
        return [shape.props.previewAssetId];
      }
      return [];
    }),
  );
  const copiedAssets = Object.fromEntries(
    [...assetIds]
      .map((assetId) => assets[assetId])
      .filter((asset): asset is OverlayAsset => Boolean(asset))
      .map((asset) => [asset.id, structuredClone(asset)]),
  );

  return {
    type: EDITOR_CLIPBOARD_TYPE,
    version: EDITOR_CLIPBOARD_VERSION,
    kind,
    shapes: copiedShapes,
    assets: copiedAssets,
    ...(sourceDocId ? { sourceDocId } : {}),
  } as Extract<EditorClipboardPayload, { kind: K }>;
}

export function writeEditorClipboardData(
  dataTransfer: DataTransfer,
  payload: EditorClipboardPayload,
  options: { html?: string } = {},
): void {
  setLocalEditorClipboardPayload(payload);
  const serialized = serializeEditorClipboardPayload(payload);
  try {
    dataTransfer.setData(EDITOR_CLIPBOARD_MIME, serialized);
  } catch {
    // Some browser clipboard paths reject custom MIME types; the HTML payload is the durable fallback.
  }
  dataTransfer.setData("text/html", createEditorClipboardHtml(payload, options.html));
  dataTransfer.setData("text/plain", getEditorClipboardPlainText(payload));
}

/**
 * 本文エディタが範囲選択をコピーするたびに、PM の text/html には触らず slice JSON を
 * private MIME に添える。読むのは同じ copy イベント内の overlay の混在コピーだけで、
 * OS クリップボードのラウンドトリップには依存しない。
 */
export function writeTextSliceClipboardData(dataTransfer: DataTransfer, slice: unknown, text: string): void {
  try {
    dataTransfer.setData(EDITOR_TEXT_SLICE_MIME, JSON.stringify({ slice, text }));
  } catch {
    // Chromium 以外の clipboard 実装で private MIME が拒否されても通常コピーは維持する。
  }
}

/**
 * 切り取り中の本文 slice。コピーと同じ private MIME では届かない:
 *
 * - ProseMirror の cut ハンドラは書き込む前に `clipboardData.clearData()` を呼ぶので、
 *   その前に置いた private MIME は消える。
 * - PM は同じハンドラの中で本文を消すので、window まで上がってくる頃には `event.target` が
 *   DOM から外れていることがあり、「本文の切り取りか」を DOM から判定できない。
 *
 * そこで本文エディタが、同じイベントの中だけ生きる印としてここへ置く。次のマイクロタスクで
 * 自分で消えるので、イベントをまたいで残ることはない。
 */
let pendingBodyTextCut: BodyTextCut & { event: Event } | null = null;

interface BodyTextCut {
  slice: unknown;
  text: string;
  /**
   * 本文側が鋳造した undo のコアレスキー (混在切り取り)。図形側はこれを受け取って
   * 同じキーで保存し、⌘Z 1 回で本文と図形が同時に戻る
   * (`text-flow/clipboard-history-group.ts`)。
   */
  historyGroup?: string;
}

export function markBodyTextCut(event: Event, cut: BodyTextCut): void {
  pendingBodyTextCut = { event, ...cut };
}

/**
 * 同じ cut イベントで置かれた印だけを返す。イベントで縛るのは、タイマーで消すと
 * 「リスナーとリスナーの間で走るマイクロタスク」に消されてしまい、window まで届かないため。
 */
export function takeBodyTextCut(event: Event): BodyTextCut | null {
  const pending = pendingBodyTextCut;
  pendingBodyTextCut = null;
  return pending?.event === event
    ? { slice: pending.slice, text: pending.text, historyGroup: pending.historyGroup }
    : null;
}

export function readTextSliceClipboardData(dataTransfer: DataTransfer): { slice: unknown; text: string } | null {
  try {
    const parsed: unknown = JSON.parse(dataTransfer.getData(EDITOR_TEXT_SLICE_MIME));
    return isRecord(parsed) && isRecord(parsed.slice) && typeof parsed.text === "string"
      ? { slice: parsed.slice, text: parsed.text }
      : null;
  } catch {
    return null;
  }
}

export function readEditorClipboardPayload(dataTransfer: DataTransfer): EditorClipboardPayload | null {
  const customPayload = parseEditorClipboardPayload(dataTransfer.getData(EDITOR_CLIPBOARD_MIME));
  if (customPayload) {
    return customPayload;
  }

  return parseEditorClipboardHtml(dataTransfer.getData("text/html"));
}

export function getLocalEditorClipboardPayload(): EditorClipboardPayload | null {
  return localEditorClipboardPayload ? structuredClone(localEditorClipboardPayload) : null;
}

export async function writeEditorPayloadToSystemClipboard(payload: EditorClipboardPayload): Promise<boolean> {
  setLocalEditorClipboardPayload(payload);

  if (typeof document !== "undefined" && typeof document.execCommand === "function") {
    let copied = false;
    const handleCopy = (event: ClipboardEvent) => {
      if (!event.clipboardData) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      writeEditorClipboardData(event.clipboardData, payload);
      copied = true;
    };

    document.addEventListener("copy", handleCopy, true);
    try {
      document.execCommand("copy");
    } finally {
      document.removeEventListener("copy", handleCopy, true);
    }

    if (copied) {
      return true;
    }
  }

  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.write === "function" &&
    typeof ClipboardItem !== "undefined"
  ) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([createEditorClipboardHtml(payload)], { type: "text/html" }),
          "text/plain": new Blob([getEditorClipboardPlainText(payload)], { type: "text/plain" }),
        }),
      ]);
      return true;
    } catch {
      return true;
    }
  }

  return true;
}

export function serializeEditorClipboardPayload(payload: EditorClipboardPayload): string {
  return JSON.stringify(payload);
}

function setLocalEditorClipboardPayload(payload: EditorClipboardPayload): void {
  localEditorClipboardPayload = structuredClone(payload);
}

export function parseEditorClipboardPayload(serialized: string): EditorClipboardPayload | null {
  if (!serialized) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || parsed.type !== EDITOR_CLIPBOARD_TYPE || parsed.version !== EDITOR_CLIPBOARD_VERSION) {
    return null;
  }

  if (parsed.kind === "inlineMath" && typeof parsed.tex === "string") {
    return parsed as EditorClipboardPayload;
  }

  if (parsed.kind === "tiptapSlice" && typeof parsed.text === "string" && isRecord(parsed.slice)) {
    return parsed as EditorClipboardPayload;
  }

  if (parsed.kind === "textFlowBlocks" && Array.isArray(parsed.blocks)) {
    const blocks = parseClipboardBlocks(parsed.blocks, isTextFlowClipboardBlock);
    return blocks ? ({ ...parsed, blocks } as EditorClipboardPayload) : null;
  }

  if (parsed.kind === "documentBlocks" && Array.isArray(parsed.blocks)) {
    const blocks = parseClipboardBlocks(parsed.blocks);
    return blocks ? ({ ...parsed, blocks } as EditorClipboardPayload) : null;
  }

  if (parsed.kind === "overlayShapes") {
    return parseOverlayShapeFields(parsed);
  }

  if (
    parsed.kind === "textAndShapes"
    && isRecord(parsed.text)
    && isRecord(parsed.text.slice)
    && typeof parsed.text.text === "string"
  ) {
    return parseOverlayShapeFields(parsed);
  }

  return null;
}

function parseOverlayShapeFields(parsed: Record<string, unknown>): EditorClipboardPayload | null {
  if (!Array.isArray(parsed.shapes) || !isRecord(parsed.assets)) {
    return null;
  }
  const snapshot = { version: 1, shapes: parsed.shapes, assets: parsed.assets };
  if (!isValidOverlaySnapshot(snapshot)) {
    return null;
  }
  return {
    ...parsed,
    shapes: snapshot.shapes,
    // 貼り付けは正規化境界を通らない 4 つ目の入口。任意の Web ページが書ける
    // text/html から `file:///…` asset を差し込めないよう、文書と同じ正規化を使う。
    assets: Object.fromEntries(Object.entries(snapshot.assets).flatMap(([assetId, asset]) => {
      const src = normalizeOverlayAssetSource(asset.props.src);
      return src === null ? [] : [[assetId, { ...asset, props: { ...asset.props, src } }] as const];
    })),
  } as EditorClipboardPayload;
}

export function createEditorClipboardHtml(payload: EditorClipboardPayload, innerHtml = ""): string {
  return `<div ${EDITOR_CLIPBOARD_ATTRIBUTE}="true" ${EDITOR_CLIPBOARD_PAYLOAD_ATTRIBUTE}="${escapeHtmlAttribute(serializeEditorClipboardPayload(payload))}">${innerHtml}</div>`;
}

/**
 * text/html が payload div (`createEditorClipboardHtml`) のとき、その中の可視 HTML を
 * 取り出す。跨ぎ選択のコピーは text/html を payload div で書くため、混在コピー
 * (textAndShapes) へ包み直すときそのまま入れ子にすると payload div が二重になる。
 * payload でない HTML (PM が書いた素の HTML) はそのまま返す。
 */
export function extractVisibleEditorClipboardHtml(html: string): string {
  if (!html || parseEditorClipboardHtml(html) === null) {
    return html;
  }
  if (typeof DOMParser === "function") {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const element = doc.querySelector(`[${EDITOR_CLIPBOARD_ATTRIBUTE}]`);
    if (element) {
      return element.innerHTML;
    }
  }
  return "";
}

export function parseEditorClipboardHtml(html: string): EditorClipboardPayload | null {
  if (!html) {
    return null;
  }

  if (typeof DOMParser === "function") {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const element = doc.querySelector(`[${EDITOR_CLIPBOARD_ATTRIBUTE}]`);
    return parseEditorClipboardPayload(element?.getAttribute(EDITOR_CLIPBOARD_PAYLOAD_ATTRIBUTE) ?? element?.textContent ?? "");
  }

  const attributeMatch = html.match(new RegExp(`${EDITOR_CLIPBOARD_PAYLOAD_ATTRIBUTE}="([^"]*)"`));
  if (attributeMatch) {
    return parseEditorClipboardPayload(unescapeHtmlAttribute(attributeMatch[1]));
  }

  const match = html.match(new RegExp(`<[^>]*${EDITOR_CLIPBOARD_ATTRIBUTE}[^>]*>([\\s\\S]*?)<\\/[^>]+>`));
  return parseEditorClipboardPayload(match ? unescapeHtml(match[1]) : "");
}

export function getEditorClipboardPlainText(payload: EditorClipboardPayload): string {
  if (payload.kind === "inlineMath") {
    return `$${payload.tex}$`;
  }

  if (payload.kind === "tiptapSlice") {
    return payload.text;
  }

  if (payload.kind === "textAndShapes") {
    return payload.text.text;
  }

  if (payload.kind === "textFlowBlocks") {
    return payload.blocks.map(textFlowBlockToPlainText).join("\n");
  }

  if (payload.kind === "documentBlocks") {
    return payload.blocks.map(documentBlockToPlainText).join("\n");
  }

  // 図形だけをコピーしたときの**システムクリップボードの本文**。Word や
  // メールに貼られる文字列なので、コピーした時点の UI 言語で書く。
  return createTranslator(getAppLocale(), "editor")(
    "material.summaryShapes",
    { shapes: payload.shapes.length },
  );
}

export function cloneTextFlowBlocksForPaste(blocks: ClipboardTextFlowBlock[]): ClipboardTextFlowBlock[] {
  return blocks.map(cloneBlockForPaste);
}

export function cloneDocumentBlocksForPaste(blocks: ClipboardDocumentBlock[]): ClipboardDocumentBlock[] {
  return blocks.map(cloneBlockForPaste);
}

type GraphShapeProps = Extract<OverlayShape, { type: "graph2dShape" }>["props"];

/**
 * Point a pasted graph at the pasted copies of its label shapes.
 *
 * The labels are sibling `text` shapes the graph owns by id. Ids that were not part of the copy
 * are removed rather than left dangling — the graph then simply has no label for that slot.
 *
 * Both halves of each entry are rewritten. The value is the label's shape id, which the paste
 * regenerates; the *key* is the thing inside the spec the label belongs to — a point, an
 * annotation, a curve — and the paste regenerates those too (`cloneGraphSpecForPaste`), so a copy
 * that only rewrote the values would point at the right shapes under names the pasted spec no
 * longer has. The lookups drop those entries (`getExistingGraphPointLabelTextShapeIdsByPointId`
 * requires the point to still exist), and the duplicated graph would quietly disown its point and
 * annotation labels: still drawn, still following, but no longer part of the graph for editing,
 * deletion or an AI edit lock.
 *
 * Only the three spec-keyed records get that key rewrite. Axis labels are keyed by the fixed
 * `"x"`/`"y"`/`"origin"` and must be left alone: spec ids are not always app-generated (an AI tool
 * passes an author's `curve.id` straight through), so a graph with a curve literally named `x`
 * would otherwise have its *axis* key renamed to a generated id — disowning the axis label, and
 * failing validation on reopen because the key is no longer one of the three.
 */
function remapGraphLabelOwnership(
  props: GraphShapeProps,
  shapeIdMap: Map<string, string>,
  specIdMap: Map<string, string>,
): void {
  const remapRecord = <T extends Record<string, string>>(
    record: T | undefined,
    keyMap: Map<string, string> | null,
  ): T | undefined => {
    if (!record) {
      return undefined;
    }
    const next = Object.fromEntries(
      Object.entries(record)
        .map(([key, shapeId]) => [keyMap?.get(key) ?? key, shapeIdMap.get(shapeId)])
        .filter((entry): entry is [string, string] => Boolean(entry[1])),
    ) as T;
    return Object.keys(next).length > 0 ? next : undefined;
  };

  const axisLabels = remapRecord(props.axisLabelTextShapeIds as Record<string, string> | undefined, null);
  const pointLabels = remapRecord(props.pointLabelTextShapeIdsByPointId, specIdMap);
  const annotationLabels = remapRecord(props.annotationTextShapeIdsByAnnotationId, specIdMap);
  const curveLabels = remapRecord(props.labelTextShapeIdsByCurveId, specIdMap);
  const labelIds = props.labelTextShapeIds
    ?.map((shapeId) => shapeIdMap.get(shapeId))
    .filter((shapeId): shapeId is string => Boolean(shapeId));

  assignOrDelete(props, "axisLabelTextShapeIds", axisLabels);
  assignOrDelete(props, "pointLabelTextShapeIdsByPointId", pointLabels);
  assignOrDelete(props, "annotationTextShapeIdsByAnnotationId", annotationLabels);
  assignOrDelete(props, "labelTextShapeIdsByCurveId", curveLabels);
  assignOrDelete(props, "labelTextShapeIds", labelIds && labelIds.length > 0 ? labelIds : undefined);
}

function assignOrDelete<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value === undefined) {
    delete target[key];
  } else {
    target[key] = value;
  }
}

/** Bytes the pasted copy carries on its own, with no dependency on the source file's storage. */
function isSelfContainedAssetSource(src: string): boolean {
  return src.startsWith("data:") || src.startsWith("blob:")
    || src.startsWith("http://") || src.startsWith("https://");
}

export interface CloneOverlayShapesOptions {
  /** コピー元ブロック id → 貼り付けで生まれたブロック id。 */
  anchorBlockIdMap?: Readonly<Record<string, string>>;
  /**
   * Turn `anchor: { type: "block" }` into a page anchor.
   *
   * Only for a paste into a *different* document, where the anchored block does not exist and
   * guessing a replacement would move the shape somewhere the author never put it. Off by default:
   * same-document paste must keep its anchors, and `materials.ts` clones first and remaps the block
   * ids itself afterwards — dropping them here would stop material figures from following the text.
   */
  dropBlockAnchors?: boolean;
}

export function cloneOverlayShapesForPaste(
  payload: Extract<EditorClipboardPayload, { kind: "overlayShapes" }>,
  offset: OverlayPoint = { x: 20, y: 20 },
  options: CloneOverlayShapesOptions = {},
): { shapes: OverlayShape[]; assets: Record<string, OverlayAsset> } {
  const normalizedPayload = payload.shapes.some(
    (shape) => shape.type === "graph2dShape" && shape.props.boundsMode !== "plot",
  )
    ? normalizeOverlaySnapshot({ version: 1, shapes: payload.shapes, assets: payload.assets })
    : { version: 1 as const, shapes: payload.shapes, assets: payload.assets };
  const assetIdMap = new Map<string, string>();
  const shapeIdMap = new Map<string, string>();
  const groupIdMap = new Map<string, string>();
  const assets = Object.fromEntries(
    Object.values(normalizedPayload.assets).map((asset) => {
      const nextId = createId("overlay_asset");
      assetIdMap.set(asset.id, nextId);
      const next: OverlayAsset = { ...structuredClone(asset), id: nextId };
      if (options.dropBlockAnchors && isSelfContainedAssetSource(next.props.src)) {
        // `storage` points at the *source* file's uploaded copy, so carrying it into another
        // document leaves the new asset claiming a blob it does not own. Only safe to drop when
        // the bytes travel inline in `src`; when `src` is itself a storage URL, dropping the
        // reference would leave an image with no way to resolve at all, which is strictly worse.
        delete next.props.storage;
      }
      return [nextId, next];
    }),
  );
  for (const shape of normalizedPayload.shapes) {
    shapeIdMap.set(shape.id, createId(shape.type === "group" ? "overlay_group" : "overlay_shape"));
  }

  // A chart may be cloned before the table it references, so the re-pointing is a second pass over
  // the finished clones rather than something the per-shape clone can do on its own.
  const tableTrackIdMaps = new Map<string, ReadonlyMap<string, string>>();
  const shapes = normalizedPayload.shapes.map((shape) => (
    cloneOverlayShapeForPaste(shape, assetIdMap, shapeIdMap, groupIdMap, offset, tableTrackIdMaps, options)
  ));
  for (const shape of shapes) {
    if (shape.type === "chartShape") {
      // `dropBlockAnchors` is the existing "pasting into a different document" signal
      // (`paste-shapes.ts` sets it as `!isSameDocument`).
      remapChartForPaste(shape.props, shapeIdMap, tableTrackIdMaps, Boolean(options.dropBlockAnchors));
    }
  }
  return { shapes, assets };
}

function cloneOverlayShapeForPaste(
  shape: OverlayShape,
  assetIdMap: Map<string, string>,
  shapeIdMap: Map<string, string>,
  groupIdMap: Map<string, string>,
  offset: OverlayPoint,
  tableTrackIdMaps: Map<string, ReadonlyMap<string, string>>,
  options: CloneOverlayShapesOptions = {},
): OverlayShape {
  const next = {
    ...structuredClone(shape),
    id: shapeIdMap.get(shape.id) ?? createId(shape.type === "group" ? "overlay_group" : "overlay_shape"),
    x: shape.x + offset.x,
    y: shape.y + offset.y,
  } as OverlayShape;

  const blockAnchor = shape.anchor?.type === "block" ? shape.anchor : null;
  const mappedBlockId = blockAnchor ? options.anchorBlockIdMap?.[blockAnchor.blockId] : undefined;
  if (mappedBlockId && blockAnchor) {
    next.anchor = { ...blockAnchor, blockId: mappedBlockId };
    next.x = shape.x;
    next.y = shape.y;
  }

  if (shape.parentId) {
    const nextParentId = shapeIdMap.get(shape.parentId);
    if (nextParentId) {
      next.parentId = nextParentId;
    } else {
      delete next.parentId;
    }
  }

  if (shape.anchor?.type === "shape") {
    const nextAnchorShapeId = shapeIdMap.get(shape.anchor.shapeId);
    if (nextAnchorShapeId) {
      next.anchor = { ...shape.anchor, shapeId: nextAnchorShapeId };
    } else {
      next.anchor = { type: "page" };
    }
  } else if (!mappedBlockId && options.dropBlockAnchors && shape.anchor?.type === "block") {
    next.anchor = { type: "page" };
  }

  if (next.type === "image") {
    next.props.assetId = assetIdMap.get(next.props.assetId) ?? next.props.assetId;
  } else if (next.type === "graph3dShape" && next.props.previewAssetId) {
    next.props.previewAssetId = assetIdMap.get(next.props.previewAssetId) ?? next.props.previewAssetId;
  } else if (next.type === "text" || next.type === "callout") {
    next.props.blocks = next.props.blocks.map(cloneOverlayTextBlockForPaste);
  } else if (next.type === "graph2dShape") {
    const cloned = cloneGraphSpecForPaste(next.props.spec);
    next.props.spec = cloned.spec;
    // A graph's labels are sibling text shapes it owns by id. When the copy carries those
    // siblings (select-all, or a whole-group copy) the ownership has to follow them to the new
    // ids, or the pasted graph disowns its own labels and re-creates duplicates on top of them.
    // Ids that were not part of the copy simply drop out.
    remapGraphLabelOwnership(next.props, shapeIdMap, cloned.specIdMap);
  } else if (next.type === "tableShape") {
    const cloned = cloneTableSpecForPaste(next.props.table);
    next.props.table = cloned.table;
    tableTrackIdMaps.set(shape.id, cloned.trackIdMap);
  }

  if (shape.groupId) {
    const nextGroupId = groupIdMap.get(shape.groupId) ?? createId("overlay_group");
    groupIdMap.set(shape.groupId, nextGroupId);
    next.groupId = nextGroupId;
  }

  return next;
}

export function toOverlayShapesClipboardPayload(
  payload: Extract<EditorClipboardPayload, { kind: "textAndShapes" }>,
): Extract<EditorClipboardPayload, { kind: "overlayShapes" }> {
  return {
    type: payload.type,
    version: payload.version,
    kind: "overlayShapes",
    shapes: payload.shapes,
    assets: payload.assets,
    ...(payload.sourceDocId ? { sourceDocId: payload.sourceDocId } : {}),
  };
}

function cloneInlineNodesForPaste(nodes: InlineNode[]): InlineNode[] {
  return nodes.map((node) => {
    const next = structuredClone(node);
    if ("id" in next) {
      next.id = createId(next.type);
    }
    return next;
  });
}

/**
 * A pasted block is a new block: every id below it is reissued, exactly like a pasted table's rows
 * and columns. Sharing an id with the block that was copied would make the two indistinguishable
 * to the Tiptap round trip and to anything that tracks a block across an edit.
 */
function cloneOverlayTextBlockForPaste(block: OverlayTextBlock): OverlayTextBlock {
  if (block.type === "list") {
    return {
      ...structuredClone(block),
      id: createId("list"),
      items: block.items.map((item) => ({
        ...structuredClone(item),
        id: createId("li"),
        children: cloneInlineNodesForPaste(item.children),
        ...(item.continuations === undefined ? {} : {
          continuations: item.continuations.map((child) => (
            child.type === "divider"
              ? { ...structuredClone(child), id: createId("divider") }
              : { ...structuredClone(child), id: createId("p"), children: cloneInlineNodesForPaste(child.children) }
          )),
        }),
        ...(item.nested === undefined ? {} : {
          nested: item.nested.map((nested) => cloneOverlayTextBlockForPaste(nested) as typeof nested),
        }),
      })),
    };
  }
  if (block.type === "quote") {
    return {
      ...structuredClone(block),
      id: createId("quote"),
      blocks: block.blocks.map((child) => (
        cloneOverlayTextBlockForPaste(child as OverlayTextBlock) as typeof child
      )),
    };
  }
  if (block.type === "codeBlock") {
    return {
      ...structuredClone(block),
      id: createId("code"),
      children: cloneInlineNodesForPaste(block.children),
    };
  }
  if (block.type === "divider") {
    return { ...structuredClone(block), id: createId("divider") };
  }
  return {
    ...structuredClone(block),
    id: createId(block.type === "heading" ? "h" : "p"),
    children: cloneInlineNodesForPaste(block.children),
  };
}

/**
 * Clones a graph's spec with fresh ids, and reports what each old id became.
 *
 * Every element still mints its own id, so a spec that arrived with two elements sharing an id
 * (ids are not always app-generated — an AI tool passes an author's id through verbatim) does not
 * come out of the paste with them merged. The map that goes back to the caller keeps the *first*
 * element to claim each old id, which is the one the ownership maps beside the spec can name:
 * they are keyed by that id and can only point at one label anyway.
 */
function cloneGraphSpecForPaste(spec: Graph2DSpec): { spec: Graph2DSpec; specIdMap: Map<string, string> } {
  const specIdMap = new Map<string, string>();
  const nextId = (id: string, prefix: string): string => {
    const next = createId(prefix);
    if (!specIdMap.has(id)) {
      specIdMap.set(id, next);
    }
    return next;
  };

  return {
    spec: {
      ...structuredClone(spec),
      curves: spec.curves.map((curve) => ({ ...curve, id: nextId(curve.id, "curve") })),
      points: spec.points?.map((point) => ({ ...point, id: nextId(point.id, "point") })),
      annotations: spec.annotations?.map((annotation) => ({
        ...annotation,
        id: nextId(annotation.id, "annotation"),
      })),
      fills: spec.fills?.map((fill) => ({ ...fill, id: nextId(fill.id, "fill") })),
    },
    specIdMap,
  };
}

/**
 * Clones a table for pasting, and reports the row/column ids it minted.
 *
 * The map is not bookkeeping — a chart keys `spec.seriesColors` and `dataSnapshot.series[].id` on
 * the table's own track ids, so regenerating them here without telling anyone leaves a pasted chart
 * pointing at ids that no longer exist and silently losing every author-chosen series colour.
 */
function cloneTableSpecForPaste(spec: SigmaTableSpec): {
  table: SigmaTableSpec;
  trackIdMap: Map<string, string>;
} {
  const rowIdMap = new Map(spec.rows.map((row) => [row.id, createId("table_row")]));
  const columnIdMap = new Map(spec.columns.map((column) => [column.id, createId("table_col")]));
  // Rows and columns share one lookup: which axis carries the series depends on the chart's
  // `orientation`, and the ids are unique across both.
  const trackIdMap = new Map([...rowIdMap, ...columnIdMap]);

  const table: SigmaTableSpec = {
    ...structuredClone(spec),
    columns: spec.columns.map((column) => ({
      ...structuredClone(column),
      id: columnIdMap.get(column.id) ?? createId("table_col"),
    })),
    rows: spec.rows.map((row) => ({
      ...structuredClone(row),
      id: rowIdMap.get(row.id) ?? createId("table_row"),
    })),
    cells: spec.cells.map((cell) => ({
      ...structuredClone(cell),
      id: createId("table_cell"),
      rowId: rowIdMap.get(cell.rowId) ?? cell.rowId,
      columnId: columnIdMap.get(cell.columnId) ?? cell.columnId,
      content: cell.content.map((content) => {
        if (content.type === "paragraph") {
          return {
            ...structuredClone(content),
            id: createId("table_p"),
            children: cloneInlineNodesForPaste(content.children),
          };
        }

        return {
          ...structuredClone(content),
          id: createId("table_trend"),
          label: content.label ? cloneInlineNodesForPaste(content.label) : undefined,
        };
      }),
    })),
  };

  return { table, trackIdMap };
}

/**
 * A series colour key is either a track id (bar/line/scatter) or `<trackId>:<label>` (a pie slice,
 * whose entity is the category). Both forms have to follow the table's regenerated ids.
 */
function remapChartSeriesColorKey(key: string, trackIdMap: ReadonlyMap<string, string>): string {
  const direct = trackIdMap.get(key);
  if (direct) {
    return direct;
  }
  const separator = key.indexOf(":");
  if (separator <= 0) {
    return key;
  }
  const mappedPrefix = trackIdMap.get(key.slice(0, separator));
  return mappedPrefix ? `${mappedPrefix}${key.slice(separator)}` : key;
}

/**
 * Re-points a pasted chart at the pasted copy of its table, or freezes it on its snapshot.
 *
 * Two things move, not one. The shape reference is the obvious half; the other is that the table's
 * row and column ids were regenerated by `cloneTableSpecForPaste`, and the chart keys its colours
 * and its series on those. Remapping only the shape id produces a chart that live-updates correctly
 * but has lost every colour the author picked.
 */
function remapChartForPaste(
  props: Extract<OverlayShape, { type: "chartShape" }>["props"],
  shapeIdMap: ReadonlyMap<string, string>,
  tableTrackIdMaps: ReadonlyMap<string, ReadonlyMap<string, string>>,
  crossDocument: boolean,
): void {
  const sourceTableShapeId = props.sourceTableShapeId;
  if (!sourceTableShapeId) {
    return;
  }
  const nextTableShapeId = shapeIdMap.get(sourceTableShapeId);
  const trackIdMap = tableTrackIdMaps.get(sourceTableShapeId);
  if (!nextTableShapeId || !trackIdMap) {
    // The table did not travel with the copy.
    //
    // Within the same document that is the normal case — duplicating (⌘D) or pasting just the
    // chart, while its table sits untouched a few pixels above. The id still resolves, so the copy
    // stays live; dropping it here would silently freeze every duplicate on its snapshot and show
    // "the source table is gone" next to the table it names.
    //
    // Across documents the id means nothing in the destination, so it goes.
    if (crossDocument) {
      delete props.sourceTableShapeId;
    }
    return;
  }
  props.sourceTableShapeId = nextTableShapeId;
  props.spec = {
    ...props.spec,
    seriesColors: Object.fromEntries(
      Object.entries(props.spec.seriesColors)
        .map(([key, color]) => [remapChartSeriesColorKey(key, trackIdMap), color]),
    ),
  };
  props.dataSnapshot = {
    ...props.dataSnapshot,
    series: props.dataSnapshot.series.map((series) => ({
      ...series,
      id: trackIdMap.get(series.id) ?? series.id,
    })),
  };
}

function textFlowBlockToPlainText(block: ClipboardTextFlowBlock): string {
  if (block.type === "section") {
    return block.title;
  }
  if (block.type === "boxBlock") {
    return [
      inlineNodesToPlainText(block.title ?? []),
      ...block.blocks.map(boxBlockChildToPlainText),
    ].filter(Boolean).join("\n");
  }
  if (block.type === "list") {
    return listBlockToPlainText(block);
  }
  if (block.type === "layoutSection") {
    return block.children.map(textFlowBlockToPlainText).join("\n");
  }
  if (block.type === "divider") {
    // 区切り線はプレーンテキストでは水平線の慣用表記になる (Markdown と同じ)。
    return "---";
  }
  if (block.type === "codeBlock") {
    return inlineNodesToPlainText(block.children);
  }
  if (block.type === "quote") {
    // Markdown と同じで各行の頭に `> ` を付ける。外のエディタへ貼っても引用として通る。
    return block.blocks
      .map(textFlowBlockToPlainText)
      .join("\n")
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  }

  if (block.type === "problem") return documentBlockToPlainText(block);

  // 見出し・段落。知らない種別が実行時に紛れ込んでも、テキスト無しとして扱えば
  // クリップボード全体を落とさずに済む。
  return Array.isArray(block.children) ? inlineNodesToPlainText(block.children) : "";
}

function documentBlockToPlainText(block: ClipboardDocumentBlock): string {
  if (block.type !== "problem") {
    return textFlowBlockToPlainText(block);
  }

  return PROBLEM_AREA_ORDER
    .flatMap((area) => block[area] ?? [])
    .map(problemAreaBlockToPlainText)
    .join("\n");
}

function problemAreaBlockToPlainText(block: ProblemAreaBlock): string {
  if (block.type === "layoutSection") {
    return block.children.map(layoutSectionChildToPlainText).join("\n");
  }
  if (
    block.type === "boxBlock"
    || block.type === "divider"
    || block.type === "quote"
    || block.type === "codeBlock"
  ) {
    return textFlowBlockToPlainText(block);
  }
  return richBlockToPlainText(block);
}

function richBlockToPlainText(block: RichBlock): string {
  if (block.type === "list") {
    return listBlockToPlainText(block);
  }
  return inlineNodesToPlainText(block.children);
}

function boxBlockChildToPlainText(block: BoxBlockChildBlock): string {
  if (block.type === "problem") return documentBlockToPlainText(block);
  if (block.type === "layoutSection") {
    return block.children.map(layoutSectionChildToPlainText).join("\n");
  }
  return layoutSectionChildToPlainText(block);
}

function layoutSectionChildToPlainText(block: LayoutSectionChildBlock): string {
  if (block.type === "section") {
    return block.title;
  }
  if (
    block.type === "boxBlock"
    || block.type === "divider"
    || block.type === "quote"
    || block.type === "codeBlock"
  ) {
    return textFlowBlockToPlainText(block);
  }
  return richBlockToPlainText(block);
}

/**
 * 貼り付け先で使う id の頭。読みやすさのためだけのもので、意味を持たせている場所は無い。
 * ここに無い種別は `type` をそのまま使うので、知らないブロックでも id は振り直せる。
 */
const PASTE_ID_PREFIX_BY_TYPE: Readonly<Record<string, string>> = {
  paragraph: "p",
  listItem: "li",
  boxBlock: "box",
  layoutSection: "layout_section",
  quote: "quote",
  codeBlock: "code",
  divider: "divider",
};

/**
 * 貼り付け用の複製。**種別ごとの分岐を持たない**。
 *
 * `type` と `id` を併せ持つオブジェクトを再帰的に探して id を振り直すだけなので、ブロックの
 * 種別が増えても・このビルドが知らない種別が来ても、コピペが黙って中身を落とさない。
 * (以前は種別ごとに clone 関数が並んでいて、追加のたびに 1 箇所書き忘れると、その種別だけ
 * 元の id のまま貼られて元ブロックと二重化していた。)
 */
function cloneBlockForPaste<T>(block: T): T {
  return refreshPastedIds(structuredClone(block)) as T;
}

function refreshPastedIds(value: unknown): unknown {
  if (Array.isArray(value)) {
    value.forEach(refreshPastedIds);
    return value;
  }
  if (!isRecord(value)) {
    return value;
  }

  const type = value.type;
  if (typeof type === "string" && typeof value.id === "string") {
    value.id = createId(PASTE_ID_PREFIX_BY_TYPE[type] ?? type);
  }
  if (type === "list") {
    // 未知のマーカー種別 (新しいビルドからの貼り付け) は decimal に落とす。リストごと捨てるより、
    // 番号だけが既定に戻る方が損失が小さい。
    const markerStyle = value.listType === "ordered"
      ? normalizeOrderedListMarkerStyle(value.markerStyle)
      : undefined;
    if (markerStyle) {
      value.markerStyle = markerStyle;
    } else {
      delete value.markerStyle;
    }
  }

  for (const child of Object.values(value)) {
    refreshPastedIds(child);
  }
  return value;
}

/**
 * クリップボードのブロックが正しいかは SigmaDoc のスキーマ (`SigmaBlockSchema`) だけで決める。
 *
 * ここに種別ごとの許可リストを置くと、教材には入れられるのにコピペだけ落ちるブロックが
 * 生まれる (問題エリアの中の箱・段組がそうだった: 検証が段落 / 見出し / リストしか通さず、
 * 別ウィンドウからの貼り付けで問題ごと消えていた)。「文書に入るものは運べる」を唯一の規約に
 * することで、コピペ側がブロックの種別を知らなくても構造のまま運べる。
 *
 * 出力 (`result.data`) を使うのは、貼り付けが正規化を通らない入口だから — 図形と同じく、
 * 省略された既定値の補完と余計なキーの除去をここで済ませ、文書へ入る形にしてから渡す。
 */
function parseClipboardBlocks(
  values: readonly unknown[],
  accept?: (block: SigmaBlock) => boolean,
): SigmaBlock[] | null {
  const blocks: SigmaBlock[] = [];
  for (const value of values) {
    const result = SigmaBlockSchema.safeParse(value);
    if (!result.success || (accept && !accept(result.data))) {
      return null;
    }
    blocks.push(result.data);
  }
  return blocks;
}

/**
 * 本文の連なり (`ClipboardTextFlowBlock`) に入れられるブロックか。問題は独立した入れ物なので
 * 入らない。コピー側が「本文ブロックの payload で運べるか、文書ブロックの payload が要るか」を
 * 決めるのに使う。
 */
export function isTextFlowClipboardBlock(block: SigmaBlock): block is Exclude<ClipboardTextFlowBlock, { type: "problem" }> {
  return isTextFlowBlock(block) || block.type === "layoutSection";
}

function listBlockToPlainText(list: ListNode, depth = 0): string {
  return list.items.map((item, index) => {
    const number = (list.start ?? 1) + index;
    const marker = list.listType !== "ordered"
      ? "- "
      : list.markerStyle === "paren"
        ? `(${number}) `
        : `${number}. `;
    const indent = "  ".repeat(depth);
    const body = `${indent}${marker}${inlineNodesToPlainText(item.children)}`;
    const continuations = (item.continuations ?? []).map((continuation) => (
      `${indent}  ${inlineNodesToPlainText(listItemContinuationInlineNodes(continuation))}`
    ));
    const nested = (item.nested ?? []).map((child) => listBlockToPlainText(child, depth + 1)).filter(Boolean);
    return [body, ...continuations, ...nested].join("\n");
  }).join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value)
    .replaceAll("\"", "&quot;");
}

function unescapeHtml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function unescapeHtmlAttribute(value: string): string {
  return unescapeHtml(value)
    .replaceAll("&quot;", "\"");
}
