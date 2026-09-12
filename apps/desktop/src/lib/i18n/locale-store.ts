import { i18n } from "./i18n";
import { DEFAULT_LOCALE, detectLocale, isAppLocale, type AppLocale } from "./locale";

/** 既存の `sigma-studio:*` 規約に合わせた永続キー。 */
export const UI_LOCALE_STORAGE_KEY = "sigma-studio:ui-locale";
export const UI_LOCALE_CHANGE_EVENT = "sigma-studio:ui-locale-change";

function readStoredLocale(): AppLocale | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(UI_LOCALE_STORAGE_KEY);
    return isAppLocale(raw) ? raw : null;
  } catch {
    // Sandboxed iframes and blocked third-party storage make getItem throw.
    return null;
  }
}

// localStorage への書き込みが拒否される環境 (sandbox iframe / ストレージ無効 / quota)
// でも、そのセッションの間だけは言語切り替えを効かせるための退避先。書き込みが
// 成功したら捨てる。これが無いと、そういう環境では言語を選んでも無反応になる。
let volatileLocale: AppLocale | null = null;

/** 保存値 → OS/ブラウザ検出 → 日本語、の優先順で表示言語を決める。 */
function resolveAppLocale(): AppLocale {
  return volatileLocale ?? readStoredLocale() ?? detectLocale() ?? DEFAULT_LOCALE;
}

// useSyncExternalStore requires getSnapshot() to return a value that only
// changes when the store does. Re-reading localStorage on every call would be
// correct for a string but still costs a storage hit per render, so the
// resolved locale is cached at module level and invalidated (never adopted)
// whenever the stored value may have changed.
let cachedSnapshot: AppLocale | null = null;

function getSnapshot(): AppLocale {
  if (volatileLocale) {
    return volatileLocale;
  }
  if (typeof window === "undefined") {
    return DEFAULT_LOCALE;
  }
  if (!cachedSnapshot) {
    cachedSnapshot = resolveAppLocale();
  }
  return cachedSnapshot;
}

export function getAppLocale(): AppLocale {
  return getSnapshot();
}

/**
 * サーバー描画と最初のクライアント描画で同じ値を返すためのスナップショット。
 *
 * `next.config.ts` の `output: "export"` により HTML はビルド時に **日本語で**
 * 焼かれる。保存値や検出結果をここで覗くと、英語環境のハイドレーション描画だけが
 * 英語になって焼かれた HTML と食い違う。既定ロケールを返して最初の描画をサーバーと
 * 揃え、実際のロケールへはハイドレーション後の再描画で移る。
 */
export function getServerAppLocale(): AppLocale {
  return DEFAULT_LOCALE;
}

/**
 * i18next 側の現在言語を追随させる。
 *
 * `document.documentElement.lang` はここでは触らない。SDK 組み込みではホスト
 * ページの `<html>` を共有しているので、モジュールを import しただけでホストの
 * lang を塗り替えてはいけない。アプリの `<html lang>` は `app/layout.tsx` が
 * 差す `AppDocumentLanguage` がハイドレーション後に追随させる。
 */
function syncRuntimeLocale(locale: AppLocale): void {
  if (i18n.language !== locale) {
    void i18n.changeLanguage(locale);
  }
}

const subscribers = new Set<() => void>();

/**
 * 別ウィンドウ (Electron の print ウィンドウ・別タブ) や、このウィンドウの
 * `setAppLocale` からの変更を受けて、キャッシュ・i18next・購読者をまとめて追随させる。
 * 購読者がいなくてもランタイムだけは同期させたいので、購読ごとではなく
 * モジュール読み込み時に 1 回だけ listener を張る。
 */
function handleExternalLocaleChange(): void {
  cachedSnapshot = null;
  syncRuntimeLocale(getSnapshot());
  for (const notify of [...subscribers]) {
    notify();
  }
}

function handleStorageEvent(event: StorageEvent): void {
  // A null key means localStorage.clear() was called; any other key is some
  // unrelated preference and must not trigger a re-read.
  if (event.key === UI_LOCALE_STORAGE_KEY || event.key === null) {
    handleExternalLocaleChange();
  }
}

/**
 * 表示言語を切り替える。永続化 → i18next の言語切替 → 購読者への通知、の順。
 * 再起動は不要で、購読しているコンポーネントだけが再描画される。
 */
export function setAppLocale(next: AppLocale): void {
  if (typeof window === "undefined") {
    volatileLocale = next;
    cachedSnapshot = next;
    syncRuntimeLocale(next);
    return;
  }

  const previous = getSnapshot();
  try {
    window.localStorage.setItem(UI_LOCALE_STORAGE_KEY, next);
    volatileLocale = null;
  } catch (error) {
    // Storage can reject the write (sandboxed iframe, blocked storage, quota).
    // 永続化は諦めるが、選んだ言語はこのセッションの間だけでも効かせる。
    console.warn("Failed to persist the UI locale", error);
    volatileLocale = next;
  }
  cachedSnapshot = null;
  const effective = getSnapshot();
  syncRuntimeLocale(effective);
  if (effective === previous) {
    return;
  }
  window.dispatchEvent(new CustomEvent(UI_LOCALE_CHANGE_EVENT));
}

/** useSyncExternalStore の subscribe 半分。 */
export function subscribeAppLocale(onStoreChange: () => void): () => void {
  subscribers.add(onStoreChange);
  return () => {
    subscribers.delete(onStoreChange);
  };
}

if (typeof window !== "undefined") {
  window.addEventListener(UI_LOCALE_CHANGE_EVENT, handleExternalLocaleChange);
  window.addEventListener("storage", handleStorageEvent);
}

// Boot as a module side effect, without priming the snapshot cache: the print and
// workspace routes never mount EditorShell, so there is no provider to hang the
// initial language off of.
syncRuntimeLocale(resolveAppLocale());
