import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import messagesModule from "./windows-store-messages.cjs";

const { resolveCliLocale, windowsStoreMessages } = messagesModule;
const require = createRequire(import.meta.url);
const builderConfigPath = require.resolve("../electron-builder.config.cjs");
const storeEnvironmentKeys = [
  "SIGMA_STUDIO_WINDOWS_STORE",
  "WINDOWS_STORE_IDENTITY_NAME",
  "WINDOWS_STORE_PUBLISHER",
  "WINDOWS_STORE_PUBLISHER_DISPLAY_NAME",
  "LC_ALL",
  "LC_MESSAGES",
  "LANG",
];
const originalEnvironment = Object.fromEntries(storeEnvironmentKeys.map((key) => [key, process.env[key]]));

function loadBuilderConfig() {
  delete require.cache[builderConfigPath];
  return require(builderConfigPath);
}

afterEach(() => {
  for (const key of storeEnvironmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  delete require.cache[builderConfigPath];
});

describe("Windows Store build messages", () => {
  it("follows Japanese and English shell locales", () => {
    expect(resolveCliLocale({ LANG: "ja_JP.UTF-8" })).toBe("ja");
    expect(resolveCliLocale({ LANG: "en_US.UTF-8" })).toBe("en");
  });

  it("falls back to English for an unsupported shell locale", () => {
    expect(resolveCliLocale({ LANG: "fr_FR.UTF-8" })).toBe("en");
  });

  it("uses the Windows system locale when shell locale variables are absent", () => {
    expect(resolveCliLocale({}, "ja-JP")).toBe("ja");
    expect(resolveCliLocale({}, "en-US")).toBe("en");
    expect(resolveCliLocale({}, "")).toBe("ja");
  });

  it("reports missing Partner Center values in both locales", () => {
    const variables = ["WINDOWS_STORE_IDENTITY_NAME"];

    expect(windowsStoreMessages({ LANG: "ja_JP.UTF-8" }).missingIdentity(variables))
      .toContain("製品ID");
    expect(windowsStoreMessages({ LANG: "en_US.UTF-8" }).missingIdentity(variables))
      .toContain("product identity");
  });

  it("wires both locales into the Store builder configuration", () => {
    Object.assign(process.env, {
      SIGMA_STUDIO_WINDOWS_STORE: "true",
      WINDOWS_STORE_IDENTITY_NAME: "example.identity",
      WINDOWS_STORE_PUBLISHER: "CN=Example",
      WINDOWS_STORE_PUBLISHER_DISPLAY_NAME: "Example",
    });

    const config = loadBuilderConfig();
    expect(config.win.target).toBe("appx");
    expect(config.appx.languages).toEqual(["ja-JP", "en-US"]);
  });

  it("localizes the builder error for missing Store identity values", () => {
    Object.assign(process.env, {
      SIGMA_STUDIO_WINDOWS_STORE: "true",
      LC_ALL: "ja_JP.UTF-8",
      LANG: "ja_JP.UTF-8",
    });
    delete process.env.WINDOWS_STORE_IDENTITY_NAME;
    delete process.env.WINDOWS_STORE_PUBLISHER;
    delete process.env.WINDOWS_STORE_PUBLISHER_DISPLAY_NAME;

    expect(() => loadBuilderConfig()).toThrow("製品ID情報");
  });
});
