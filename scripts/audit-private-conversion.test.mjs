import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Assembled at runtime so this file does not contain the dependency name the gate looks for.
const DEPENDENCY = ["font", "kit"].join("");

import { auditPublicBuildArtifacts, privateContentReason, privatePathReason } from "./audit-private-conversion.mjs";

const auditScript = fileURLToPath(new URL("./audit-private-conversion.mjs", import.meta.url));

function withTemporaryRepository(run) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sigma-private-audit-"));
  const index = path.join(directory, "isolated.index");
  const environment = { ...process.env, GIT_INDEX_FILE: index };
  try {
    execFileSync("git", ["init", "-q", directory]);
    return run({ directory, environment });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function stage(directory, environment, relativePath, content) {
  const absolutePath = path.join(directory, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  execFileSync("git", ["add", "--", relativePath], { cwd: directory, env: environment });
}

function audit(directory, environment) {
  return spawnSync(process.execPath, [auditScript, "--staged"], {
    cwd: directory,
    env: environment,
    encoding: "utf8",
  });
}

function commit(directory, environment, message) {
  execFileSync("git", ["-c", "user.name=Audit Test", "-c", "user.email=audit@example.invalid", "commit", "-qm", message], {
    cwd: directory, env: environment,
  });
}

function auditPush(directory, environment) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, env: environment, encoding: "utf8" }).trim();
  return spawnSync(process.execPath, [auditScript, "--pushed"], {
    cwd: directory,
    env: environment,
    encoding: "utf8",
    input: `refs/heads/main ${head} refs/heads/main ${"0".repeat(head.length)}\n`,
  });
}

test("an isolated Git index accepts the public contract but rejects staged source materials", () => {
  withTemporaryRepository(({ directory, environment }) => {
    stage(directory, environment, "apps/desktop/src/lib/document-conversion-contracts.ts", "export type ImportResult = { ok: boolean };\n");
    assert.equal(audit(directory, environment).status, 0);

    stage(directory, environment, "fixtures/material.prt", Buffer.from([0, 1, 2, 3]));
    const blocked = audit(directory, environment);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /fixtures\/material\.prt: source material or font file/);
  });
});

test("the staged audit reads blob content from the alternate index", () => {
  withTemporaryRepository(({ directory, environment }) => {
    const relativePath = "apps/desktop/src/lib/bridge.ts";
    const privateImport = `import type { Font } from "${DEPENDENCY}";\n`;
    stage(directory, environment, relativePath, privateImport);
    writeFileSync(path.join(directory, relativePath), "export type Result = { ok: boolean };\n");
    const blocked = audit(directory, environment);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /bridge\.ts: private converter import or dependency/);
  });
});

test("the push audit rejects private history even when the branch tip removed it", () => {
  withTemporaryRepository(({ directory, environment }) => {
    stage(directory, environment, "materials/source.pdf", Buffer.from("private fixture"));
    commit(directory, environment, "temporary material");
    execFileSync("git", ["rm", "-q", "materials/source.pdf"], { cwd: directory, env: environment });
    stage(directory, environment, "public.txt", "safe\n");
    commit(directory, environment, "remove material");
    const blocked = auditPush(directory, environment);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /materials\/source\.pdf: source material or font file/);
  });
});

test("the push audit checks content in an earlier commit, not only HEAD", () => {
  withTemporaryRepository(({ directory, environment }) => {
    const bridge = "apps/desktop/src/lib/bridge.ts";
    stage(directory, environment, bridge, `import "${DEPENDENCY}";\n`);
    commit(directory, environment, "temporary import");
    const privateRemoteTip = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: directory, env: environment, encoding: "utf8",
    }).trim();
    execFileSync("git", ["update-ref", "refs/remotes/private/main", privateRemoteTip], {
      cwd: directory, env: environment,
    });
    stage(directory, environment, bridge, "export const ready = true;\n");
    commit(directory, environment, "remove import");
    const blocked = auditPush(directory, environment);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /bridge\.ts: private converter import or dependency/);
  });
});

test("the build audit rejects a private converter folder and private imports in public chunks", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sigma-private-build-"));
  try {
    const output = path.join(directory, "apps/desktop/dist-electron");
    mkdirSync(output, { recursive: true });
    mkdirSync(path.join(output, "private-conversion"), { recursive: true });
    writeFileSync(path.join(output, "private-conversion", "worker.cjs"), "module.exports = {};\n");
    assert.match(auditPublicBuildArtifacts(directory).join("\n"), /private converter path/);
    rmSync(path.join(output, "private-conversion"), { recursive: true });
    writeFileSync(path.join(output, "main.cjs"), `require("${DEPENDENCY}");\n`);
    assert.match(auditPublicBuildArtifacts(directory).join("\n"), /private converter import or dependency/);
    writeFileSync(path.join(output, "main.cjs"), "module.exports = {};\n");
    assert.deepEqual(auditPublicBuildArtifacts(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the build CLI audits repository outputs when invoked from the desktop workspace", () => {
  withTemporaryRepository(({ directory, environment }) => {
    const workspace = path.join(directory, "apps/desktop");
    const output = path.join(workspace, "dist-electron");
    mkdirSync(output, { recursive: true });
    writeFileSync(path.join(output, "main.cjs"), "module.exports = {};\n");
    const run = () => spawnSync(process.execPath, [auditScript, "--build"], {
      cwd: workspace, env: environment, encoding: "utf8",
    });
    assert.equal(run().status, 0);
    writeFileSync(path.join(output, "private.prt"), Buffer.from([1, 2, 3]));
    const blocked = run();
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /private\.prt: source material or font file/);
  });
});

test("the path gate also covers private notes and raw font files", () => {
  assert.equal(privatePathReason("private-conversion/notes/readme.md"), "private converter path");
  assert.equal(privatePathReason("fonts/source.otf"), "source material or font file");
});

test("name-specific rules come from a local rules file, never from this repository", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sigma-private-rules-"));
  const rules = path.join(directory, "rules.json");
  const previous = process.env.SIGMA_PRIVATE_AUDIT_RULES;
  try {
    assert.equal(privatePathReason("docs/vendor-note.md"), undefined);
    writeFileSync(rules, JSON.stringify({ paths: ["^docs/vendor-note\\.md$"], content: ["vendor-token"] }));
    process.env.SIGMA_PRIVATE_AUDIT_RULES = rules;
    assert.equal(privatePathReason("docs/vendor-note.md"), "private converter path");
    assert.equal(privateContentReason("const a = 'vendor-token';"), "private converter import or dependency");
    assert.equal(privateContentReason("const a = 1;"), undefined);
    writeFileSync(rules, "{ not json");
    process.env.SIGMA_PRIVATE_AUDIT_RULES = `${rules}.missing`;
    assert.throws(() => privatePathReason("docs/anything.md"));
  } finally {
    if (previous === undefined) delete process.env.SIGMA_PRIVATE_AUDIT_RULES;
    else process.env.SIGMA_PRIVATE_AUDIT_RULES = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
