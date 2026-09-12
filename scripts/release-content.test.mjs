import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { createPackage } = require("@electron/asar");
const { auditReleaseContent } = require("../apps/desktop/scripts/audit-release-content.cjs");
const environment = { RELEASE_CONTENT_RULES: JSON.stringify(["blocked-example"]), SIGMA_STUDIO_REQUIRE_RELEASE_AUDIT: "true" };

test("release audit checks archive contents and unpacked resources without exposing matches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sigma-audit-"));
  try {
    const source = path.join(root, "source");
    const resources = path.join(root, "resources");
    await mkdir(source);
    await mkdir(resources);
    await writeFile(path.join(source, "main.js"), "export const value = 1;");
    await createPackage(source, path.join(resources, "app.asar"));
    await auditReleaseContent(resources, environment);

    await writeFile(path.join(source, "main.js"), "blocked-example");
    await createPackage(source, path.join(resources, "app.asar"));
    await assert.rejects(auditReleaseContent(resources, environment), (error) => {
      assert.match(error.message, /Release content audit failed/);
      assert.doesNotMatch(error.message, /blocked-example|main.js/);
      return true;
    });

    await writeFile(path.join(source, "main.js"), "safe");
    await createPackage(source, path.join(resources, "app.asar"));
    await writeFile(path.join(resources, "extra.txt"), "blocked-example");
    await assert.rejects(auditReleaseContent(resources, environment), /Release content audit failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release audit fails closed for missing or malformed configuration", async () => {
  await assert.rejects(auditReleaseContent("unused", { SIGMA_STUDIO_REQUIRE_RELEASE_AUDIT: "true" }), /required/);
  for (const value of ["[]", "invalid", '["["]', '[null]']) {
    await assert.rejects(auditReleaseContent("unused", { ...environment, RELEASE_CONTENT_RULES: value }), /configuration is invalid/);
  }
});
