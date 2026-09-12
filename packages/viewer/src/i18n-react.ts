"use client";

import { useMemo, useSyncExternalStore } from "react";

import { print as enPrint } from "../../../apps/desktop/src/lib/i18n/dictionaries/en/print";
import { shape as enShape } from "../../../apps/desktop/src/lib/i18n/dictionaries/en/shape";
import { print as jaPrint } from "../../../apps/desktop/src/lib/i18n/dictionaries/ja/print";
import { shape as jaShape } from "../../../apps/desktop/src/lib/i18n/dictionaries/ja/shape";

const UI_LOCALE_STORAGE_KEY = "sigma-studio:ui-locale";
const UI_LOCALE_CHANGE_EVENT = "sigma-studio:ui-locale-change";
const resources = {
  en: { print: enPrint, shape: enShape },
  ja: { print: jaPrint, shape: jaShape },
} as const;

type ViewerLocale = keyof typeof resources;
type ViewerNamespace = keyof (typeof resources)[ViewerLocale];

function getBrowserLocale(): ViewerLocale {
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

function subscribeLocale(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handleStorage = (event: StorageEvent) => {
    if (event.key === UI_LOCALE_STORAGE_KEY || event.key === null) onChange();
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener(UI_LOCALE_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(UI_LOCALE_CHANGE_EVENT, onChange);
  };
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

/** Viewer-only translation hook. Keeping its two read-only namespaces local prevents
 * desktop settings, updater, and AI dictionaries from entering the public bundle. */
export function useT(namespace: ViewerNamespace) {
  const locale = useSyncExternalStore(
    subscribeLocale,
    getBrowserLocale,
    () => "ja" as const,
  );
  return useMemo(
    () => (key: string, values?: Record<string, unknown>) =>
      translate(locale, namespace, key, values),
    [locale, namespace],
  );
}
