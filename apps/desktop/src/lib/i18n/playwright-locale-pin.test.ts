import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const desktopRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("e2e locale pin", () => {
  it("pins the Playwright browser locale to Japanese", async () => {
    // 既定ロケールは ja だが、レンダラは保存値が無ければブラウザロケールを見る。
    // ここを固定しないと、OS ロケールが en の環境で e2e が英語 UI を相手にし、
    // 日本語をアサートしている既存 spec が一斉に落ちる。
    const source = await readFile(path.join(desktopRoot, "playwright.config.ts"), "utf8");
    const useBlock = /use:\s*\{([\s\S]*?)\n\s{2}\}/u.exec(source)?.[1] ?? "";
    expect(useBlock).toMatch(/locale:\s*"ja-JP"/u);
  });
});
