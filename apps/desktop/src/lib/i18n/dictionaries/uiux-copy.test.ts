import { expect, it } from "vitest";
import { createTranslator } from "@/lib/i18n";

it.each([
  ["ja", "作成して開く", "作成のみ", "sigmaファイルをエクスポート"],
  ["en", "Create and open", "Create only", "Export sigma file"],
] as const)("keeps the %s workspace actions and export label in sync", (locale, createOpen, createOnly, exportLabel) => {
  const workspace = createTranslator(locale, "workspace");
  const chrome = createTranslator(locale, "chrome");
  expect(workspace("action.createAndOpen")).toBe(createOpen);
  expect(workspace("action.createOnly")).toBe(createOnly);
  expect(chrome("appMenu.file.exportJson")).toBe(exportLabel);
  expect(chrome("appMenu.file.exportJson")).not.toMatch(/JSON/);
});
