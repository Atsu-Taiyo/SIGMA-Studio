import { preserveLocalEditorClipboardPayload } from "@/lib/editor-clipboard";

import { POCKET_CLIPBOARD_TYPES, type PocketClipboardBag, type PocketItem } from "../model/pocket-items";
import { getPocketPageHost, readPocketDragItemId, type PocketDropLocation } from "./pocket-drag";
import { addToPocket, getPocketState, showPocketNotice } from "./pocket-store";

/**
 * ポケットの内側。ここにフォーカスがあるときは、コピー・貼り付けの宛先を紙面側へ寄せる
 * (ボタンを押したあとにキーボードで操作している場合など)。
 */
export const POCKET_ROOT_ATTRIBUTE = "data-pocket-root";

export type PocketAddResult =
  | { ok: true; item: PocketItem }
  | { ok: false; reason: "nothing" | "unsupported" | "full" | "tooLarge" };

export type PocketInsertResult = "inserted" | "missing" | "unsupported" | "rejected";

/**
 * コピー・貼り付けのイベントを向ける要素。
 *
 * 紙面の編集面 (本文・図中テキストなど) にフォーカスがあればそこへ、無ければ body へ送る。
 * body に届いたイベントは、図形や選択中のブロックを扱う window の受け手が処理する。
 * 入力欄・数式欄・ダイアログの中は、そこへ文字を貼るのではなく紙面へ寄せる。
 */
function resolveTransferTarget(): Element {
  const active = document.activeElement;
  if (
    !(active instanceof Element)
    || active === document.body
    || active.closest(`[${POCKET_ROOT_ATTRIBUTE}]`)
    || active.closest('input, textarea, select, math-field, [role="dialog"]')
  ) {
    return document.body;
  }
  return active;
}

function createClipboardEvent(
  type: "copy" | "paste",
  data: DataTransfer,
): ClipboardEvent | null {
  try {
    return new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true });
  } catch {
    return null;
  }
}

function createDataTransfer(): DataTransfer | null {
  try {
    return new DataTransfer();
  } catch {
    return null;
  }
}

/**
 * 選択中のものを、普通のコピーと同じ受け手に書かせて集める。
 *
 * 本文の範囲・図形・ブロックのどれが選ばれていても、それぞれの編集面が自分の `copy` イベントで
 * 書く形 (SigmaDoc の payload・HTML・プレーンテキスト) がそのまま手に入る。ポケット専用の
 * シリアライザを持たないので、コピーして貼るのと同じ内容が貼り戻せる。
 *
 * イベントは自前の `DataTransfer` に向けて合成する。OS のクリップボードには何も書かないし、
 * 「最後の Sigma コピー」の記憶も元に戻すので、次の ⌘V には影響しない。
 */
function collectSelectionClip(): PocketClipboardBag | "unsupported" {
  const data = createDataTransfer();
  const event = data ? createClipboardEvent("copy", data) : null;
  if (!data || !event) {
    return "unsupported";
  }
  preserveLocalEditorClipboardPayload(() => resolveTransferTarget().dispatchEvent(event));
  const clip: Record<string, string> = {};
  for (const type of POCKET_CLIPBOARD_TYPES) {
    clip[type] = data.getData(type);
  }
  return clip;
}

/**
 * 選択中のものをポケットへ入れる。何も選ばれていない・いっぱい・大きすぎるときは入れず、
 * その理由をポケットに出す (並びを開いて見せるので、押しても何も起きない状態にはならない)。
 */
export function addSelectionToPocket(): PocketAddResult {
  const clip = collectSelectionClip();
  if (clip === "unsupported") {
    showPocketNotice("unsupported");
    return { ok: false, reason: "unsupported" };
  }
  const outcome = addToPocket(clip);
  if (outcome.ok) {
    return { ok: true, item: outcome.item };
  }
  const reason = outcome.reason === "empty" ? "nothing" : outcome.reason;
  showPocketNotice(reason);
  return { ok: false, reason };
}

/**
 * 項目と同じ内容を持つ paste イベントを、`target` へ送る。誰かが貼り付けを引き受けたら true。
 * 受け手が引き受けると preventDefault するので、誰も受けなかったときは貼り付け先
 * (キャレットや開いている教材) が無かったということ。
 */
function pasteItemInto(item: PocketItem, target: Element): boolean | "unsupported" {
  const data = createDataTransfer();
  const event = data ? createClipboardEvent("paste", data) : null;
  if (!data || !event) {
    return "unsupported";
  }
  for (const [type, value] of Object.entries(item.clip)) {
    data.setData(type, value);
  }
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function findPocketItem(id: string): PocketItem | undefined {
  return getPocketState().items.find((candidate) => candidate.id === id);
}

/**
 * ポケットの項目を、いまの貼り付け先へ入れる。⌘V と同じ経路で、コピーが書いたのと同じ
 * 内容を持つ paste イベントを送る。キャレットの位置・図形の置き場所・Undo のまとまりは
 * 通常の貼り付けのままで、ポケットの項目は消えない (何度でも入れられる)。
 *
 * 本文を持たない紙面 (ホワイトボード) は、紙面の窓口が項目を図形として置く。
 */
export function insertPocketItem(id: string): PocketInsertResult {
  const item = findPocketItem(id);
  if (!item) {
    return "missing";
  }
  if (getPocketPageHost()?.placeOnPage(item, null)) {
    return "inserted";
  }
  // 図形だけの項目は、本文のキャレットではなく紙面へ貼る。キャレットのある本文エディタへ
  // 送ると、図形を編集中のとき ProseMirror が (何も入らないまま) 貼り付けを引き受けてしまい、
  // 紙面側の受け手が見送る。2 つ目以降の図形が入らなくなるのはこのため。
  const target = item.preview.kind === "shapes" ? document.body : resolveTransferTarget();
  const outcome = pasteItemInto(item, target);
  if (outcome === "unsupported") {
    showPocketNotice("unsupported");
    return "unsupported";
  }
  if (!outcome) {
    showPocketNotice("rejected");
    return "rejected";
  }
  return "inserted";
}

/** ドロップ位置の本文 (編集できる面) と、その手前を覆っている要素 (図形のレイヤーなど)。 */
interface EditableAtPoint {
  readonly editable: HTMLElement;
  readonly covering: readonly HTMLElement[];
}

/**
 * ドロップ位置にある本文。入力欄・数式欄・ポケット自身の上では見つけない。
 * オーバーレイを編集しているあいだは、図形のレイヤーが本文の手前を覆っている。本文はその奥に
 * あっても見つけ、覆っている要素を一緒に返す。
 */
function findEditableAtPoint(clientX: number, clientY: number): EditableAtPoint | null {
  const covering: HTMLElement[] = [];
  for (const element of document.elementsFromPoint(clientX, clientY)) {
    if (element.closest(`[${POCKET_ROOT_ATTRIBUTE}], input, textarea, select, math-field`)) {
      return null;
    }
    const editable = element.closest<HTMLElement>('[contenteditable="true"]');
    if (editable) {
      return { editable, covering };
    }
    if (element instanceof HTMLElement) {
      covering.push(element);
    }
  }
  return null;
}

function caretRangeAtPoint(clientX: number, clientY: number): Range | null {
  if (typeof document.caretPositionFromPoint === "function") {
    const position = document.caretPositionFromPoint(clientX, clientY);
    if (position) {
      const range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
      return range;
    }
  }
  return typeof document.caretRangeFromPoint === "function"
    ? document.caretRangeFromPoint(clientX, clientY)
    : null;
}

/**
 * 本文の手前を覆う要素をヒットテストから外した状態で、座標の下のキャレット位置を引く。
 * 戻す前に描画やイベントは挟まらないので、利用者には見えない。
 */
function caretRangeThrough(
  clientX: number,
  clientY: number,
  covering: readonly HTMLElement[],
): Range | null {
  const previous = covering.map((element) => element.style.pointerEvents);
  covering.forEach((element) => {
    element.style.pointerEvents = "none";
  });
  try {
    return caretRangeAtPoint(clientX, clientY);
  } finally {
    covering.forEach((element, index) => {
      element.style.pointerEvents = previous[index] ?? "";
    });
  }
}

/**
 * ドロップ位置へキャレットを置く。本文の上でなければ null。
 *
 * 編集面は DOM の選択の変化 (`selectionchange`) を次のタスクで受け取って自分の選択へ写すので、
 * 呼び出し側は置いたあとに 1 タスク待ってから貼り付ける。
 */
function placeCaretAtPoint(clientX: number, clientY: number): HTMLElement | null {
  const found = findEditableAtPoint(clientX, clientY);
  const range = found ? caretRangeThrough(clientX, clientY, found.covering) : null;
  if (!found || !range || !found.editable.contains(range.startContainer)) {
    return null;
  }
  found.editable.focus({ preventScroll: true });
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return found.editable;
}

/**
 * ポケットの項目を、ドロップされた場所へ入れる。
 *
 * - 紙面の窓口が受けるもの (図形・ホワイトボードの本文) は、紙面の座標へ置く。
 * - 本文の上なら、そこへキャレットを置いてから通常の貼り付けと同じ経路で入れる。
 * - どちらでもない場所には入れず、理由をポケットに出す。
 */
export async function dropPocketItem(
  dataTransfer: DataTransfer,
  location: PocketDropLocation,
): Promise<PocketInsertResult> {
  const id = readPocketDragItemId(dataTransfer);
  const item = id ? findPocketItem(id) : undefined;
  if (!item) {
    return "missing";
  }
  if (location.pagePoint && getPocketPageHost()?.placeOnPage(item, location.pagePoint)) {
    return "inserted";
  }
  if (item.preview.kind !== "shapes") {
    getPocketPageHost()?.beforePlaceCaret?.();
  }
  const editable = item.preview.kind === "shapes" ? null : placeCaretAtPoint(location.clientX, location.clientY);
  if (!editable) {
    showPocketNotice("rejected");
    return "rejected";
  }
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  const outcome = pasteItemInto(item, editable);
  if (outcome === "unsupported") {
    showPocketNotice("unsupported");
    return "unsupported";
  }
  if (!outcome) {
    showPocketNotice("rejected");
    return "rejected";
  }
  return "inserted";
}
