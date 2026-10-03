import { preserveLocalEditorClipboardPayload } from "@/lib/editor-clipboard";

import { POCKET_CLIPBOARD_TYPES, type PocketClipboardBag, type PocketItem } from "../model/pocket-items";
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
 * ポケットの項目を、いまの貼り付け先へ入れる。⌘V と同じ経路で、コピーが書いたのと同じ
 * 内容を持つ paste イベントを送る。キャレットの位置・図形の置き場所・Undo のまとまりは
 * 通常の貼り付けのままで、ポケットの項目は消えない (何度でも入れられる)。
 */
export function insertPocketItem(id: string): PocketInsertResult {
  const item = getPocketState().items.find((candidate) => candidate.id === id);
  if (!item) {
    return "missing";
  }
  const data = createDataTransfer();
  const event = data ? createClipboardEvent("paste", data) : null;
  if (!data || !event) {
    showPocketNotice("unsupported");
    return "unsupported";
  }
  for (const [type, value] of Object.entries(item.clip)) {
    data.setData(type, value);
  }
  // 図形だけの項目は、本文のキャレットではなく紙面へ貼る。キャレットのある本文エディタへ
  // 送ると、図形を編集中のとき ProseMirror が (何も入らないまま) 貼り付けを引き受けてしまい、
  // 紙面側の受け手が見送る。2 つ目以降の図形が入らなくなるのはこのため。
  const target = item.preview.kind === "shapes" ? document.body : resolveTransferTarget();
  target.dispatchEvent(event);
  // 受け手が貼り付けを引き受けると preventDefault する。誰も受けなかったときは、
  // 貼り付け先 (キャレットや開いている教材) が無いということ。
  if (!event.defaultPrevented) {
    showPocketNotice("rejected");
    return "rejected";
  }
  return "inserted";
}
