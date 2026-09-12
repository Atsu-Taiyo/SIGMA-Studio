"use client";

import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import type { Step } from "@tiptap/pm/transform";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { findUrls } from "@/lib/url-detection";

import { countDecorationInitWalk } from "./decoration-walk-metrics";
import { createTranslator, getAppLocale } from "@/lib/i18n";

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

function buildQrButton(url: string): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "url-qr-action";
  button.contentEditable = "false";
  button.tabIndex = -1;
  // Tiptap の装飾は React の外で作るので、表示のたびにロケールストアから引く。
  const label = createTranslator(getAppLocale(), "editor")("url.makeQrCode");
  button.title = label;
  button.setAttribute("aria-label", label);
  button.dataset.url = url;
  // Small inline QR glyph drawn with an SVG so it stays crisp at any zoom.
  button.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path fill="currentColor" d="M1 1h6v6H1V1zm2 2v2h2V3H3zm6-2h6v6H9V1zm2 2v2h2V3h-2zM1 9h6v6H1V9zm2 2v2h2v-2H3zm6 0h2v2H9v-2zm4-2h2v2h-2V9zm0 4h2v2h-2v-2zm-2 0h2v2h-2v-2z"/></svg>`;
  button.addEventListener("mousedown", (event) => {
    // Prevent the editor from moving the selection / losing focus.
    event.preventDefault();
  });
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    requestQrCodeFromUrl(url);
  });
  return button;
}

/**
 * Detects http(s) URLs in flow text as the user types and decorates them with a
 * subtle underline plus an inline "make QR code" affordance. Detection is
 * view-only and does not change the SigmaDoc document.
 */
export const UrlDetectionExtension = Extension.create({
  name: "urlDetection",

  addProseMirrorPlugins() {
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
        },
      }),
    ];
  },
});

/** そのテキストブロックが持つ URL 装飾 (下線 + QR ボタン)。 */
function collectUrlDecorationsInBlock(block: ProseMirrorNode, blockPos: number, into: Decoration[]): void {
  // key はブロックの id と「そのブロックの何個目の URL か」で作る。位置を入れると、写像で
  // 位置だけ動いた widget の key が実際の位置と食い違い、同じ段落を読み直すたびに
  // 「別物」と判定されて QR ボタンが作り直される。
  // id 無しのブロック (この拡張は本文以外の編集面でも使える) は位置で代用する。位置は写像に
  // 追従しないので、同じ URL を持つ id 無しブロックが 2 つあると key が衝突しうる — ただし
  // 本文では `sigmaDocTextIdentity` が必ず id を配るので、その状態は次の読み直しで解消する。
  const blockKey = typeof block.attrs?.sigmaDocId === "string" && block.attrs.sigmaDocId
    ? block.attrs.sigmaDocId
    : `pos${blockPos}`;
  let occurrence = 0;
  block.descendants((node, offset) => {
    if (!node.isText || !node.text) {
      return;
    }
    // ブロックの中身は `blockPos + 1` から始まる。
    const base = blockPos + 1 + offset;
    for (const { url, start, end } of findUrls(node.text)) {
      const from = base + start;
      const to = base + end;
      into.push(Decoration.inline(from, to, { class: "url-detected" }));
      into.push(Decoration.widget(to, () => buildQrButton(url), {
        side: 1,
        ignoreSelection: true,
        key: `url-qr-${blockKey}-${occurrence}-${url}`,
      }));
      occurrence += 1;
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
