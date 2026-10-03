import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { getModuleSpecifiers } from "../../../tests/helpers/source-dependencies";

function productionSourceFiles(directory: URL): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return productionSourceFiles(new URL(`${entry.name}/`, directory));
    }
    return entry.isFile()
      && /\.tsx?$/.test(entry.name)
      && !entry.name.includes(".test.")
      ? [fileURLToPath(new URL(entry.name, directory))]
      : [];
  });
}

const pocketRoot = new URL("./", import.meta.url);
const pocketFiles = productionSourceFiles(pocketRoot);
const modelFiles = productionSourceFiles(new URL("model/", import.meta.url));
const viewFiles = productionSourceFiles(new URL("view/", import.meta.url));

function specifiersOf(file: string): string[] {
  return getModuleSpecifiers(readFileSync(file, "utf8"));
}

describe("pocket boundaries", () => {
  it("keeps the model free of React, the DOM and any editor surface", () => {
    expect(modelFiles.length).toBeGreaterThan(0);
    for (const file of modelFiles) {
      const forbidden = specifiersOf(file).filter((specifier) => (
        specifier === "react"
        || specifier.startsWith("react-dom")
        || specifier.startsWith("@/components/")
        || specifier.startsWith("@/features/pocket/")
        || specifier.startsWith("../application")
        || specifier.startsWith("../view")
      ));
      expect({ file, forbidden }).toEqual({ file, forbidden: [] });
    }
  });

  it("does not depend on AI, Electron or the document store", () => {
    for (const file of pocketFiles) {
      const forbidden = specifiersOf(file).filter((specifier) => (
        specifier.startsWith("@/features/ai-edit")
        || specifier.startsWith("@/lib/ai/")
        || specifier.startsWith("@/features/document-session")
        || specifier.startsWith("@/lib/runtime")
        || specifier.startsWith("@/lib/storage")
        || specifier === "electron"
      ));
      expect({ file, forbidden }).toEqual({ file, forbidden: [] });
    }
  });

  it("never persists or sends what it holds: the pocket is a local work bench, not part of any material", () => {
    // 共有していても相手には見えない、教材にも履歴にも載らない、が成り立つのは、ポケットの
    // 実装がどこにも書き出さないから。書き出す API が現れたら、設計を見直す合図として落とす。
    const persistence = /\b(localStorage|sessionStorage|indexedDB|desktopAPI|BroadcastChannel|fetch|XMLHttpRequest|WebSocket|navigator\.clipboard)\b/;
    for (const file of pocketFiles) {
      const source = readFileSync(file, "utf8")
        // コメントの中の説明は数えない。
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect({ file, match: persistence.exec(source)?.[0] ?? null }).toEqual({ file, match: null });
    }
  });

  it("draws previews without injecting markup", () => {
    // 図形の SVG は <img> の data URL で描く。DOM へ文字列を展開する注入点は増やさない
    // (features/rendering/architecture.test.ts がその一覧を固定している)。
    for (const file of viewFiles) {
      expect({ file, injects: readFileSync(file, "utf8").includes("dangerouslySetInnerHTML") })
        .toEqual({ file, injects: false });
    }
  });

  it("is not imported by the document, drawing, rendering or text-editing cores", () => {
    const cores = ["document", "drawing", "rendering", "text-editing"]
      .flatMap((name) => productionSourceFiles(new URL(`../${name}/`, import.meta.url)));
    const importers = cores.filter((file) => specifiersOf(file).some((specifier) => specifier.startsWith("@/features/pocket")));

    expect(importers).toEqual([]);
  });

  it("exposes the feature only through its index", () => {
    const outside = productionSourceFiles(new URL("../../", import.meta.url))
      .filter((file) => !file.startsWith(fileURLToPath(pocketRoot)));
    const deepImports = outside.flatMap((file) => specifiersOf(file)
      .filter((specifier) => specifier.startsWith("@/features/pocket/"))
      .map((specifier) => ({ file: file.replace(fileURLToPath(new URL("../../", import.meta.url)), ""), specifier })));

    expect(deepImports).toEqual([]);
  });
});
