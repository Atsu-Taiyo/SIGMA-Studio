"use client";

import { useMemo, useSyncExternalStore } from "react";

import { DEFAULT_NAMESPACE, i18n, type AppNamespace } from "./i18n";
import type { AppLocale } from "./locale";
import {
  getAppLocale,
  getServerAppLocale,
  setAppLocale,
  subscribeAppLocale,
} from "./locale-store";
import type { Translate } from "./translator";

// React 依存はこのファイルだけに閉じ込める。barrel (`./index`) から React が
// 漏れると `electron/main.ts` の esbuild バンドルに React が混入する。
export { setAppLocale };

/** 現在の表示言語。切り替え時にこのフックの購読者だけが再描画される。 */
export function useAppLocale(): AppLocale {
  return useSyncExternalStore(subscribeAppLocale, getAppLocale, getServerAppLocale);
}

/**
 * namespace を固定した翻訳関数。
 *
 * ロケールは `i18n.language` ではなく {@link useAppLocale} から取る。これが
 * ハイドレーション安全性の要で、静的 export で焼かれた日本語 HTML に対して
 * 最初のクライアント描画も日本語になり、実ロケールへはその後の再描画で移る。
 *
 * **react-i18next の `useTranslation` は使わない。** あれは内部で独自の
 * `useSyncExternalStore` と「未ロードなら読み込む」effect を持っていて、フェイク
 * タイマーを使う既存テスト (`UiLayoutOnboardingDialog.test.tsx` 等) の中で解決待ちの
 * まま止まり、共有 `Modal` を描く画面が非決定的に落ちる。辞書は同期バンドル済みで
 * 読み込む物が無いので、`getFixedT` を直接 memo 化すれば十分で、再描画の駆動も
 * ロケールストア 1 本に寄る (切り替え 1 回につき再描画 1 回)。
 */
export function useT<Ns extends AppNamespace = typeof DEFAULT_NAMESPACE>(
  namespace: Ns = DEFAULT_NAMESPACE as Ns,
): Translate<Ns> {
  const locale = useAppLocale();
  return useMemo(() => i18n.getFixedT(locale, namespace), [locale, namespace]) as Translate<Ns>;
}
