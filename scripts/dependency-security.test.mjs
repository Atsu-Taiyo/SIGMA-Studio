import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { patchSource } from "./patch-http-cache-semantics.mjs";

const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
// Resolve through the actual build-tool dependency chain, including nested installs.
const builderRequire = createRequire(require.resolve("app-builder-lib/package.json"));
const getRequire = createRequire(builderRequire.resolve("@electron/get/package.json"));
const gotRequire = createRequire(getRequire.resolve("got/package.json"));
const cacheRequire = createRequire(gotRequire.resolve("cacheable-request/package.json"));
const CachePolicy = cacheRequire("http-cache-semantics");
const pluginRequire = createRequire(require.resolve("@next/eslint-plugin-next/package.json"));
const { getRootDirs } = pluginRequire("./dist/utils/get-root-dirs.js");

const request = { url: "https://cache.example.invalid/account", headers: { host: "cache.example.invalid" } };
for (const [name, headers] of Object.entries({
  "shared Set-Cookie": { "set-cookie": "session=fixture; HttpOnly" },
  "proxy-revalidate": { "cache-control": "public, max-age=0, proxy-revalidate" },
  "no-cache": { "cache-control": "no-cache" },
  "private": { "cache-control": "private, max-age=3600" },
  "no-store": { "cache-control": "no-store" },
})) {
  for (const maxStale of ["max-stale", "max-stale=86400"]) {
    test(`build-tool cache refuses ${name} with ${maxStale}`, () => {
      const policy = new CachePolicy(request, { status: 200, headers }, { shared: true });
      assert.equal(policy.satisfiesWithoutRevalidation({
        ...request, headers: { ...request.headers, "cache-control": maxStale },
      }), false);
    });
  }
}

test("ordinary public cache entries remain reusable", () => {
  const policy = new CachePolicy(request, {
    status: 200, headers: { "cache-control": "public, max-age=3600" },
  }, { shared: true });
  assert.equal(policy.satisfiesWithoutRevalidation(request), true);
});

test("public opt-in and private-cache cookies keep their normal reuse behavior", () => {
  for (const shared of [true, false]) {
    const policy = new CachePolicy(request, {
      status: 200, headers: { "set-cookie": "session=fixture", "cache-control": "public, max-age=3600" },
    }, { shared });
    assert.equal(policy.satisfiesWithoutRevalidation(request), true);
  }
  const privatePolicy = new CachePolicy(request, {
    status: 200, headers: { "set-cookie": "session=fixture", "cache-control": "max-age=3600" },
  }, { shared: false });
  assert.equal(privatePolicy.satisfiesWithoutRevalidation(request), true);
});

test("max-stale still permits an ordinary expired public entry", () => {
  const now = Date.now();
  const policy = new CachePolicy(request, {
    status: 200, headers: { "cache-control": "public, max-age=1" },
  }, { shared: true });
  policy.now = () => now + 10_000;
  assert.equal(policy.satisfiesWithoutRevalidation(request), false);
  assert.equal(policy.satisfiesWithoutRevalidation({
    ...request, headers: { ...request.headers, "cache-control": "max-stale=60" },
  }), true);
});

test("cache patch is repeatable and refuses an unreviewed source change", () => {
  const installed = readFileSync(cacheRequire.resolve("http-cache-semantics"), "utf8");
  assert.equal(patchSource(installed), installed);
  assert.throws(() => patchSource(installed + "\n// unexpected change\n"), /Unexpected http-cache-semantics source/);
});

test("the builder downloader verifies bytes and reuses its artifact cache", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sigma download cache "));
  const payload = Buffer.from("Sigma dependency verification fixture\n");
  const checksum = createHash("sha256").update(payload).digest("hex");
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { "content-length": payload.length });
    response.end(payload);
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { downloadArtifact } = builderRequire("@electron/get");
    const options = {
      version: "9.9.9", artifactName: "fixture.bin", isGeneric: true,
      cacheRoot: path.join(root, "cache"), tempDirectory: root,
      checksums: { "fixture.bin": checksum },
      mirrorOptions: { resolveAssetURL: async () => `http://127.0.0.1:${server.address().port}/fixture.bin` },
    };
    const downloaded = await downloadArtifact(options);
    assert.deepEqual(readFileSync(downloaded), payload);
    assert.equal(requests, 1);
    assert.equal(await downloadArtifact(options), downloaded);
    assert.equal(requests, 1);
    await assert.rejects(downloadArtifact({
      ...options, force: true, checksums: { "fixture.bin": "0".repeat(64) },
    }), /checksum/i);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("Next lint root discovery supports directory, glob, brace and array settings", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sigma lint roots "));
  try {
    for (const directory of ["apps/desktop", "apps/web", "apps/.hidden", "packages/viewer"]) {
      mkdirSync(path.join(root, directory), { recursive: true });
    }
    writeFileSync(path.join(root, "apps/not-a-directory"), "fixture");
    // Next joins these entries with pages/src/pages/app; equivalent relative
    // paths and trailing directory separators are supported by that consumer.
    const resolve = rootDir => getRootDirs({ cwd: root, settings: { next: { rootDir } } })
      .map(directory => path.resolve(directory).replaceAll("\\", "/")).sort();
    const app = name => path.join(root, "apps", name).replaceAll("\\", "/");
    assert.deepEqual(resolve(undefined), [root.replaceAll("\\", "/")]);
    assert.deepEqual(resolve(app("desktop")), [app("desktop")]);
    assert.deepEqual(resolve(app("*")), [app("desktop"), app("web")]);
    assert.deepEqual(resolve(app("{desktop,web}")), [app("desktop"), app("web")]);
    assert.deepEqual(resolve([app("desktop"), app("web")]), [app("desktop"), app("web")]);
    assert.deepEqual(resolve(app("missing-*")), []);
    // The previous braces dependency overflows the stack on this nesting depth.
    assert.deepEqual(resolve(app("{".repeat(4000) + "a,b" + "}".repeat(4000))), []);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("Next lint still reports internal HTML links when rootDir is a glob", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sigma lint rule "));
  try {
    mkdirSync(path.join(root, "apps/web/pages"), { recursive: true });
    writeFileSync(path.join(root, "apps/web/pages/about.js"), "export default function Page() {}");
    const { Linter } = require("eslint");
    const messages = new Linter().verify('const link = <a href="/about/">About</a>;', {
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { next: require("@next/eslint-plugin-next") },
      settings: { next: { rootDir: path.join(root, "apps/*").replaceAll("\\", "/") } },
      rules: { "next/no-html-link-for-pages": "error" },
    });
    assert.deepEqual(messages.map(message => message.ruleId), ["next/no-html-link-for-pages"]);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
