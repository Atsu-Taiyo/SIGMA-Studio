import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readOwnedSourceGraph } from "../../../tests/helpers/owned-source-graph";

import { createTranslator } from "@/lib/i18n";
import {
  buildLineToolItems,
  buildShapeGallerySections,
  buildShapeTypeChangeSections,
} from "./overlay-canvas/shape-gallery";

/**
 * WI-6 の受け入れ条件を実測で固定する:
 * **英語ロケールで図形・グラフ・数式・紙面の UI に日本語が残らない**。
 *
 * namespace 単位の検査 (`shape-resolution.test.ts` / `editor-resolution.test.ts`) は
 * 「その辞書の値」しか見ない。面が**別 namespace のキー**を引いていると
 * (この面は `chrome.format.*` を共有している)、そちらの抜けは素通りする。
 * ここは逆向きに、**面のソースが実際に引いているキー**を集めて英語で解決する。
 */

const desktopRoot = fileURLToPath(new URL("../../../", import.meta.url));
const JAPANESE = /[぀-ヿ一-鿿]/u;

/**
 * 面ごとの「翻訳関数の識別子 → namespace」。
 * 新しい namespace のフックを足したらここも更新する必要がある (下のテストが強制する)。
 */
const SURFACES = {
  "src/components/editor/EditorSettings.tsx": { t: "chrome", tShape: "shape", tChrome: "chrome" },
  "src/components/editor/GraphSettingsPanel.tsx": { t: "shape" },
  "src/components/editor/Graph3DSettingsPanel.tsx": { tShape: "shape" },
  "src/components/editor/overlay-canvas/shape-gallery.tsx": { t: "shape" },
  "src/components/editor/OverlayCanvasEditorClient.tsx": { t: "shape", tShape: "shape", tChrome: "chrome" },
  "src/components/editor/PageCanvasEditor.tsx": { t: "editor", tEditor: "editor", tEditorText: "editor", tSettings: "settings" },
} as const;

// Include moved owners through real import edges, so extracting a view cannot remove
// its translation keys from this contract. Keep namespaces explicit per family.
const surfaceFiles: Record<string, Record<string, string>> = { ...SURFACES };
for (const [entry, directory] of [
  ["OverlayCanvasEditorClient.tsx", "overlay-canvas"],
  ["PageCanvasEditor.tsx", "page-canvas"],
] as const) {
  const entryFile = `src/components/editor/${entry}`;
  const known = surfaceFiles[entryFile];
  for (const file of readOwnedSourceGraph(
    path.join(desktopRoot, entryFile),
    path.join(desktopRoot, "src/components/editor", directory),
    path.join(desktopRoot, "src"),
  ).keys()) {
    surfaceFiles[path.relative(desktopRoot, file)] = known;
  }
}

Object.assign(surfaceFiles, {
  "src/components/editor/overlay-canvas/table-shape-editor.tsx": {
    t: "chrome", tChrome: "chrome", tShape: "shape", tSettings: "settings",
  },
  "src/components/editor/overlay-canvas/shapes/table-editor-model.ts": { t: "settings" },
  "src/components/editor/page-canvas/WhiteboardBackgroundControl.tsx": { t: "shape" },
});

type Reference = { file: string; fn: string; ns: string; key: string };

function read(file: string): string {
  return readFileSync(path.join(desktopRoot, file), "utf8");
}

function referencesIn(file: string): Reference[] {
  const source = read(file);
  const known = surfaceFiles[file];
  const out: Reference[] = [];
  for (const match of source.matchAll(/(?<![A-Za-z0-9_])(t[A-Za-z0-9_]*)\(\s*"([a-zA-Z0-9_.]+)"/gu)) {
    const fn = match[1] ?? "";
    const ns = known[fn];
    if (!ns) {
      continue;
    }
    out.push({ file, fn, ns, key: match[2] ?? "" });
  }
  return out;
}

const REFERENCES = Object.keys(surfaceFiles).flatMap(referencesIn);

describe("shape, graph, math and page surfaces in English", () => {
  it("collects a meaningful number of references (a broken scan must not pass silently)", () => {
    expect(REFERENCES.length).toBeGreaterThan(180);
    for (const file of Object.keys(SURFACES).filter((file) => !file.endsWith("CanvasEditor.tsx") && !file.endsWith("CanvasEditorClient.tsx"))) {
      expect(referencesIn(file).length, file).toBeGreaterThan(2);
    }
    expect(REFERENCES.filter(({ file }) => file.includes("overlay-canvas/")).length).toBeGreaterThan(30);
    expect(REFERENCES.filter(({ file }) => file.includes("PageCanvasEditor") || file.includes("page-canvas/")).length).toBeGreaterThan(20);
  });

  it("declares every translator the surfaces actually use", () => {
    // `useT("…")` を足したのに上の対応表へ書き忘れると、そのフックのキーが検査から
    // 丸ごと漏れる。宣言の側から突き合わせて、漏れをここで落とす。
    const undeclared: string[] = [];
    for (const [file, known] of Object.entries(surfaceFiles)) {
      for (const match of read(file).matchAll(/const\s+(t[A-Za-z0-9_]*)\s*=\s*useT\(\s*"([a-z]+)"/gu)) {
        const fn = match[1] ?? "";
        const ns = match[2] ?? "";
        if ((known as Record<string, string>)[fn] !== ns) {
          undeclared.push(`${file}: ${fn} = useT("${ns}")`);
        }
      }
    }
    expect(undeclared).toEqual([]);
  });

  it("resolves every referenced key in English without falling back to Japanese", () => {
    // `fallbackLng: "ja"` があるので、英語のキーが無くても「引ける」検査は緑のまま
    // 日本語が返る。返り値そのものを見るのが唯一の網。
    const leaked = REFERENCES.filter(({ ns, key }) => {
      const value = createTranslator("en", ns as "shape")(key as never) as unknown as string;
      return typeof value !== "string" || value.length === 0 || value === key || JAPANESE.test(value);
    }).map(({ file, ns, key }) => `${file}: ${ns}.${key}`);
    expect([...new Set(leaked)].sort()).toEqual([]);
  });

  it("names every shape the gallery offers in English", () => {
    // ギャラリーは辞書を直接引かず builder 越しに組み立てるので、組み上がった
    // ラベルの側からも見る (`{{sides}}` のような補間が残らないことも同時に見る)。
    const t = createTranslator("en", "shape");
    const labels = [
      ...buildLineToolItems(t).map((item) => item.label),
      ...buildShapeGallerySections(t).flatMap((section) => [section.label, ...section.items.map((item) => item.label)]),
      ...buildShapeTypeChangeSections(t).flatMap((section) => [section.label, ...section.items.map((item) => item.label)]),
    ];
    expect(labels.length).toBeGreaterThan(30);
    expect(labels.filter((label) => JAPANESE.test(label))).toEqual([]);
    expect(labels.filter((label) => label.includes("{{"))).toEqual([]);
    expect(labels.filter((label) => label.trim().length === 0)).toEqual([]);
  });
});
