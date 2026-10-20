import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { candidateDigest, git, inspectCandidate, inspectPatch, validateResult, validateReview } from "../.github/software-factory/core.mjs";
import { checkHealth, prepareDaily, preparePrReview, publishDaily, publishPrReview } from "../.github/software-factory/github.mjs";

const source = "apps/desktop/src/example.ts";
const result = (status = "change") => ({
  status, topic: "editor-selection", title: "選択の更新を局所化する", summary: "同じ意味の更新をまとめる。",
  evidence: ["対象の更新条件を確認した"],
  sources: [{ url: "https://prosemirror.net/docs/guide/", revision: "2026-10-20", reason: "transactionの責務を比較。コードの転載なし。" }],
  tests: [{ command: "focused test", result: "未実行" }], limitations: ["実Electronは未確認"],
});

function fixture(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "sigma-factory-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(["init", "--initial-branch=main"], cwd);
  const write = (filename, content) => {
    mkdirSync(path.dirname(path.join(cwd, filename)), { recursive: true });
    writeFileSync(path.join(cwd, filename), content);
  };
  write(source, "export const value = 1;\n");
  write("apps/desktop/src/example.test.ts", "test('keeps content', () => expect(value).toBe(1));\n");
  git(["add", "."], cwd);
  git(["-c", "user.name=Factory Test", "-c", "user.email=factory@example.invalid", "commit", "-m", "fixture"], cwd);
  const base = git(["rev-parse", "HEAD"], cwd).trim();
  const patchFor = (filename, content) => {
    write(filename, content);
    git(["add", "--intent-to-add", "--all"], cwd);
    const patch = git(["diff", "--binary", "HEAD"], cwd);
    git(["reset", "--hard", "HEAD"], cwd); // This fixture is a disposable temporary repository.
    return patch;
  };
  const candidate = (r = result(), patch = patchFor(source, "export const value = 2;\n")) => {
    write(".factory-output/result.json", JSON.stringify(r));
    write(".factory-output/change.patch", patch);
    write(".factory-output/context.json", JSON.stringify({ base_sha: base, default_branch: "main" }));
    write(".factory-output/review.json", JSON.stringify({ candidate_digest: candidateDigest(r, patch), verdict: "approve", summary: "確認した範囲で指摘なし", findings: [] }));
    return { r, patch };
  };
  return { cwd, base, write, patchFor, candidate };
}

function api(base, options = {}) {
  const calls = [];
  const github = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
        getCommit: async () => ({ data: { sha: options.base || base, commit: { tree: { sha: "base-tree" } } } }),
      },
      pulls: {
        list: async () => ({ data: options.pulls || [] }),
        create: async (value) => { calls.push(["pr", value]); return { data: { number: 42, html_url: "https://github.com/example/repo/pull/42" } }; },
      },
      issues: {
        listForRepo: async () => ({ data: options.issues || [] }),
        create: async (value) => { calls.push(["issue", value]); return { data: { html_url: "https://github.com/example/repo/issues/43" } }; },
      },
      git: Object.fromEntries(["createBlob", "createTree", "createCommit", "createRef"].map((name) => [name, async (value) => {
        calls.push([name, value]); return { data: { sha: name } };
      }])),
    },
    paginate: async (fn, params) => (await fn(params)).data,
  };
  const core = { notice() {}, setOutput() {}, summary: { addLink() { return this; }, async write() {} } };
  const context = { repo: { owner: "example", repo: "repo" }, runId: 7 };
  return { github, core, context, calls };
}

test("accepts a source refactor and applies the exact candidate to a clean base", (t) => {
  const f = fixture(t); f.candidate();
  const inspected = inspectCandidate(path.join(f.cwd, ".factory-output"), f.cwd, true);
  assert.deepEqual(inspected.files.map((file) => file.path), [source]);
  assert.equal(readFileSync(path.join(f.cwd, source), "utf8"), "export const value = 2;\n");
});

test("actual collect and verify CLIs transfer a candidate without leaking output files into the patch", (t) => {
  const f = fixture(t); f.candidate(result("change"), "");
  f.write(source, "export const value = 3;\n");
  f.write("apps/desktop/src/new-regression.test.ts", "test('regression', () => expect(1).toBe(1));\n");
  const cli = fileURLToPath(new URL("../.github/software-factory/core.mjs", import.meta.url));
  const collect = spawnSync(process.execPath, [cli, "collect"], { cwd: f.cwd, encoding: "utf8" });
  assert.equal(collect.status, 0, collect.stderr);
  const patch = readFileSync(path.join(f.cwd, ".factory-output/change.patch"), "utf8");
  assert.doesNotMatch(patch, /\.factory-output/);
  const receiver = path.join(f.cwd, "receiver");
  git(["clone", f.cwd, receiver], f.cwd);
  mkdirSync(path.join(receiver, ".factory-output"));
  for (const filename of ["result.json", "change.patch", "context.json"]) {
    writeFileSync(path.join(receiver, ".factory-output", filename), readFileSync(path.join(f.cwd, ".factory-output", filename)));
  }
  const output = path.join(receiver, ".factory-output/job-output");
  const verify = spawnSync(process.execPath, [cli, "verify"], { cwd: receiver, env: { ...process.env, GITHUB_OUTPUT: output }, encoding: "utf8" });
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(readFileSync(path.join(receiver, source), "utf8"), "export const value = 3;\n");
  assert.equal(readFileSync(output, "utf8"), "status=change\n");
  const manifest = JSON.parse(readFileSync(path.join(receiver, ".factory-output/manifest.json"), "utf8"));
  assert.equal(manifest.digest, candidateDigest(result(), patch));
});

for (const filename of [".github/workflows/checks.yml", "scripts/check.mjs", "package.json", "docs/architecture.md", "apps/desktop/src/AGENTS.md"]) {
  test(`rejects generated changes to policy or infrastructure: ${filename}`, (t) => {
    const f = fixture(t);
    assert.throws(() => inspectPatch(f.patchFor(filename, "changed\n"), f.cwd), /manual implementation/);
  });
}

test("accepts a new regression test", (t) => {
  const f = fixture(t);
  const files = inspectPatch(f.patchFor("apps/desktop/src/regression.test.ts", "test('reproduces', () => expect(1).toBe(1));\n"), f.cwd);
  assert.equal(files.length, 1);
});

test("rejects removing assertions without adding a regression", (t) => {
  const f = fixture(t);
  assert.throws(() => inspectPatch(f.patchFor("apps/desktop/src/example.test.ts", ""), f.cwd), /Removing tests/);
});

test("rejects symlinks even under an allowed source path", (t) => {
  const f = fixture(t);
  symlinkSync("/etc/passwd", path.join(f.cwd, "apps/desktop/src/link.ts"));
  git(["add", "--intent-to-add", "--all"], f.cwd);
  assert.throws(() => inspectPatch(git(["diff", "--binary", "HEAD"], f.cwd), f.cwd), /symlink/);
});

test("rejects a patch outside the size budget", (t) => {
  const f = fixture(t);
  assert.throws(() => inspectPatch(f.patchFor(source, "added\n".repeat(1001)), f.cwd), /1000 changed lines/);
});

test("rejects a stale or altered base commit", (t) => {
  const f = fixture(t); f.candidate();
  f.write(".factory-output/context.json", JSON.stringify({ base_sha: "0".repeat(40), default_branch: "main" }));
  assert.throws(() => inspectCandidate(path.join(f.cwd, ".factory-output"), f.cwd), /trusted commit/);
});

test("proposals cannot carry an undisclosed patch", (t) => {
  const f = fixture(t); f.candidate(result("proposal"));
  assert.throws(() => inspectCandidate(path.join(f.cwd, ".factory-output"), f.cwd), /must not change/);
});

test("changes and proposals need external evidence", () => {
  assert.throws(() => validateResult({ ...result(), sources: [] }), /external references/);
  assert.throws(() => validateResult({ ...result("proposal"), evidence: [] }), /external references/);
  assert.doesNotThrow(() => validateResult({ ...result("noop"), evidence: [], sources: [] }));
});

test("rejects credentials in reference URLs and oversized reports", () => {
  assert.throws(() => validateResult({ ...result(), sources: [{ url: "https://user:secret@example.com/", revision: "v1", reason: "example" }] }), /source URL/);
  assert.throws(() => validateResult({ ...result(), summary: "x".repeat(50000) }), /too large/);
});

test("review must match the exact candidate and cannot approve unresolved findings", () => {
  assert.throws(() => validateReview({ candidate_digest: "old", verdict: "approve", summary: "ok", findings: [] }, "new"), /match/);
  assert.throws(() => validateReview({ candidate_digest: "new", verdict: "approve", summary: "ok", findings: ["broken"] }, "new"), /Unresolved/);
});

test("publication sends only allowed blobs to a Draft PR and never merges", async (t) => {
  const f = fixture(t); f.candidate(); const a = api(f.base);
  await publishDaily({ ...a, cwd: f.cwd });
  assert.deepEqual(a.calls.map(([name]) => name), ["createBlob", "createTree", "createCommit", "createRef", "pr"]);
  const pr = a.calls.at(-1)[1];
  assert.equal(pr.draft, true); assert.equal(pr.base, "main");
  assert.match(pr.head, /^codex\/factory-editor-selection-/);
  assert.match(pr.body, /未実行/); assert.match(pr.body, /実Electronは未確認/);
});

test("a rejected review makes no GitHub writes", async (t) => {
  const f = fixture(t); const { r, patch } = f.candidate(); const a = api(f.base);
  f.write(".factory-output/review.json", JSON.stringify({ candidate_digest: candidateDigest(r, patch), verdict: "reject", summary: "regression", findings: ["saved content changes"] }));
  await publishDaily({ ...a, cwd: f.cwd }); assert.equal(a.calls.length, 0);
});

test("main advancing before publication makes no GitHub writes", async (t) => {
  const f = fixture(t); f.candidate(); const a = api(f.base, { base: "f".repeat(40) });
  await assert.rejects(publishDaily({ ...a, cwd: f.cwd }), /main changed/);
  assert.equal(a.calls.length, 0);
});

test("an altered target branch is rejected", async (t) => {
  const f = fixture(t); f.candidate(); const a = api(f.base);
  f.write(".factory-output/context.json", JSON.stringify({ base_sha: f.base, default_branch: "unprotected" }));
  await assert.rejects(publishDaily({ ...a, cwd: f.cwd }), /default branch/); assert.equal(a.calls.length, 0);
});

test("an existing topic or full queue prevents duplicate PRs", async (t) => {
  for (const pulls of [
    [{ body: "<!-- sigma-factory:editor-selection -->", html_url: "existing" }],
    [{ body: "<!-- sigma-factory:other-one -->" }, { body: "<!-- sigma-factory:other-two -->" }],
  ]) {
    const f = fixture(t); f.candidate(); const a = api(f.base, { pulls });
    await publishDaily({ ...a, cwd: f.cwd }); assert.equal(a.calls.length, 0);
  }
});

test("a reviewed proposal creates an Issue without writing a commit", async (t) => {
  const f = fixture(t); f.candidate(result("proposal"), ""); const a = api(f.base);
  await publishDaily({ ...a, cwd: f.cwd }); assert.deepEqual(a.calls.map(([name]) => name), ["issue"]);
});

test("an updated PR discards the stale AI review", async (t) => {
  const f = fixture(t);
  f.write(".factory-output/context.json", JSON.stringify({ number: 42, head_sha: "a".repeat(40) }));
  f.write(".factory-output/review.json", JSON.stringify({ candidate_digest: "a".repeat(40), verdict: "approve", summary: "ok", findings: [] }));
  const a = api(f.base);
  a.github.rest.pulls.get = async () => ({ data: { state: "open", head: { sha: "b".repeat(40) } } });
  await publishPrReview({ ...a, directory: path.join(f.cwd, ".factory-output") }); assert.equal(a.calls.length, 0);
});

function prepareApi(base) {
  const a = api(base);
  a.outputs = {};
  a.core.setOutput = (name, value) => { a.outputs[name] = value; };
  a.core.summary.addHeading = function () { return this; };
  a.core.summary.addRaw = function () { return this; };
  a.github.rest.actions = { listWorkflowRuns: async () => ({ data: { workflow_runs: [] } }) };
  a.context.payload = {};
  return a;
}

test("readiness reports missing configuration without claiming an AI run succeeded", async (t) => {
  const f = fixture(t); const a = prepareApi(f.base);
  const original = [process.env.HAS_OPENAI_KEY, process.env.HAS_FACTORY_TOKEN];
  delete process.env.HAS_OPENAI_KEY; delete process.env.HAS_FACTORY_TOKEN;
  t.after(() => original.forEach((value, i) => {
    const key = ["HAS_OPENAI_KEY", "HAS_FACTORY_TOKEN"][i];
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }));
  a.context.payload.inputs = { mode: "readiness" };
  const directory = path.join(f.cwd, ".factory-output");
  await prepareDaily({ ...a, directory });
  assert.equal(a.outputs.run_ai, "false");
  const snapshot = JSON.parse(readFileSync(path.join(directory, "context.json"), "utf8"));
  assert.equal(snapshot.readiness.ready, false);
  assert.deepEqual(snapshot.readiness.missing, ["OPENAI_API_KEY", "SIGMA_FACTORY_GITHUB_TOKEN"]);
  a.context.payload.inputs.mode = "improve";
  await assert.rejects(prepareDaily({ ...a, directory }), /Configure GitHub Actions secrets/);
});

test("a push workflow never becomes a PR review", async (t) => {
  const f = fixture(t); const a = prepareApi(f.base);
  a.context.payload.workflow_run = { event: "push", head_sha: f.base };
  await preparePrReview({ ...a, directory: path.join(f.cwd, ".factory-output") });
  assert.equal(a.outputs.run_ai, "false");
});

test("external contributor data cannot trigger paid automatic review", async (t) => {
  const f = fixture(t); const a = prepareApi(f.base);
  a.context.eventName = "workflow_run";
  a.context.payload.workflow_run = { event: "pull_request", head_sha: f.base, conclusion: "success" };
  a.github.rest.repos.listPullRequestsAssociatedWithCommit = async () => ({ data: [{ number: 42, state: "open", head: { sha: f.base } }] });
  a.github.rest.pulls.get = async () => ({ data: { state: "open", head: { sha: f.base }, author_association: "NONE" } });
  await preparePrReview({ ...a, directory: path.join(f.cwd, ".factory-output") });
  assert.equal(a.outputs.run_ai, "false");
});

test("a current PR review is posted as a comment, never as an approval", async (t) => {
  const f = fixture(t); const a = api(f.base);
  f.write(".factory-output/context.json", JSON.stringify({ number: 42, head_sha: f.base, truncated: true }));
  f.write(".factory-output/review.json", JSON.stringify({ candidate_digest: f.base, verdict: "reject", summary: "保存の回帰", findings: ["P1 src/example.ts:1 保存で内容が失われる"] }));
  a.github.rest.pulls.get = async () => ({ data: { state: "open", head: { sha: f.base } } });
  a.github.rest.pulls.listReviews = async () => ({ data: [] });
  a.github.rest.pulls.createReview = async (value) => { a.calls.push(["review", value]); };
  await publishPrReview({ ...a, directory: path.join(f.cwd, ".factory-output") });
  assert.equal(a.calls.length, 1); assert.equal(a.calls[0][1].event, "COMMENT");
  assert.match(a.calls[0][1].body, /全体確認済みとは扱いません/);
});

test("health ignores successful readiness-only runs and does not repeat the same alert", async (t) => {
  const f = fixture(t); const a = prepareApi(f.base);
  a.github.rest.actions.listWorkflowRuns = async () => ({ data: { workflow_runs: [{ id: 7, updated_at: new Date().toISOString() }] } });
  a.github.rest.actions.listJobsForWorkflowRun = async () => ({ data: { jobs: [{ name: "prepare", conclusion: "success" }, { name: "verify", conclusion: "skipped" }] } });
  await checkHealth(a); assert.equal(a.calls.length, 1); assert.equal(a.calls[0][0], "issue");
  const body = a.calls[0][1].body;
  a.github.rest.issues.listForRepo = async () => ({ data: [{ number: 9, user: { login: "github-actions[bot]" }, body }] });
  await checkHealth(a); assert.equal(a.calls.length, 1);
});

test("health closes only its own alert after a verified AI run", async (t) => {
  const f = fixture(t); const a = prepareApi(f.base);
  const now = Date.now();
  a.github.rest.actions.listWorkflowRuns = async () => ({ data: { workflow_runs: [{ id: 7, updated_at: new Date(now - 1000).toISOString() }] } });
  a.github.rest.actions.listJobsForWorkflowRun = async () => ({ data: { jobs: [{ name: "verify", conclusion: "success" }] } });
  a.github.rest.issues.listForRepo = async () => ({ data: [{ number: 9, user: { login: "github-actions[bot]" }, body: "<!-- sigma-factory-health -->" }] });
  a.github.rest.issues.update = async (value) => { a.calls.push(["update", value]); };
  await checkHealth({ ...a, now }); assert.equal(a.calls[0][1].state, "closed");
});
