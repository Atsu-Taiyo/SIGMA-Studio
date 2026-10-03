import { EDITOR_CLIPBOARD_MIME, EDITOR_TEXT_SLICE_MIME } from "@/lib/editor-clipboard";

import {
  derivePocketPreview,
  POCKET_HTML_MIME,
  POCKET_PLAIN_TEXT_MIME,
  type PocketPreview,
} from "./pocket-preview";

/**
 * ポケットが覚えておくクリップボードの種類。コピーが書く 4 つだけで、貼り付けるときに同じ
 * 4 つを渡し直す。ほかの種類 (画像ファイルなど) はコピー元の編集面が書かない。
 */
export const POCKET_CLIPBOARD_TYPES = [
  EDITOR_CLIPBOARD_MIME,
  EDITOR_TEXT_SLICE_MIME,
  POCKET_HTML_MIME,
  POCKET_PLAIN_TEXT_MIME,
] as const;

/** MIME 種別 → その内容 (文字列)。コピーが書いた順序と中身をそのまま持つ。 */
export type PocketClipboardBag = Readonly<Record<string, string>>;

/** 入れておける件数。超えたら黙って古いものを捨てず、入れられないことを伝える。 */
export const POCKET_MAX_ITEMS = 30;
/** 1 件の大きさ (文字数)。画像は base64 で入るので、画像 1 枚が収まる程度に取る。 */
export const POCKET_MAX_ITEM_SIZE = 16_000_000;
/** 全体の大きさ (文字数)。レンダラのメモリに居座り続ける量の上限。 */
export const POCKET_MAX_TOTAL_SIZE = 64_000_000;

export interface PocketItem {
  readonly id: string;
  readonly addedAt: number;
  /** 貼り戻しにそのまま使う、コピー時のクリップボード。 */
  readonly clip: PocketClipboardBag;
  /** カードの描画用。clip から作った派生値で、文書には書かない。 */
  readonly preview: PocketPreview;
  /** clip の大きさ (文字数)。 */
  readonly size: number;
}

export interface PocketRemovedItem {
  readonly item: PocketItem;
  /** 取り除く前の並び位置。取り消しで同じ場所へ戻す。 */
  readonly index: number;
}

export type PocketAddOutcome =
  | { ok: true; items: readonly PocketItem[]; item: PocketItem }
  | { ok: false; reason: "empty" | "full" | "tooLarge" };

/** コピーが書いた分だけを取り出す。空の内容と知らない種類は捨てる。 */
export function normalizePocketClipboardBag(source: Readonly<Record<string, string>>): PocketClipboardBag {
  const bag: Record<string, string> = {};
  for (const type of POCKET_CLIPBOARD_TYPES) {
    const value = source[type];
    if (typeof value === "string" && value.length > 0) {
      bag[type] = value;
    }
  }
  return bag;
}

export function pocketClipboardSize(bag: PocketClipboardBag): number {
  return Object.values(bag).reduce((total, value) => total + value.length, 0);
}

export function pocketTotalSize(items: readonly PocketItem[]): number {
  return items.reduce((total, item) => total + item.size, 0);
}

/**
 * コピーの結果から項目を作る。描けるものが無い (何も選ばれていなかった) ときは null。
 * ID と時刻は呼び出し側が渡す (純関数のまま、テストで固定できるように)。
 */
export function createPocketItem(
  source: Readonly<Record<string, string>>,
  identity: { id: string; addedAt: number },
): PocketItem | null {
  const clip = normalizePocketClipboardBag(source);
  const preview = derivePocketPreview(clip);
  if (!preview) {
    return null;
  }
  return { ...identity, clip, preview, size: pocketClipboardSize(clip) };
}

/** 末尾へ足す。件数・大きさの上限を超えるなら足さずに理由を返す。 */
export function addPocketItem(
  items: readonly PocketItem[],
  source: Readonly<Record<string, string>>,
  identity: { id: string; addedAt: number },
): PocketAddOutcome {
  const item = createPocketItem(source, identity);
  if (!item) {
    return { ok: false, reason: "empty" };
  }
  if (item.size > POCKET_MAX_ITEM_SIZE) {
    return { ok: false, reason: "tooLarge" };
  }
  if (items.length >= POCKET_MAX_ITEMS || pocketTotalSize(items) + item.size > POCKET_MAX_TOTAL_SIZE) {
    return { ok: false, reason: "full" };
  }
  return { ok: true, items: [...items, item], item };
}

/** 指定の項目を除く。取り消しのため、外した項目と元の位置も返す。 */
export function removePocketItems(
  items: readonly PocketItem[],
  ids: ReadonlySet<string>,
): { items: readonly PocketItem[]; removed: PocketRemovedItem[] } {
  const removed: PocketRemovedItem[] = [];
  const kept: PocketItem[] = [];
  items.forEach((item, index) => {
    if (ids.has(item.id)) {
      removed.push({ item, index });
    } else {
      kept.push(item);
    }
  });
  return removed.length === 0 ? { items, removed } : { items: kept, removed };
}

/**
 * 外した項目を元の並び位置へ戻す。すでに同じ ID があるもの (取り消しの二重実行) は足さない。
 * 件数の上限は取り消しでも超えない。
 */
export function restorePocketItems(
  items: readonly PocketItem[],
  removed: readonly PocketRemovedItem[],
): readonly PocketItem[] {
  const present = new Set(items.map((item) => item.id));
  const next = [...items];
  for (const { item, index } of [...removed].sort((left, right) => left.index - right.index)) {
    if (present.has(item.id) || next.length >= POCKET_MAX_ITEMS) {
      continue;
    }
    next.splice(Math.min(index, next.length), 0, item);
    present.add(item.id);
  }
  return next.length === items.length ? items : next;
}
