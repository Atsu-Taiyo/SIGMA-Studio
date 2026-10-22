import type {
  HeadingNumberingConfig,
  HeadingNumberingStyle,
  PageLayout,
  PageOverlay,
  PageRunningRegion,
  SigmaDocument,
} from "../model";
import type { OverlayAsset, OverlaySnapshot } from "../overlay-model";
import { pruneUnusedOverlayAssets } from "../overlay-assets";
import { normalizeOverlayGroups } from "../overlay-group-normalization";
import { expandMarginsForRunningRegions, isWhiteboardPageLayout, normalizePageLayout } from "./page-layout";

/**
 * 新しい空の教材が、直前に開いていた教材から引き継ぐ「用紙設定」。
 *
 * ページ設定ダイアログで決めるもの (用紙・向き・余白・段組み・ヘッダー/フッター・背景・見出し番号) だけを持つ。
 * ヘッダー/フッターは位置だけでなく中身 (学校名・ロゴなど) も用紙の一部として持つ。
 * ページ番号の開始 (`pageNumberStart`) は教材ごとの構成なので含めない。
 * 本文・本文の図形 (`pageLayout.overlay`)・題名・コメントは教材そのものなので含めない。
 * ホワイトボードは用紙ではないので、引き継ぐ元にならない (`null`)。
 */
export interface NewDocumentPageSetup {
  pageLayout: PageLayout;
  headingNumbering?: HeadingNumberingConfig;
}

const HEADING_NUMBERING_STYLES: readonly HeadingNumberingStyle[] = ["decimal", "sectionSign", "chapterJa"];

/** 開いている教材から、新しい教材へ引き継ぐ用紙設定を取り出す。ホワイトボードなら `null`。 */
export function deriveNewDocumentPageSetup(
  document: Pick<SigmaDocument, "pageLayout" | "metadata">,
): NewDocumentPageSetup | null {
  return normalizeNewDocumentPageSetup({
    pageLayout: document.pageLayout,
    headingNumbering: document.metadata?.headingNumbering,
  });
}

/**
 * 保存された値 (設定ファイル・IPC) を読み直す。壊れた値・ホワイトボードは `null` にして、
 * 新しい教材は既定の用紙で作る (作成そのものは止めない)。
 */
export function normalizeNewDocumentPageSetup(value: unknown): NewDocumentPageSetup | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as { pageLayout?: unknown; headingNumbering?: unknown };
  if (!record.pageLayout || typeof record.pageLayout !== "object" || Array.isArray(record.pageLayout)) {
    return null;
  }
  const normalized = normalizePageLayout(record.pageLayout as PageLayout);
  if (isWhiteboardPageLayout(normalized)) {
    return null;
  }

  const pageLayout: PageLayout = expandMarginsForRunningRegions({
    ...normalized,
    // 本文の図形は教材の中身。用紙設定としては運ばない。
    overlay: undefined,
    header: portableRunningRegion(normalized.header),
    footer: portableRunningRegion(normalized.footer),
  });
  delete pageLayout.overlay;
  // 表紙を 0 ページにするなどの数え方は、その教材の構成の話。次の教材へは運ばない。
  delete pageLayout.pageNumberStart;
  const headingNumbering = normalizeHeadingNumbering(record.headingNumbering);
  return headingNumbering ? { pageLayout, headingNumbering } : { pageLayout };
}

/** 空の教材へ用紙設定を当てる。本文・題名・id はそのまま。 */
export function applyNewDocumentPageSetup(
  document: SigmaDocument,
  setup: NewDocumentPageSetup | null | undefined,
): SigmaDocument {
  const normalized = setup ? normalizeNewDocumentPageSetup(setup) : null;
  if (!normalized) {
    return document;
  }
  const metadata = { ...document.metadata };
  if (normalized.headingNumbering) {
    metadata.headingNumbering = { ...normalized.headingNumbering };
  } else {
    delete metadata.headingNumbering;
  }
  return {
    ...document,
    metadata,
    pageLayout: {
      ...normalized.pageLayout,
      ...(document.pageLayout?.overlay ? { overlay: document.pageLayout.overlay } : {}),
    },
  };
}

function portableRunningRegion(region: PageRunningRegion | undefined): PageRunningRegion | undefined {
  if (!region) {
    return undefined;
  }
  const overlay = portableOverlay(region.overlay);
  const next: PageRunningRegion = { ...region, blocks: structuredClone(region.blocks) };
  // ページごとの例外 (出さないページ・出すページ・ページ専用の文字) は、元の教材のそのページの話。
  // 中身の違う新しい教材へは運ばない。「先頭ページのみ」などのまとまり (showOnFirstPage /
  // showOnLaterPages) は用紙設定なので引き継ぐ。
  delete next.hiddenPages;
  delete next.shownPages;
  delete next.pageContents;
  if (overlay) {
    next.overlay = overlay;
  } else {
    delete next.overlay;
  }
  return next;
}

/**
 * ヘッダー/フッターの図形を、別の教材へ持ち出せる形にする。
 *
 * 共有教材の画像は `sigma-doc-storage://` の参照で、その教材の置き場にしか実体が無い。
 * 新しい教材へ参照だけを写すと画像が読めないので、画像を自分で持つ (data URL) ものだけを残し、
 * 持ち出せない画像の図形は外す。文字・線などの図形は残す。
 */
function portableOverlay(overlay: PageOverlay | undefined): PageOverlay | undefined {
  const snapshot = overlay?.overlaySnapshot;
  if (!snapshot || snapshot.shapes.length === 0) {
    return undefined;
  }
  const droppedAssetIds = new Set(
    Object.values(snapshot.assets)
      .filter((asset) => !isSelfContainedAsset(asset))
      .map((asset) => asset.id),
  );
  const shapes = droppedAssetIds.size === 0
    ? snapshot.shapes
    : normalizeOverlayGroups(snapshot.shapes.filter((shape) => (
      shape.type !== "image" || !droppedAssetIds.has(shape.props.assetId)
    )));
  if (shapes.length === 0) {
    return undefined;
  }
  const assets = Object.fromEntries(Object.entries(snapshot.assets).filter(([id]) => !droppedAssetIds.has(id)));
  const nextSnapshot: OverlaySnapshot = pruneUnusedOverlayAssets(structuredClone({ ...snapshot, shapes, assets }));
  return { overlaySnapshot: nextSnapshot };
}

function isSelfContainedAsset(asset: OverlayAsset): boolean {
  return !asset.props.storage && /^data:/i.test(asset.props.src);
}

function normalizeHeadingNumbering(value: unknown): HeadingNumberingConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.enabled !== "boolean") {
    return undefined;
  }
  const config: HeadingNumberingConfig = { enabled: record.enabled };
  if (HEADING_NUMBERING_STYLES.includes(record.style as HeadingNumberingStyle)) {
    config.style = record.style as HeadingNumberingStyle;
  }
  if (record.depth === 1 || record.depth === 2 || record.depth === 3) {
    config.depth = record.depth;
  }
  return config;
}
