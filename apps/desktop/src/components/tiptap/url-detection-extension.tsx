"use client";

import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import type { Step } from "@tiptap/pm/transform";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

import { getDesktopBridge } from "@/lib/desktop-bridge";
import { requestOpenLink } from "@/lib/link-open-request";
import { findUrls } from "@/lib/url-detection";

import { countDecorationInitWalk } from "./decoration-walk-metrics";
import { createUrlLinkCard, URL_LINK_SELECTOR, type UrlLinkCardAction } from "./url-link-card";

export const QR_CODE_REQUEST_EVENT = "sigma-studio:qr-code-request";

export interface QrCodeRequestDetail {
  url: string;
}

const urlDetectionKey = new PluginKey<DecorationSet>("urlDetection");

/**
 * Dispatch a request to turn `url` into a QR code. The editor shell listens for
 * this event and inserts the generated QR code as an overlay image. Using a
 * window event mirrors the inline-math edit request bus and avoids threading a
 * callback through every editor surface that renders the flow editor.
 */
export function requestQrCodeFromUrl(url: string): void {
  if (typeof window === "undefined") {
    return;
  }
  const detail: QrCodeRequestDetail = { url };
  window.dispatchEvent(new CustomEvent<QrCodeRequestDetail>(QR_CODE_REQUEST_EVENT, { detail }));
}

/** 本文のリンクの要素。`url-detected` の下線で、URL は `data-url` が持つ。 */
function linkElementAt(view: EditorView, target: EventTarget | null): HTMLElement | null {
  const link = target instanceof Element ? target.closest<HTMLElement>(URL_LINK_SELECTOR) : null;
  return link && view.dom.contains(link) && link.dataset.url ? link : null;
}

/** ⌘ (mac) / Ctrl を押したクリック。Alt が一緒のときは別の操作に譲る。 */
export function isOpenLinkClick(event: MouseEvent): boolean {
  return event.button === 0 && (event.metaKey || event.ctrlKey) && !event.altKey;
}

function hasSigmaBrowser(): boolean {
  return Boolean(getDesktopBridge()?.browser);
}

function runLinkAction(action: UrlLinkCardAction, url: string): void {
  if (action === "qr") {
    requestQrCodeFromUrl(url);
    return;
  }
  requestOpenLink(url, action === "sigma" && hasSigmaBrowser() ? "sigma" : "browser");
}

/**
 * Detects http(s) URLs in flow text as the user types and decorates them with a
 * subtle underline. Hovering one offers "QR code / open in the browser / open in
 * Sigma", and ⌘/Ctrl+click opens it. Detection is view-only and does not change
 * the SigmaDoc document.
 */
export const UrlDetectionExtension = Extension.create({
  name: "urlDetection",

  addProseMirrorPlugins() {
    // 編集器 1 つにつきカード 1 つ (この関数は編集器ごとに呼ばれる)。
    const card = createUrlLinkCard({ onAction: runLinkAction, canOpenInSigma: hasSigmaBrowser });
    return [
      new Plugin<DecorationSet>({
        key: urlDetectionKey,
        // 装飾は plugin state に持ち、打鍵では**打った段落だけ**読み直す。全文に正規表現を
        // かけ直すと、URL が 1 つも無い文書でも打鍵コストが本文の長さに比例する。
        state: {
          init: (_config, state) => createUrlDecorations(state.doc),
          apply: (transaction, decorations) => applyUrlDecorationsToTransaction(decorations, transaction),
        },
        props: {
          decorations: (state) => urlDetectionKey.getState(state) ?? DecorationSet.empty,
          handleDOMEvents: {
            // `mouseover` は「入った」瞬間にしか来ないので、クリックや打鍵でカードが閉じたあとも
            // ポインタがリンクの上に残っていると二度と出ない。リンク上で動いている間は、止まった
            // ところで出す (動くたびに待ち直す)。
            mousemove: (view, event) => {
              const link = linkElementAt(view, event.target);
              // ボタンを押している間 (範囲選択のドラッグ) と変換入力中は出さない。
              if (link && event.buttons === 0 && !view.composing) {
                card.hoverLink(link, { x: event.clientX, y: event.clientY });
              }
              return false;
            },
            mouseout: (view, event) => {
              const link = linkElementAt(view, event.target);
              if (!link) {
                return false;
              }
              // 折り返した同じ URL の別の行・マークで分かれた別の要素へ動いただけなら、出たことにしない。
              const next = linkElementAt(view, event.relatedTarget);
              if (!next || next.dataset.url !== link.dataset.url) {
                card.leaveLink();
              }
              return false;
            },
            // ⌘/Ctrl+クリックは「開く」であって、キャレットを置く操作ではない。
            mousedown: (view, event) => {
              if (!isOpenLinkClick(event) || !linkElementAt(view, event.target)) {
                return false;
              }
              event.preventDefault();
              return true;
            },
            click: (view, event) => {
              const link = isOpenLinkClick(event) ? linkElementAt(view, event.target) : null;
              if (!link?.dataset.url) {
                return false;
              }
              event.preventDefault();
              card.hide();
              runLinkAction(event.shiftKey ? "sigma" : "browser", link.dataset.url);
              return true;
            },
            // 打ち始めたら出さない (修飾キーだけは、⌘クリックの前触れなので残す)。
            keydown: (_view, event) => {
              if (event.key !== "Meta" && event.key !== "Control" && event.key !== "Shift" && event.key !== "Alt") {
                card.hide();
              }
              return false;
            },
          },
        },
        view: () => ({
          update: (view, previous) => {
            if (view.state.doc !== previous.doc) {
              card.hide();
            }
          },
          destroy: () => card.destroy(),
        }),
      }),
    ];
  },
});

/** そのテキストブロックが持つ URL 装飾 (下線)。 */
function collectUrlDecorationsInBlock(block: ProseMirrorNode, blockPos: number, into: Decoration[]): void {
  block.descendants((node, offset) => {
    if (!node.isText || !node.text) {
      return;
    }
    // ブロックの中身は `blockPos + 1` から始まる。
    const base = blockPos + 1 + offset;
    for (const { url, start, end } of findUrls(node.text)) {
      const from = base + start;
      const to = base + end;
      // URL は属性で持つ: マークで分かれた下線の要素のどれにホバーしても、同じ URL を引ける。
      into.push(Decoration.inline(from, to, { class: "url-detected", "data-url": url }));
    }
  });
}

/** 文書全体を読み直す (初回とテスト用)。 */
export function createUrlDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  // 編集器 1 つにつき 1 回だけ (plugin state の初期化)。打鍵のたびに走る走査とは別に数える。
  countDecorationInitWalk();
  doc.descendants((node, pos) => {
    if (!node.isTextblock) {
      return true;
    }
    collectUrlDecorationsInBlock(node, pos, decorations);
    return false;
  });
  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

/**
 * 変更のあったテキストブロックだけ読み直し、残りは写像で持ち越す。
 *
 * 「変更のあった」は transaction の step が触れた範囲 (新しい文書側の座標) を含むブロック。
 * URL は 1 つのテキストノードの中でしか成立しないので、ブロック単位で捨てて読み直せば
 * 全文走査と同じ結果になる。
 */
export function applyUrlDecorationsToTransaction(
  decorations: DecorationSet,
  transaction: Transaction,
): DecorationSet {
  if (!transaction.docChanged) {
    return decorations;
  }
  const mapped = decorations.map(transaction.mapping, transaction.doc);
  const blocks = changedTextblocks(transaction);
  if (blocks.length === 0) {
    return mapped;
  }

  let next = mapped;
  const added: Decoration[] = [];
  for (const { node, pos } of blocks) {
    const contentFrom = pos + 1;
    const contentTo = pos + node.nodeSize - 1;
    const stale = next.find(contentFrom, contentTo);
    if (stale.length > 0) {
      next = next.remove(stale);
    }
    collectUrlDecorationsInBlock(node, pos, added);
  }
  return added.length > 0 ? next.add(transaction.doc, added) : next;
}

function changedTextblocks(transaction: Transaction): Array<{ node: ProseMirrorNode; pos: number }> {
  const blocks = new Map<number, { node: ProseMirrorNode; pos: number }>();
  const doc = transaction.doc;
  const addRange = (rawFrom: number, rawTo: number) => {
    const from = Math.max(0, Math.min(doc.content.size, rawFrom));
    const to = Math.max(from, Math.min(doc.content.size, rawTo));
    doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isTextblock) {
        return true;
      }
      blocks.set(pos, { node, pos });
      return false;
    });
  };

  transaction.steps.forEach((step, index) => {
    // 後続の step のぶんだけ写像して、最終的な文書での範囲にする。step ごとに 1 回で足りる
    // (範囲ごとに作り直すと step 数の二乗になる)。
    const rest = transaction.mapping.slice(index + 1);
    let hadRange = false;
    step.getMap().forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      hadRange = true;
      // 左へ 1 広げるのは保険。`nodesBetween` は「`from` ちょうどで終わるノード」を訪ねない
      // (`Fragment.nodesBetween` の判定が `end > from`) ので、範囲がブロック境界から始まる
      // step ではその手前のブロックが読み直されない。読み直しは冪等なので、余分に 1 ブロック
      // 見る方を選ぶ — 取りこぼすと「URL を打ったのに下線が出ない」が次の打鍵まで残る。
      addRange(rest.map(newStart, -1) - 1, rest.map(newEnd, 1));
    });
    if (hadRange) {
      return;
    }
    // マーク (太字・色) や属性の step は位置を動かさないので `StepMap` が空になる。だが
    // **テキストノードは分割される**ので URL の見え方は変わる: URL の一部を太字にすると
    // 検出は外れ、外すと戻る。範囲が出ない step は step 自身の from/to を使う。
    const bounds = getStepBounds(step);
    if (bounds) {
      addRange(rest.map(bounds.from, -1) - 1, rest.map(bounds.to, 1));
    }
  });
  return [...blocks.values()];
}

/** `StepMap` が空の step (マーク・属性) が触った範囲。 */
function getStepBounds(step: Step): { from: number; to: number } | null {
  const candidate = step as unknown as { from?: unknown; to?: unknown; pos?: unknown };
  if (typeof candidate.from === "number" && typeof candidate.to === "number") {
    return { from: candidate.from, to: candidate.to };
  }
  // `AttrStep` は 1 ノードだけを指す。
  if (typeof candidate.pos === "number") {
    return { from: candidate.pos, to: candidate.pos + 1 };
  }
  // `DocAttrStep` のように文書全体の属性だけを変える step は本文の見え方を変えない。
  return null;
}
