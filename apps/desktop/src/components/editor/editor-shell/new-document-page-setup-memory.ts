"use client";

import { useEffect } from "react";

import {
  deriveNewDocumentPageSetup,
  type NewDocumentPageSetup,
  type SigmaDocument,
} from "@/features/document";
import { getDesktopBridge } from "@/lib/desktop-bridge";

/**
 * 「新しい教材は直前に開いていた教材の用紙設定で作る」ための記憶。
 *
 * 開いている教材の用紙設定が変わったら少し待って main へ渡し (設定ファイルに残るので再起動後も効く)、
 * 新しい空の教材は main がその値で作る (`storage:create-document`)。ワークスペース画面から作るときや
 * 再起動直後も、最後に開いていた教材の用紙になる。
 *
 * 1 つのアプリに 1 つの記憶なので、モジュールに持つ。
 */
const REMEMBER_DELAY_MS = 400;

let lastSavedKey: string | null = null;
let pending: { key: string; setup: NewDocumentPageSetup } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> = Promise.resolve();

/** 開けなかった教材の代わりの下書き・読み込み前の空の下書きは、用紙設定の元にしない。 */
function isRealDocument(document: Pick<SigmaDocument, "docId">): boolean {
  return document.docId !== "doc_empty_editor_draft" && !document.docId.startsWith("doc_open_failed_");
}

export function scheduleNewDocumentPageSetup(document: Pick<SigmaDocument, "docId" | "pageLayout" | "metadata">): void {
  if (!isRealDocument(document)) return;
  const setup = deriveNewDocumentPageSetup(document);
  // ホワイトボードは用紙ではない。最後に開いた用紙の教材の設定を覚えたままにする。
  if (!setup) return;
  const key = JSON.stringify(setup);
  if (key === (pending?.key ?? lastSavedKey)) return;
  pending = { key, setup };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flushNewDocumentPageSetup();
  }, REMEMBER_DELAY_MS);
}

/** 新しい教材を作る直前に呼ぶ。待っている用紙設定を main へ渡し終えるまで待つ。 */
export async function flushNewDocumentPageSetup(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const entry = pending;
  pending = null;
  if (entry && entry.key !== lastSavedKey) {
    const bridge = getDesktopBridge();
    if (bridge?.app.saveEditorPreferences) {
      lastSavedKey = entry.key;
      inFlight = bridge.app.saveEditorPreferences({ newDocumentPageSetup: entry.setup })
        .then(() => undefined)
        .catch((error) => {
          if (lastSavedKey === entry.key) lastSavedKey = null;
          console.warn("Failed to remember the page setup for new materials", error);
        });
    }
  }
  await inFlight;
}

/**
 * いま開いている教材の用紙設定を覚え続ける。本文の図形を動かしても用紙設定は変わらないので、
 * `pageLayout` そのものではなく用紙設定の部分だけを見て走らせる。
 */
export function useRememberNewDocumentPageSetup(document: SigmaDocument, enabled: boolean): void {
  const { docId, pageLayout, metadata } = document;
  const preset = pageLayout?.preset;
  const orientation = pageLayout?.orientation;
  const pageSize = pageLayout?.pageSize;
  const marginsMm = pageLayout?.marginsMm;
  const flow = pageLayout?.flow;
  const header = pageLayout?.header;
  const footer = pageLayout?.footer;
  const background = pageLayout?.background;
  const headingNumbering = metadata.headingNumbering;

  useEffect(() => {
    if (!enabled || !preset || !pageSize || !marginsMm || !flow) return;
    scheduleNewDocumentPageSetup({
      docId,
      pageLayout: { preset, orientation: orientation ?? "portrait", pageSize, marginsMm, flow, header, footer, background },
      metadata: { title: "", headingNumbering },
    });
  }, [enabled, docId, preset, orientation, pageSize, marginsMm, flow, header, footer, background, headingNumbering]);

  // 画面を離れる (ワークスペース画面へ移る・閉じる) ときは待たずに渡す。
  useEffect(() => () => { void flushNewDocumentPageSetup(); }, []);
}

/** テスト用。モジュールに残った記憶を消す。 */
export function resetNewDocumentPageSetupMemoryForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  pending = null;
  lastSavedKey = null;
  inFlight = Promise.resolve();
}
