import type { BoxFrameSpec, RichBlock, SigmaBlock } from "@/features/document";
import { mergeBoxFrame } from "@/lib/box-blocks";
import { BoxFrameSchema } from "@/lib/sigma-doc-schema";

/**
 * スタイルごとに「前に決めた見た目」を覚えておく場所。
 *
 * 設定ダイアログで色や罫を変えたら、**次に同じスタイルを挿すときも同じ見た目**で入ってほしい、
 * という要求のための保存。図形の `sigma-studio:overlay-shape-style-defaults` と同じ作りで、
 * 同期に読める `localStorage` と、保存領域が使えないときのためのメモリ複製を持つ。
 *
 * 覚えるのは**差分だけ**。ダイアログが出す patch をスタイル ID ごとに畳んでいくので、組み込み
 * スタイル側の既定が将来変わっても、ユーザーが触っていない項目はその変更に付いていく。
 *
 * 既にある箱には触らない。箱は作られた時点の `frame` を自分で持っていて、それが紙面の正本
 * (別の環境で開いても同じに描ける) だから — ここが効くのは**これから挿す箱**だけ。
 */
const STORAGE_KEY = "sigma-studio:box-style-defaults";

type RememberedBoxFrames = Record<string, BoxFrameSpec>;

let remembered: RememberedBoxFrames = {};
let loadedFromStorage = false;

function load(): RememberedBoxFrames {
  if (loadedFromStorage || typeof window === "undefined") {
    return remembered;
  }
  loadedFromStorage = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      remembered = normalizeRememberedFrames(JSON.parse(raw));
    }
  } catch {
    // 壊れた JSON でも保存領域が使えなくても、組み込みの既定で挿せる。
  }
  return remembered;
}

function save(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(remembered));
  } catch {
    // 保存できなくても、この編集セッションの続きには上のメモリ値が効く。
  }
}

/**
 * 保存されている値は**外から書き換えられる文字列**なので、読むときにスキーマを通す。
 * 1 スタイルが壊れていても他は残す (全部捨てると、1 文字の破損で全部の記憶が飛ぶ)。
 */
function normalizeRememberedFrames(value: unknown): RememberedBoxFrames {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const next: RememberedBoxFrames = {};
  for (const [styleId, frame] of Object.entries(value as Record<string, unknown>)) {
    // `BoxFrameSchema` は文書側で任意フィールドなので `.optional()`。ここでは値がある物だけ覚える。
    const parsed = BoxFrameSchema.safeParse(frame);
    if (styleId && parsed.success && parsed.data) {
      next[styleId] = parsed.data;
    }
  }
  return next;
}

/** そのスタイルで覚えている差分。何も覚えていなければ `null`。 */
export function readRememberedBoxFrame(styleId: string): BoxFrameSpec | null {
  return load()[styleId] ?? null;
}

/** ダイアログの patch を 1 つ畳み込む。 */
export function rememberBoxFramePatch(styleId: string, patch: Partial<BoxFrameSpec>): void {
  if (!styleId) {
    return;
  }
  const current = load();
  remembered = {
    ...current,
    [styleId]: mergeBoxFrame(current[styleId], patch as BoxFrameSpec),
  };
  save();
}

/** そのスタイルの記憶を捨てる (「既定に戻す」)。 */
export function forgetRememberedBoxFrame(styleId: string): void {
  const current = load();
  if (!(styleId in current)) {
    return;
  }
  const next = { ...current };
  delete next[styleId];
  remembered = next;
  save();
}

/**
 * これから挿す箱へ、覚えている見た目を載せる。箱以外はそのまま返すので、挿入経路が
 * 「作ってからこれを通す」だけで済む。
 */
export function applyRememberedBoxFrame<T extends SigmaBlock | RichBlock>(block: T): T {
  if (block.type !== "boxBlock") {
    return block;
  }
  const frame = readRememberedBoxFrame(block.styleId);
  if (!frame) {
    return block;
  }
  return { ...block, frame: mergeBoxFrame(block.frame, frame) } as T;
}

/** For tests: forget both copies. */
export function resetRememberedBoxStylesForTest(): void {
  remembered = {};
  loadedFromStorage = false;
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing to clean up when storage is unavailable
  }
}
