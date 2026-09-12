import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, expectTypeOf, it } from "vitest";

import { getModuleSpecifiers as importSpecifiers } from "../../../tests/helpers/source-dependencies";

import type { SelectedInlineMath } from "@/components/editor/EditorSettings";
import type { SaveState } from "@/components/editor/editor-shell/types";

import type { EditorSaveState, EditorSelectedInlineMath } from "./types";

function sourceFiles(directory: URL): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) {
      return sourceFiles(child);
    }
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [fileURLToPath(child)] : [];
  });
}

function productionSourceFiles(directory: URL): string[] {
  return sourceFiles(directory).filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"));
}

describe("editor-state feature boundary", () => {
  const files = productionSourceFiles(new URL("./", import.meta.url));

  it("holds editor state without reaching into the component tree or the editor engine", () => {
    // ストアは「どう描くか」を知らない層。ここが components / react-dom / Tiptap を掴むと、
    // 状態の置き場所がまた UI ツリーの形に縛られ、局所購読の意味が無くなる。
    const offenders = files.flatMap((file) => {
      const specifiers = importSpecifiers(readFileSync(file, "utf8"));
      return specifiers
        .filter((specifier) => (
          specifier.startsWith("@/components/")
          || specifier.startsWith("@/lib/")
          || specifier === "react-dom"
          || specifier.startsWith("react-dom/")
          || specifier.startsWith("@tiptap/")
          || specifier === "next"
          || specifier.startsWith("next/")
          || specifier === "electron"
        ))
        .map((specifier) => `${file}: ${specifier}`);
    });

    expect(offenders).toEqual([]);
    expect(files.length).toBeGreaterThan(5);
  });

  it("takes its document vocabulary from the document feature, not the renderer types", () => {
    const offenders = files.flatMap((file) => {
      const specifiers = importSpecifiers(readFileSync(file, "utf8"));
      return specifiers
        .filter((specifier) => specifier.startsWith("@/types/"))
        .map((specifier) => `${file}: ${specifier}`);
    });

    expect(offenders).toEqual([]);
  });

  it("keeps its state vocabulary identical to the component types it replaces", () => {
    // 型を 2 か所に書くと必ずずれる。ここで固定しておけば、片方だけ変えたときに落ちる。
    expectTypeOf<EditorSaveState>().toEqualTypeOf<SaveState>();
    expectTypeOf<EditorSelectedInlineMath>().toEqualTypeOf<SelectedInlineMath>();
  });
});
