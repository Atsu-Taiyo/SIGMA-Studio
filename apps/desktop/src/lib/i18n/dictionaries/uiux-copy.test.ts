import { expect, it } from "vitest";
import { createTranslator } from "@/lib/i18n";

it.each([
  ["ja", "作成して開く", "作成のみ", "sigmaファイルをエクスポート", "使い方マニュアル"],
  ["en", "Create and open", "Create only", "Export sigma file", "User manual"],
] as const)("keeps the %s workspace actions, export label and local manual in sync", (locale, createOpen, createOnly, exportLabel, manualTitle) => {
  const workspace = createTranslator(locale, "workspace");
  const chrome = createTranslator(locale, "chrome");
  expect(workspace("action.createAndOpen")).toBe(createOpen);
  expect(workspace("action.createOnly")).toBe(createOnly);
  expect(chrome("appMenu.file.exportJson")).toBe(exportLabel);
  expect(chrome("appMenu.file.exportJson")).not.toMatch(/JSON/);
  expect(workspace("manual.title")).toBe(manualTitle);
  expect(chrome("appMenu.settings.manual")).toBe(manualTitle);
  expect(workspace("manual.sections.export.body")).toContain(".sigma");
});
