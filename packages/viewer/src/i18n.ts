import { editor as enEditor } from "../../../apps/desktop/src/lib/i18n/dictionaries/en/editor";
import { schemaRecovery as enSchemaRecovery } from "../../../apps/desktop/src/lib/i18n/dictionaries/en/error";
import { print as enPrint } from "../../../apps/desktop/src/lib/i18n/dictionaries/en/print";
import { shape as enShape } from "../../../apps/desktop/src/lib/i18n/dictionaries/en/shape";
import { tex as enTex } from "../../../apps/desktop/src/lib/i18n/dictionaries/en/tex";
import { workspace as enWorkspace } from "../../../apps/desktop/src/lib/i18n/dictionaries/en/workspace";
import { editor as jaEditor } from "../../../apps/desktop/src/lib/i18n/dictionaries/ja/editor";
import { schemaRecovery as jaSchemaRecovery } from "../../../apps/desktop/src/lib/i18n/dictionaries/ja/error";
import { print as jaPrint } from "../../../apps/desktop/src/lib/i18n/dictionaries/ja/print";
import { shape as jaShape } from "../../../apps/desktop/src/lib/i18n/dictionaries/ja/shape";
import { tex as jaTex } from "../../../apps/desktop/src/lib/i18n/dictionaries/ja/tex";
import { workspace as jaWorkspace } from "../../../apps/desktop/src/lib/i18n/dictionaries/ja/workspace";

const UI_LOCALE_STORAGE_KEY = "sigma-studio:ui-locale";
const resources = {
  en: {
    editor: enEditor,
    error: { schemaRecovery: enSchemaRecovery },
    print: enPrint,
    shape: enShape,
    tex: enTex,
    workspace: enWorkspace,
  },
  ja: {
    editor: jaEditor,
    error: { schemaRecovery: jaSchemaRecovery },
    print: jaPrint,
    shape: jaShape,
    tex: jaTex,
    workspace: jaWorkspace,
  },
} as const;

type ViewerLocale = keyof typeof resources;
type ViewerNamespace = keyof (typeof resources)[ViewerLocale];
export type AppLocale = ViewerLocale;
export type Translate<Ns extends ViewerNamespace = ViewerNamespace> = ((
  key: string,
  values?: Record<string, unknown>,
) => string) & { readonly __namespace?: Ns };
export const SUPPORTED_LOCALES = ["ja", "en"] as const;
export const DEFAULT_LOCALE: AppLocale = "ja";

function getLocale(): ViewerLocale {
  if (typeof window === "undefined") return "ja";
  try {
    const stored = window.localStorage.getItem(UI_LOCALE_STORAGE_KEY);
    if (stored === "en" || stored === "ja") return stored;
  } catch {
    // Sandboxed viewers may not have storage access; browser language still works.
  }
  return window.navigator.languages.some((language) =>
    language.toLowerCase().startsWith("ja"),
  )
    ? "ja"
    : "en";
}

function translate(
  locale: ViewerLocale,
  namespace: ViewerNamespace,
  key: string,
  values?: Record<string, unknown>,
): string {
  let value: unknown = resources[locale][namespace];
  for (const segment of key.split(".")) {
    if (!value || typeof value !== "object" || !(segment in value)) return key;
    value = (value as Record<string, unknown>)[segment];
  }
  if (typeof value !== "string") return key;
  return value.replace(/\{\{([^}]+)\}\}/gu, (_match, name: string) =>
    String(values?.[name] ?? ""),
  );
}

/** Viewer-only translator for schema recovery diagnostics. */
export function createCurrentLocaleTranslator(namespace: ViewerNamespace) {
  return (key: string, values?: Record<string, unknown>) =>
    translate(getLocale(), namespace, key, values);
}

export function createTranslator<Ns extends ViewerNamespace>(
  locale: AppLocale,
  namespace: Ns,
): Translate<Ns> {
  return (key, values) => translate(locale, namespace, key, values);
}
