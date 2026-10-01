"use client";

import { scrollElementIntoCanvasView } from "@/components/editor/text-flow/caret-scroll";

export interface EditorBlockFocusOptions {
  /**
   * ブロック全体を選ぶのではなく、末尾へキャレットを畳む。
   *
   * 既定 (false) は「いま作った空ブロックへ入る」向き。既にある文章のブロックへ焦点を戻す
   * ときに全選択のままにすると、次の 1 打鍵でその文章が消える (引用ボタンで実際に踏んだ)。
   */
  collapseToEnd?: boolean;
  /** A command owner may invalidate delayed focus after switching or disposal. */
  isCurrent?: () => boolean;
  /**
   * 焦点がどこにも無いときだけ当てる。
   *
   * ブロック操作の後始末に使う。remount で焦点が飛んだときは戻したいが、飛んでいないなら
   * PM のコマンドが置いたキャレットがそのまま正しいので、触ってはいけない。
   */
  onlyIfLost?: boolean;
}

export function scheduleEditorBlockFocus(
  blockId: string,
  options: EditorBlockFocusOptions = {},
  attempt = 0,
) {
  window.requestAnimationFrame(() => {
    if (options.isCurrent && !options.isCurrent()) return;
    window.requestAnimationFrame(() => {
      if (options.isCurrent && !options.isCurrent()) return;
      if (options.onlyIfLost && !hasLostEditorFocus()) {
        // まだどこかが焦点を持っている。remount は次のフレームには間に合わないことがあるので、
        // すぐ諦めずに「失われたか」をもう一度だけ見に行く。
        if (attempt < FOCUS_RESTORE_ATTEMPTS) {
          window.setTimeout(
            () => scheduleEditorBlockFocus(blockId, options, attempt + 1),
            FOCUS_RESTORE_VERIFY_MS,
          );
        }
        return;
      }

      const selector = `[data-sigma-doc-id="${CSS.escape(blockId)}"], #${CSS.escape(blockId)}`;
      const blockElement = window.document.querySelector<HTMLElement>(selector);
      const editorElement = blockElement?.closest<HTMLElement>("[contenteditable='true']");
      const selection = window.getSelection();
      if (!blockElement || !editorElement || !selection) {
        if (attempt < 8) {
          window.setTimeout(() => scheduleEditorBlockFocus(blockId, options, attempt + 1), 30);
        }
        return;
      }

      editorElement.focus({ preventScroll: true });
      const range = window.document.createRange();
      range.selectNodeContents(blockElement);
      // **畳んでから**張る。全選択のまま残すと、次に打った文字がブロックごと置き換わる
      // (`docs/caret-behavior-spec.md` が禁止する回帰そのもの)。`collapseToEnd` の指定が
      // 無ければ先頭へ畳む。
      range.collapse(!options.collapseToEnd);
      selection.removeAllRanges();
      selection.addRange(range);
      // `scrollIntoView` は祖先のスクロール可能な箱 (断片の viewport) まで動かしてしまう。
      // 動かすのは紙面のスクローラーだけにする。
      scrollElementIntoCanvasView(blockElement);

      // 当てた焦点が定着したかを、少し置いてから確かめる。
      //
      // ブロックの入れ物を作り替える操作 (引用でくるむ・段組にする・リストにする) は本文ランの
      // **先頭ブロック id** を変える。ランの React キーはその id なので (`render-units.ts` の
      // `id: chunk[0].id`)、React がランごと unmount → remount し、ここで当てた焦点はその
      // commit で外れる。実機では「引用ボタンを押した直後に打った文字が引用の外へ行く」という
      // 形で出た。remount は次のフレームには間に合わないことがあるので、rAF ではなく待つ。
      //
      // 焦点が **どこにも無い** ときだけ戻す。ユーザーが自分で別のコントロールへ移ったなら、
      // それを奪い返してはいけない。
      if (attempt < FOCUS_RESTORE_ATTEMPTS) {
        window.setTimeout(() => {
          if (hasLostEditorFocus()) {
            scheduleEditorBlockFocus(blockId, options, attempt + 1);
          }
        }, FOCUS_RESTORE_VERIFY_MS);
      }
    });
  });
}

/**
 * 本文ランの先頭ブロック id を変えうるコマンド。押した後に焦点を当て直す必要がある。
 * (`render-units.ts` がランの id を `chunk[0].id` にしているため、React キーが変わる)
 */
/**
 * 焦点が「どこにも無い」か。
 *
 * ユーザーが自分で別のコントロールへ移ったのなら、それを奪い返してはいけない。だから
 * body (＝誰も持っていない) のときだけを「失われた」とみなす。
 */
export function hasLostEditorFocus(): boolean {
  const active = window.document.activeElement;
  return !active || active === window.document.body;
}

/** 焦点が外れていたら当て直す回数と間隔。remount 1 回ぶんを吸収できれば十分。 */
const FOCUS_RESTORE_ATTEMPTS = 3;
const FOCUS_RESTORE_VERIFY_MS = 120;

