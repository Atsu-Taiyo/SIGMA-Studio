"use client";
import {
  createOverlayClipboardPayload,
  createTextAndShapesClipboardPayload,
  extractVisibleEditorClipboardHtml,
  readEditorClipboardPayload,
  readTextSliceClipboardData,
  takeBodyTextCut,
  toOverlayShapesClipboardPayload,
  writeEditorClipboardData,
  type EditorClipboardPayload
} from "@/lib/editor-clipboard";
import type { Editor as TiptapEditor } from "@tiptap/core";
import type { RefObject } from "react";
import {
  useEffect
} from "react";
import {
  getSelectedShapesForClipboard
} from "./grouping";
import type { ApplyPastedOverlayShapesOptions } from "./paste-shapes";
import { isTextInputTarget } from "./selection-command-model";
import type {
  OverlayAsset,
  OverlayShape
} from "./types";

export interface Dependencies {
  getBlockAnchorScope: () => ParentNode | null;
  activeTextEditorRef: RefObject<TiptapEditor | null>;
  shapesRef: RefObject<OverlayShape[]>;
  selectedIdsRef: RefObject<string[]>;
  reanchorShapesToCopiedBlocks: (selectedShapes: OverlayShape[], slice: unknown) => OverlayShape[];
  assetsRef: RefObject<Record<string, OverlayAsset>>;
  documentIdRef: RefObject<string | undefined>;
  getRemovableSelectedShapeIds: () => string[];
  pendingOverlaySaveHistoryGroupRef: RefObject<string | null>;
  deleteSelectedShapes: () => void;
  applyPastedOverlayShapes: (payload: Extract<EditorClipboardPayload, { kind: "overlayShapes"; }>, options?: ApplyPastedOverlayShapesOptions) => boolean;
}

export function useOverlayClipboard({
  getBlockAnchorScope,
  activeTextEditorRef,
  shapesRef,
  selectedIdsRef,
  reanchorShapesToCopiedBlocks,
  assetsRef,
  documentIdRef,
  getRemovableSelectedShapeIds,
  pendingOverlaySaveHistoryGroupRef,
  deleteSelectedShapes,
  applyPastedOverlayShapes,
}: Dependencies) {

  useEffect(() => {
    const readBodyTextClipboardSelection = (event: ClipboardEvent): {
      text: { slice: unknown; text: string };
      html: string;
    } | null => {
      const target = event.target instanceof Element ? event.target : null;
      const scope = getBlockAnchorScope();
      if (
        !target
        || !target.closest(".text-flow-editor")
        // 数式エディタ内のコピーは数式側の選択が正で、本文の slice ではない。
        || target.closest("math-field")
        || !(scope instanceof Node)
        || !scope.contains(target)
      ) {
        return null;
      }
      const text = event.clipboardData ? readTextSliceClipboardData(event.clipboardData) : null;
      if (!text || !event.clipboardData) {
        return null;
      }
      // 跨ぎ選択のコピーは text/html を payload div で書く。textAndShapes へ包み直すとき
      // payload div を入れ子にしないよう、可視部分の HTML だけを取り出す (PM が書いた
      // 素の HTML はそのまま通る)。
      const html = event.clipboardData.getData("text/html");
      return { text, html: extractVisibleEditorClipboardHtml(html) };
    };

    /**
     * この cut / copy で、このインスタンスが図形を書き出す**見込みがあるか**。
     *
     * `handleCut` が本文側の印を食う前に、`writeShapeClipboard` が中断する条件を先に問う。
     * ここを揃えないと、**掴んでいないインスタンスが印を食って**、実際に図形を切り取る側へ
     * 本文もコアレスキーも届かない —— 「切り取りの undo が 2 手に割れる」が戻る。
     * `handleCut` が選択の有無しか見ていなかったのが元の穴。
     */
    const canWriteShapeClipboard = (event: ClipboardEvent): boolean => {
      if (activeTextEditorRef.current?.isFocused || !event.clipboardData) {
        return false;
      }
      return getSelectedShapesForClipboard(shapesRef.current, selectedIdsRef.current).length > 0;
    };

    /**
     * 選択中の図形をクリップボードへ。本文の範囲も生きていれば 1 つの payload にまとめる。
     * 図形が乗ったときだけ true (呼び出し側が切り取りの削除まで進めてよい合図)。
     */
    const writeShapeClipboard = (
      event: ClipboardEvent,
      bodyText: { text: { slice: unknown; text: string }; html: string } | null,
    ): boolean => {
      // 2 つ目の条件は型の絞り込みのため (中身は `canWriteShapeClipboard` が既に見ている)。
      if (!canWriteShapeClipboard(event) || !event.clipboardData) {
        return false;
      }
      const clipboardData = event.clipboardData;

      const selectedShapes = getSelectedShapesForClipboard(shapesRef.current, selectedIdsRef.current);
      if (!bodyText && isTextInputTarget(event.target)) {
        return false;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (bodyText) {
        writeEditorClipboardData(clipboardData, createTextAndShapesClipboardPayload(
          bodyText.text,
          reanchorShapesToCopiedBlocks(selectedShapes, bodyText.text.slice),
          assetsRef.current,
          documentIdRef.current,
        ), { html: bodyText.html });
      } else {
        writeEditorClipboardData(
          clipboardData,
          createOverlayClipboardPayload(selectedShapes, assetsRef.current, documentIdRef.current),
        );
      }
      return true;
    };

    const handleCopy = (event: ClipboardEvent) => {
      // PM の copy 処理は本文 DOM に付いていて window bubble より先に走るため、
      // この時点で clipboardData に本文側の HTML/plain text/private slice が揃っている。
      writeShapeClipboard(event, readBodyTextClipboardSelection(event));
    };

    /**
     * 切り取り。本文は PM (または跨ぎ選択の置換) が自分で消すので、ここは図形の分だけ。
     *
     * 本文側の slice を `event.clipboardData` からではなくモジュールの印から読むのは、
     * PM の cut ハンドラがこの前に `clearData()` を呼ぶため (`markBodyTextCut` の注記)。
     * 印は必ず取り切る — 図形が選ばれていない切り取りで持ち越すと、次の切り取りに混ざる。
     */
    const handleCut = (event: ClipboardEvent) => {
      // `takeBodyTextCut` の印は 1 回しか取れない。`handleCut` はマウント済みの
      // オーバーレイごとに登録されている (本文 / running region で複数) ので、
      // **書き出さないインスタンスが先に食う**と、切り取った図形を持つ側に本文も
      // コアレスキーも届かない。書き出す見込みが無いインスタンスは何も取らずに降りる。
      //
      // **判定は `writeShapeClipboard` と 1 箇所で共有する。** 「選択が空でない」だけでは
      // 足りない: テキスト編集中・`clipboardData` が無い・選択が全てクリップボード対象外、の
      // どれでも書き出しは中断するのに、印だけ食われる。
      if (!canWriteShapeClipboard(event)) {
        return;
      }
      const cutText = takeBodyTextCut(event);
      const bodyText = cutText
        ? { text: cutText, html: extractVisibleEditorClipboardHtml(event.clipboardData?.getData("text/html") ?? "") }
        : null;
      if (writeShapeClipboard(event, bodyText)) {
        // 本文側が鋳造したキーを、この削除が起こす保存へ載せる (undo 1 回で両方戻す)。
        // `deleteSelectedShapes` の引数では渡さない — `runContextMenuAction` にコールバック値
        // のまま渡されており、引数を足すとイベントオブジェクトが options として流れ込む。
        //
        // **本当に消えるときだけ置く。** 選択が全てロック / 編集ポリシー禁止だと
        // `deleteSelectedShapes` は何もせずに戻り、`setShapes` が走らないのでキーが
        // 取り残される (次の無関係な編集がそれを継承して戻せなくなる)。
        const willDeleteShapes = getRemovableSelectedShapeIds().length > 0;
        pendingOverlaySaveHistoryGroupRef.current = willDeleteShapes
          ? cutText?.historyGroup ?? null
          : null;
        deleteSelectedShapes();
      }
    };

    const handlePaste = (event: ClipboardEvent) => {
      // 本文が既に処理したペーストには乗らない。
      //
      // `isTextInputTarget` だけでは足りない: 本文の PM がペーストを処理すると、選択範囲の DOM は
      // そこで作り直される。target がその中の要素 (混在選択の装飾 span など) だと、window まで
      // バブルしてくる頃には DOM から外れていて `closest` が null を返し、「入力欄ではない」と
      // 誤判定して図形をもう一度貼ってしまう (図形が 2 個増える)。
      if (event.defaultPrevented) {
        return;
      }
      if (isTextInputTarget(event.target) || activeTextEditorRef.current?.isFocused || !event.clipboardData) {
        return;
      }

      const payload = readEditorClipboardPayload(event.clipboardData);
      if (payload?.kind !== "overlayShapes" && payload?.kind !== "textAndShapes") {
        return;
      }

      const shapesPayload = payload.kind === "textAndShapes" ? toOverlayShapesClipboardPayload(payload) : payload;
      if (!applyPastedOverlayShapes(shapesPayload)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    window.addEventListener("copy", handleCopy);
    window.addEventListener("cut", handleCut);
    window.addEventListener("paste", handlePaste);
    return () => {
      window.removeEventListener("copy", handleCopy);
      window.removeEventListener("cut", handleCut);
      window.removeEventListener("paste", handlePaste);
    };
  }, [activeTextEditorRef, applyPastedOverlayShapes, assetsRef, deleteSelectedShapes, documentIdRef, getBlockAnchorScope, getRemovableSelectedShapeIds, pendingOverlaySaveHistoryGroupRef, reanchorShapesToCopiedBlocks, selectedIdsRef, shapesRef]);
}
