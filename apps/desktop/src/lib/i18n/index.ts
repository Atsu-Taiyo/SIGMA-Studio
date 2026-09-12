/**
 * i18n の唯一の入口 (React 非依存)。
 *
 * ここから React (`react` / `react-i18next`) を再エクスポートしてはいけない。
 * `electron/main.ts` は esbuild で `dist-electron/main.cjs` に束ねられるため、
 * barrel に React が混ざると main プロセスのバンドルが壊れる。React 依存は
 * `./react` にだけ置く (`features/rendering/adapters` と同じ分離)。
 */
export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  detectLocale,
  isAppLocale,
  normalizeLocale,
  readNavigatorLanguages,
  type AppLocale,
} from "./locale";

export { DEFAULT_NAMESPACE, i18n, type AppNamespace } from "./i18n";

export { createTranslator, type Translate } from "./translator";
export { createCurrentLocaleTranslator } from "./current-translator";

export {
  UI_LOCALE_CHANGE_EVENT,
  UI_LOCALE_STORAGE_KEY,
  getAppLocale,
  getServerAppLocale,
  setAppLocale,
  subscribeAppLocale,
} from "./locale-store";
