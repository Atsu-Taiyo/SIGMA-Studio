import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { auditNpmTarball } from "./audit-npm-tarballs.mjs";

const require = createRequire(import.meta.url);
const tar = require("tar");
const expected = { name: "@sigma-studio/editor", version: "0.469.0" };
const environment = { RELEASE_CONTENT_RULES: JSON.stringify(["blocked-example"]) };

async function withPackage(overrides, check, link = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-npm-audit-"));
  try {
    const files = {
      "package.json": JSON.stringify({ ...expected, license: "MIT", repository: { url: "git+https://github.com/Atsu-Taiyo/SIGMA-Studio.git" }, dependencies: { "@sigma-studio/viewer": expected.version } }),
      LICENSE: "Permission is hereby granted",
      "README.md": "Package usage",
      "THIRD_PARTY_NOTICES.md": "## katex\n## mathlive\nSIL OPEN FONT LICENSE",
      "dist/index.js": "export const value = 1;",
      "dist/index.d.ts": "export declare const value: number;",
      "dist/styles.css": ".sigma-editor {}",
      ...overrides,
    };
    const entries = [];
    for (const [name, content] of Object.entries(files)) {
      if (content === null) continue;
      const file = path.join(root, "package", name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, content);
      entries.push(`package/${name}`);
    }
    if (link) {
      await symlink("index.js", path.join(root, "package/dist/link.js"));
      entries.push("package/dist/link.js");
    }
    const archive = path.join(root, "package.tgz");
    await tar.c({ cwd: root, file: archive, gzip: true }, entries);
    await check(archive);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("npm audit checks the actual compressed package and reports its integrity", async () => {
  await withPackage({}, async (archive) => {
    const result = await auditNpmTarball(archive, expected, environment);
    assert.equal(result.files, 7);
    assert.equal(result.name, expected.name);
    assert.match(result.integrity, /^sha512-[A-Za-z0-9+/=]+$/);
  });
});

test("npm audit fails closed without valid content rules", async () => {
  for (const value of [undefined, "[]", "invalid", '["["]', '[null]']) {
    await assert.rejects(auditNpmTarball("unused", expected, { RELEASE_CONTENT_RULES: value }), /configuration/);
  }
});

test("npm audit rejects blocked contents and names without printing the match", async () => {
  for (const overrides of [{ "dist/index.js": "blocked-example" }, { "dist/blocked-example.js": "safe" }]) {
    await withPackage(overrides, async (archive) => {
      await assert.rejects(auditNpmTarball(archive, expected, environment), (error) => {
        assert.match(error.message, /content policy/);
        assert.doesNotMatch(error.message, /blocked-example|index\.js/);
        return true;
      });
    });
  }
});

test("npm audit rejects credentials, source maps, unshipped source and symlinks", async () => {
  for (const overrides of [
    { "dist/index.js": "ghp_" + "a".repeat(36) },
    { "dist/index.js.map": "{}" },
    { "src/source.ts": "export {};" },
    { ".env": "EXAMPLE=1" },
  ]) {
    await withPackage(overrides, async (archive) => {
      await assert.rejects(auditNpmTarball(archive, expected, environment), /content policy|Unexpected package entry/);
    });
  }
  await withPackage({}, async (archive) => {
    await assert.rejects(auditNpmTarball(archive, expected, environment), /Unexpected package entry/);
  }, true);
});

test("npm audit requires entrypoints, licenses and the correct release identity", async () => {
  for (const overrides of [
    { "dist/index.d.ts": null },
    { LICENSE: "" },
    { "THIRD_PARTY_NOTICES.md": "missing notices" },
    { "package.json": JSON.stringify({ ...expected, version: "0.1.0" }) },
  ]) {
    await withPackage(overrides, async (archive) => {
      await assert.rejects(auditNpmTarball(archive, expected, environment), /missing or empty|notices|identity/);
    });
  }
});

test("npm audit rejects a mismatched Viewer dependency", async () => {
  await withPackage({ "package.json": JSON.stringify({ ...expected, license: "MIT", repository: { url: "git+https://github.com/Atsu-Taiyo/SIGMA-Studio.git" }, dependencies: { "@sigma-studio/viewer": "0.1.0" } }) }, async (archive) => {
    await assert.rejects(auditNpmTarball(archive, expected, environment), /matching Viewer/);
  });
});
