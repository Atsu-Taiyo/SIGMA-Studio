import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  detectLocale,
  isAppLocale,
  normalizeLocale,
  readNavigatorLanguages,
} from "./locale";

describe("normalizeLocale", () => {
  it("maps a Japanese BCP 47 tag to ja", () => {
    expect(normalizeLocale("ja-JP")).toBe("ja");
  });

  it("maps an English BCP 47 tag to en", () => {
    expect(normalizeLocale("en-US")).toBe("en");
  });

  it("is case insensitive", () => {
    expect(normalizeLocale("JA")).toBe("ja");
  });

  it("accepts the underscore form some platforms report", () => {
    expect(normalizeLocale("en_GB")).toBe("en");
  });

  it("returns null for an unsupported language", () => {
    expect(normalizeLocale("fr")).toBeNull();
  });

  it("returns null for a language whose tag merely starts with a supported one", () => {
    // "jam" (Jamaican Creole) shares its first two letters with "ja" but is a
    // different primary subtag: prefix matching would silently claim it.
    expect(normalizeLocale("jam-JM")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(normalizeLocale(undefined)).toBeNull();
  });

  it("returns null for null", () => {
    expect(normalizeLocale(null)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(normalizeLocale("")).toBeNull();
  });
});

describe("detectLocale", () => {
  it("returns the first supported tag in preference order", () => {
    expect(detectLocale(["fr-FR", "en-US", "ja-JP"])).toBe("en");
  });

  it("returns null when no tag is supported", () => {
    expect(detectLocale(["fr-FR", "de-DE"])).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(detectLocale([])).toBeNull();
  });

  it("returns null when navigator is absent (Node / Vitest)", () => {
    // The default argument must not throw where `navigator` is undefined, and
    // it must not invent a locale: every non-browser caller falls back to ja.
    vi.stubGlobal("navigator", undefined);
    expect(detectLocale()).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("readNavigatorLanguages", () => {
  it("returns an empty list when navigator is absent", () => {
    vi.stubGlobal("navigator", undefined);
    expect(readNavigatorLanguages()).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("prefers navigator.languages", () => {
    vi.stubGlobal("navigator", { languages: ["en-US", "ja-JP"], language: "ja-JP" });
    expect(readNavigatorLanguages()).toEqual(["en-US", "ja-JP"]);
    vi.unstubAllGlobals();
  });

  it("falls back to navigator.language when languages is empty", () => {
    vi.stubGlobal("navigator", { languages: [], language: "ja-JP" });
    expect(readNavigatorLanguages()).toEqual(["ja-JP"]);
    vi.unstubAllGlobals();
  });

  it("returns an empty list when neither field is usable", () => {
    vi.stubGlobal("navigator", {});
    expect(readNavigatorLanguages()).toEqual([]);
    vi.unstubAllGlobals();
  });
});

describe("locale constants", () => {
  it("defaults to Japanese so every non-browser caller stays Japanese", () => {
    expect(DEFAULT_LOCALE).toBe("ja");
  });

  it("supports exactly ja and en", () => {
    expect(SUPPORTED_LOCALES).toEqual(["ja", "en"]);
  });

  it("recognises supported locales", () => {
    expect(isAppLocale("ja")).toBe(true);
    expect(isAppLocale("en")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isAppLocale("fr")).toBe(false);
    expect(isAppLocale(undefined)).toBe(false);
    expect(isAppLocale(42)).toBe(false);
  });
});
