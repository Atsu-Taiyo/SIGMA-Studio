import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import { EXTENSION_MENU_LIMITS } from "@/lib/extension-contracts";

import { digest, validateCatalog, verifyCatalog, type CatalogPlugin } from "./manifest";

const worker = Buffer.from("// worker\nmodule.exports = {};\n");

function plugin(contributes?: unknown): CatalogPlugin {
  return {
    id: "sample-tool", name: "サンプル", description: "説明", version: "1.0.0", minAppVersion: "0.510.0",
    entry: "worker.cjs", capabilities: ["document-conversion"],
    files: [{ path: "worker.cjs", kind: "code", sha256: digest(worker), bytes: worker.length }],
    ...(contributes === undefined ? {} : { contributes: contributes as CatalogPlugin["contributes"] }),
  };
}

const catalog = (...plugins: CatalogPlugin[]) => ({ schema: 1, sequence: 1, plugins });
const button = (id: string, overrides: Record<string, unknown> = {}) => ({
  type: "button", id, label: "取り込む", action: { type: "import-file", command: "convert", extensions: [".smp"] }, ...overrides,
});
const menu = (...items: unknown[]) => ({ menu: { sections: [{ title: "見出し", items }] } });

describe("catalog menu contributions", () => {
  it("accepts a catalog without a menu and with a full menu", () => {
    expect(() => validateCatalog(catalog(plugin()))).not.toThrow();
    expect(() => validateCatalog(catalog(plugin(menu(
      { type: "text", text: "説明文" }, button("import-sample", { icon: "file-input", description: "補足" }), { type: "separator" },
    ))))).not.toThrow();
  });

  it.each([
    ["an unknown item type", menu({ type: "iframe", src: "https://example.test" })],
    ["an unknown action", menu(button("import-sample", { action: { type: "run-shell", command: "convert", extensions: [".smp"] } }))],
    ["a malformed command id", menu(button("import-sample", { action: { type: "import-file", command: "Bad Command", extensions: [".smp"] } }))],
    ["an extension without a dot", menu(button("import-sample", { action: { type: "import-file", command: "convert", extensions: ["smp"] } }))],
    ["a path-like extension", menu(button("import-sample", { action: { type: "import-file", command: "convert", extensions: ["../x"] } }))],
    ["no extensions", menu(button("import-sample", { action: { type: "import-file", command: "convert", extensions: [] } }))],
    ["an icon outside the fixed set", menu(button("import-sample", { icon: "https://example.test/x.png" }))],
    ["a duplicate item id", menu(button("import-sample"), button("import-sample"))],
    ["a control character in a label", menu(button("import-sample", { label: "取り込\u0007む" }))],
    ["a label that is too long", menu(button("import-sample", { label: "あ".repeat(EXTENSION_MENU_LIMITS.label + 1) }))],
    ["an empty text", menu({ type: "text", text: "  " })],
    ["an empty section list", { menu: { sections: [] } }],
    ["a section without items", { menu: { sections: [{ title: "見出し", items: [] }] } }],
    ["too many sections", { menu: { sections: Array.from({ length: EXTENSION_MENU_LIMITS.sections + 1 }, () => ({ items: [{ type: "separator" }] })) } }],
    ["too many items", menu(...Array.from({ length: EXTENSION_MENU_LIMITS.items + 1 }, (_, index) => button(`item-${index}`)))],
    ["a non-object contributes", "menu"],
  ])("rejects %s", (_name, contributes) => {
    expect(() => validateCatalog(catalog(plugin(contributes)))).toThrow("verification-failed");
  });

  it.each([
    ["a list of too many prefixes", Array.from({ length: 9 }, (_, index) => `Own${index}`)],
    ["a prefix with a punctuation character", ["Own/Brand"]],
    ["an empty prefix", [""]],
    ["an over-long prefix", ["a".repeat(41)]],
    ["a non-list", "Own"],
  ])("rejects %s for the extension's own font prefixes", (_name, prefixes) => {
    expect(() => validateCatalog(catalog({ ...plugin(), ownFontFamilyPrefixes: prefixes as string[] }))).toThrow("verification-failed");
  });

  it("accepts the extension's own font prefixes", () => {
    expect(() => validateCatalog(catalog({ ...plugin(), ownFontFamilyPrefixes: ["Own Brand", "Other-Face"] }))).not.toThrow();
  });

  it("rejects an unknown capability", () => {
    expect(() => validateCatalog(catalog({ ...plugin(), capabilities: ["shell"] }))).toThrow("verification-failed");
  });

  it("verifies the signature before looking at the content", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pem = publicKey.export({ type: "spki", format: "pem" }) as string;
    const payload = Buffer.from(JSON.stringify(catalog(plugin(menu(button("import-sample"))))));
    const envelope = { payload: payload.toString("base64"), signature: sign(null, payload, privateKey).toString("base64") };
    expect(verifyCatalog(envelope, pem).plugins[0].contributes?.menu?.sections).toHaveLength(1);
    const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }) as string;
    expect(() => verifyCatalog(envelope, other)).toThrow("verification-failed");
    const forged = Buffer.from(JSON.stringify(catalog(plugin(menu(button("evil-item")))))).toString("base64");
    expect(() => verifyCatalog({ ...envelope, payload: forged }, pem)).toThrow("verification-failed");
  });
});
