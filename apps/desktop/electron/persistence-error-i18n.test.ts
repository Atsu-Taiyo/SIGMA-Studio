import { afterEach, describe, expect, it } from "vitest";

import { setAppLocale } from "@/lib/i18n";
import { LedgerSchemaError } from "./ledger-schema-error";
import { LocalMaterialStore } from "./local-material-store";

describe("persistence error i18n", () => {
  afterEach(() => {
    setAppLocale("ja");
  });

  it("resolves store errors in the locale active when the operation runs", async () => {
    const store = new LocalMaterialStore("/unused");

    setAppLocale("en");
    await expect(store.createMaterial({ name: "invalid", content: null } as never))
      .rejects.toThrow("The material content is invalid.");

    setAppLocale("ja");
    await expect(store.createMaterial({ name: "invalid", content: null } as never))
      .rejects.toThrow("素材の内容が正しくありません。");
  });

  it("resolves ledger errors when they are constructed", () => {
    setAppLocale("en");
    expect(new LedgerSchemaError({} as never).message)
      .toBe("The teaching-material library index does not match the current schema.");
  });
});
