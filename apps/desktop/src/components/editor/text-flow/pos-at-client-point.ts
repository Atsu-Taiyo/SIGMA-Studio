import type { EditorView } from "@tiptap/pm/view";
import { localColumnForCaret } from "./local-column-dom";

/**
 * クライアント座標 → ProseMirror 位置。**素の座標を先に**引く。
 *
 * 従来は編集面 root (`view.dom`) の矩形へクランプしてから `posAtCoords` を引いていたが、
 * root の矩形は「本文がどこに描かれているか」を表さない:
 *
 * - 段組みの本文はブロックが絶対配置され、root 自身の矩形は 1 ページ目上端の数十 px に潰れる。
 *   画面中央のブロックをクリックしても座標が root の潰れた矩形 (画面のはるか上) へクランプ
 *   され、**文書先頭付近に解決**してしまう — その選択に scrollIntoView が重なると紙面が
 *   先頭へ吹っ飛ぶ。
 * - 断片の複製は viewport の中で translate されるため、同じ形で座標がずれる。
 *
 * だからクランプは「素引きが外れたとき」(本文の左右の余白クリックなど) の予備に格下げし、
 * その予備も root の矩形ではなく**実際に描かれているブロック矩形の和**へ寄せる。
 */
export function posAtClientPoint(view: EditorView, clientX: number, clientY: number): number | null {
  const column = localColumnForCaret(view.dom, clientX, clientY);
  if (column) {
    // A short column's lower whitespace belongs to that column, even when the browser
    // returns a valid position in its taller neighbour. Clamp to its nearest text row
    // before asking ProseMirror; a union of all columns loses horizontal ownership.
    let nearest: DOMRect | null = null;
    let distance = Infinity;
    const scope = view.dom.contains(column) ? column : view.dom;
    for (const block of scope.querySelectorAll<HTMLElement>("p, h1, h2, h3, h4, h5, h6, pre, [data-box-title-region='true']")) {
      const rect = block.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const dy = Math.max(rect.top - clientY, 0, clientY - rect.bottom);
      if (dy < distance) {
        distance = dy;
        nearest = rect;
      }
    }
    if (nearest) {
      const position = view.posAtCoords({
        left: clamp(clientX, nearest.left + 1, nearest.right - 1),
        top: clamp(clientY, nearest.top + 1, nearest.bottom - 1),
      })?.pos;
      if (position !== undefined) return position;
    }
  }
  const raw = view.posAtCoords({ left: clientX, top: clientY })?.pos;
  if (raw !== undefined) {
    return raw;
  }

  const band = resolveClampBand(view.dom as HTMLElement);
  if (!band || band.right - band.left <= 2 || band.bottom - band.top <= 2) {
    return null;
  }
  const left = clamp(clientX, band.left + 1, band.right - 1);
  const top = clamp(clientY, band.top + 1, band.bottom - 1);
  return view.posAtCoords({ left, top })?.pos ?? null;
}

/**
 * 予備のクランプ先。ブロック矩形の和が取れないとき (ブロック id を持たない面 — コメント欄や
 * 箱タイトルなど) だけ root の矩形へ戻る — そこでは root が実寸なので従来と同じ挙動になる。
 */
function resolveClampBand(
  viewDom: HTMLElement,
): { top: number; right: number; bottom: number; left: number } | null {
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  for (const block of viewDom.querySelectorAll<HTMLElement>("[data-sigma-doc-id]")) {
    const rect = block.getBoundingClientRect();
    if (rect.height <= 0 || rect.width <= 0) {
      continue;
    }
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
    left = Math.min(left, rect.left);
  }
  if (Number.isFinite(top) && Number.isFinite(bottom)) {
    return { top, right, bottom, left };
  }
  const rect = viewDom.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left };
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}
