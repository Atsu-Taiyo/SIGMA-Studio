import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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

test("the desktop runtime retains the compromised-certificate mitigation baseline", () => {
  // The 2026-10-24 npm audit did not report Electron's GHSA-jr5w-w6x2-84p9.
  // Packaging/lockfile consistency is checked separately by dependencies:check.
  const version = require("electron/package.json").version;
  assert.match(version, /^\d+\.\d+\.\d+$/, "Use an exact stable Electron runtime");
  const [major, minor, patch] = version.split(".").map(Number);
  assert.ok(major > 44 || (major === 44 && (minor > 9 || (minor === 9 && patch >= 1))),
    `Electron ${version} is below the desktop security baseline 44.9.1 (GHSA-jr5w-w6x2-84p9)`);
});

for (const runtime of ["shipped", "build"]) {
  test(`the ${runtime} runtime handles TLS hostname errors without the Undici process-crash assertion`, () => {
    // npm overrides do not change Node's embedded Undici (GHSA-qrxm-fqhp-jwvm).
    // Exercise the installed Electron's real handlers with an injected socket error;
    // this does not contact a server or perform TLS renegotiation.
    const result = spawnSync(runtime === "shipped" ? require("electron") : process.execPath, ["--input-type=commonjs", "-e", `
      const assert = require("node:assert/strict");
      const { runInNewContext } = require("node:vm");
      const ts = require(process.argv[1]);
      const source = process.binding("natives")["internal/deps/undici/undici"];
      assert.equal(typeof source, "string", "Review the embedded runtime before changing this check");
      const ast = ts.createSourceFile("undici.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const names = ["onHttpSocketError", "onHttp2SessionError", "onHttp2SocketError"];
      const handlers = new Map();
      function visit(node) {
        if (ts.isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) {
          assert.ok(!handlers.has(node.name.text), "Review duplicate runtime handlers");
          handlers.set(node.name.text, node.getText(ast));
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
      for (const name of names) {
        assert.ok(handlers.has(name), "Review missing embedded handler " + name);
        const calls = [];
        const receiver = { parser: {}, socket: {}, client: { onError: error => calls.push(error) } };
        const handler = runInNewContext("(" + handlers.get(name) + ")", {
          assert, kParser: "parser", kError: "error", kClient: "client", kOnError: "onError", kSocket: "socket",
        });
        const error = Object.assign(new Error("synthetic hostname mismatch"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
        assert.doesNotThrow(() => handler.call(receiver, error), name);
        assert.equal(calls.length, 1, name);
        assert.equal(calls[0], error, name);
        assert.equal(name === "onHttp2SessionError" ? receiver.socket.error : receiver.error, error, name);
      }
      console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, undici: process.versions.undici }));
    `, require.resolve("typescript-compiler-api")], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 15_000, killSignal: "SIGKILL", encoding: "utf8",
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });
}

test("the MCP rate-limit IPv6 parser bounds malformed zone identifiers and preserves valid addresses", () => {
  const sdkRequire = createRequire(require.resolve("@modelcontextprotocol/sdk/package.json"));
  const rateLimitRequire = createRequire(sdkRequire.resolve("express-rate-limit"));
  const addressModule = rateLimitRequire.resolve("ip-address");
  const result = spawnSync(process.execPath, ["--input-type=commonjs", "-e", `
    const assert = require("node:assert/strict");
    const { Address6 } = require(process.argv[1]);
    assert.equal(new Address6("2001:db8::1").correctForm(), "2001:db8::1");
    assert.equal(new Address6("fe80::1%eth0").zone, "%eth0");
    assert.equal(Address6.isValid("%".repeat(1024 * 1024) + "\\n!"), false);
  `, addressModule], { timeout: 5000, killSignal: "SIGKILL", encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

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
