import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const preloadSource = readFileSync(fileURLToPath(new URL("./preload.ts", import.meta.url)), "utf8");

describe("preload bridge surface", () => {
  it("does not expose cloud workspace IPC channels", () => {
    expect(preloadSource).not.toMatch(/cloud-workspace:/u);
    expect(preloadSource).not.toMatch(/cloudWorkspace/u);
  });

  it("does not expose auth redirect or auth callback helpers", () => {
    expect(preloadSource).not.toMatch(/getRedirectUrl/u);
    expect(preloadSource).not.toMatch(/auth:/u);
  });

  it("keeps the external link bridge used by AI login and reference links", () => {
    expect(preloadSource).toMatch(/shell:open-external/u);
  });

  it("exposes the UI locale setter on the settings namespace", () => {
    // 新チャンネルは既存の `settings:` 接頭辞に揃える。`auth:` 禁止パターンに
    // 引っかからず、preload の面が settings に一本化されるため。
    expect(preloadSource).toMatch(/settings:set-ui-locale/u);
    expect(preloadSource).toMatch(/setUiLocale/u);
  });

  it("exposes the workspace preview disk cache bridge", () => {
    expect(preloadSource).toMatch(/workspace-preview:get/u);
    expect(preloadSource).toMatch(/workspace-preview:put/u);
  });
});
