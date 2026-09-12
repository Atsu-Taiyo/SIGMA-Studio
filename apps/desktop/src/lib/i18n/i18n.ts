import i18next from "i18next";

import { en } from "./dictionaries/en";
import { ja } from "./dictionaries/ja";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "./locale";

/** 辞書の namespace 名 (= 移行 WI と 1:1)。 */
export type AppNamespace = keyof typeof ja;

export const DEFAULT_NAMESPACE = "common" satisfies AppNamespace;

/**
 * アプリ全体で唯一の i18next インスタンス。React 用と非 React 用で resolver を
 * 二重に持たないための単一の出典で、React には依存しない (Electron main も読める)。
 */
export const i18n = i18next.createInstance();

void i18n.init({
  lng: DEFAULT_LOCALE,
  // 検出できない・訳が無い場合は必ず日本語へ。英語へ倒すと日本語前提の既存 UI が壊れる。
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: SUPPORTED_LOCALES,
  // 辞書はバンドル同梱の同期リソース。backend / loader は入れない
  // (静的 export + file:// 配信でチャンク読み込みが不安定なため)。
  resources: { ja, en },
  defaultNS: DEFAULT_NAMESPACE,
  ns: Object.keys(ja),
  keySeparator: ".",
  // キー中の ":" を namespace 区切りと誤読させない。namespace は必ず引数で指定する。
  nsSeparator: false,
  returnNull: false,
  // 同期 init (i18next v26 では initImmediate ではなく initAsync)。辞書は同梱済みなので
  // setTimeout 越しに解決させず、静的 export の first paint を待たせない。
  initAsync: false,
  // React が既にエスケープするので二重エスケープを防ぐ。
  /**
   * React が描く面しか無いので二重エスケープを避ける。
   *
   * **これが成り立つ条件は「訳文を生 HTML の口へ渡さないこと」**。React の
   * テキストノードと属性は自動でエスケープするが、`dangerouslySetInnerHTML` や
   * 手書きの HTML/SVG 組み立てへ `t(...)` の結果を渡した瞬間に、教材名のような
   * 利用者入力が補間値として注入経路になる。訳文をそこへ渡さないこと。
   */
  interpolation: { escapeValue: false },
  // `react` オプションは持たない。React 層は react-i18next を通さず
  // `getFixedT` を直接使う (`./react.ts` の理由コメント参照) ので、
  // Suspense も store 購読も最初から発生しない。
});
