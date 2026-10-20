import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { OUTPUT, inspectCandidate, validateReview } from "./core.mjs";

const marker = (topic) => `<!-- sigma-factory:${topic} -->`;
const runUrl = (context) => `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`;

function save(name, data, directory = OUTPUT) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, name), JSON.stringify(data, null, 2));
}

export async function prepareDaily({ github, context, core, directory = OUTPUT }) {
  const repo = context.repo;
  const { data: metadata } = await github.rest.repos.get(repo);
  const { data: base } = await github.rest.repos.getCommit({ ...repo, ref: metadata.default_branch });
  const pulls = await github.paginate(github.rest.pulls.list, { ...repo, state: "open", per_page: 100 });
  const { data: issues } = await github.rest.issues.listForRepo({ ...repo, state: "open", per_page: 30 });
  const { data: runs } = await github.rest.actions.listWorkflowRuns({ ...repo, workflow_id: "checks.yml", branch: metadata.default_branch, per_page: 10 });
  const missing = [];
  if (!process.env.HAS_OPENAI_KEY) missing.push("OPENAI_API_KEY");
  if (!process.env.HAS_FACTORY_TOKEN) missing.push("SIGMA_FACTORY_GITHUB_TOKEN");
  const snapshot = {
    base_sha: base.sha,
    default_branch: metadata.default_branch,
    readiness: { ready: missing.length === 0, missing },
    pulls: pulls.map((p) => ({ number: p.number, title: p.title, body: p.body?.slice(0, 8000), url: p.html_url, head: p.head.sha, branch: p.head.ref })),
    issues: issues.filter((i) => !i.pull_request).map((i) => ({ number: i.number, title: i.title, body: i.body?.slice(0, 8000), url: i.html_url })),
    checks: runs.workflow_runs.map((r) => ({ sha: r.head_sha, status: r.status, conclusion: r.conclusion, url: r.html_url })),
  };
  save("context.json", snapshot, directory);
  core.setOutput("base_sha", base.sha);
  core.setOutput("run_ai", "false");
  await core.summary.addHeading("Software Factory readiness").addRaw(
    missing.length ? `Missing configuration: ${missing.join(", ")}` : "AI and publishing credentials are configured."
  ).write();
  if (context.payload.inputs?.mode === "readiness") return;
  if (missing.length) throw new Error(`Configure GitHub Actions secrets: ${missing.join(", ")}`);
  core.setOutput("run_ai", "true");
}

export function candidateBody(candidate, review, url) {
  const r = candidate.result;
  return `${marker(r.topic)}\n${r.summary}\n\n## 根拠\n${r.evidence.map((v) => `- ${v}`).join("\n")}\n\n## 参考実装\n${r.sources.map((s) => `- [参照](${s.url}) — ${s.revision}: ${s.reason}`).join("\n")}\n\n## エージェントが報告した検証\n${r.tests.map((t) => `- ${t.command}: ${t.result}`).join("\n")}\n\n## 独立レビュー\n${review.summary}\n\n## 未確認・制約\n${r.limitations.map((v) => `- ${v}`).join("\n")}\n\n[Factory実行と成果物](${url})\n\nアプリの保存・再起動・Electron・PDF・共有動作の実証範囲は上記に記載し、PRのCI結果と合わせて確認します。`;
}

export async function publishDaily({ github, context, core, cwd = process.cwd() }) {
  const candidate = inspectCandidate(path.join(cwd, OUTPUT), cwd, true);
  const review = validateReview(JSON.parse(readFileSync(path.join(cwd, OUTPUT, "review.json"), "utf8")), candidate.digest);
  if (candidate.result.status === "noop" || review.verdict !== "approve") {
    core.notice("No approved improvement to publish.");
    return;
  }
  const repo = context.repo;
  const r = candidate.result;
  const { data: metadata } = await github.rest.repos.get(repo);
  if (candidate.context.default_branch !== metadata.default_branch) throw new Error("Candidate must target the default branch");
  const { data: base } = await github.rest.repos.getCommit({ ...repo, ref: metadata.default_branch });
  if (base.sha !== candidate.context.base_sha) throw new Error("main changed during the run; rerun against the latest main");
  const pulls = await github.paginate(github.rest.pulls.list, { ...repo, state: "open", per_page: 100 });
  const duplicate = pulls.find((p) => p.body?.includes(marker(r.topic)));
  if (duplicate) {
    core.notice(`An improvement PR already exists: ${duplicate.html_url}`);
    return;
  }
  const body = candidateBody(candidate, review, runUrl(context));
  if (body.length > 60000) throw new Error("Candidate report exceeds the GitHub publication limit");
  if (r.status === "proposal") {
    const issues = await github.paginate(github.rest.issues.listForRepo, { ...repo, state: "open", per_page: 100 });
    if (issues.some((i) => i.body?.includes(marker(r.topic)))) return;
    const { data: issue } = await github.rest.issues.create({ ...repo, title: `[Factory] ${r.title}`, body });
    core.notice(issue.html_url);
    return;
  }
  if (pulls.filter((p) => p.body?.includes("<!-- sigma-factory:")).length >= 2) {
    core.notice("Two Factory PRs are already open; finish their review before adding another.");
    return;
  }
  const branch = `codex/factory-${r.topic}-${candidate.digest.slice(0, 12)}`;
  const previous = await github.paginate(github.rest.pulls.list, { ...repo, head: `${repo.owner}:${branch}`, state: "all", per_page: 100 });
  if (previous.length) { core.notice(`Candidate was already submitted: ${previous[0].html_url}`); return; }
  const tree = [];
  for (const file of candidate.files) {
    const filename = path.join(cwd, file.path);
    let sha = null;
    try {
      const content = readFileSync(filename).toString("base64");
      ({ data: { sha } } = await github.rest.git.createBlob({ ...repo, content, encoding: "base64" }));
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    tree.push({ path: file.path, mode: "100644", type: "blob", sha });
  }
  const { data: nextTree } = await github.rest.git.createTree({ ...repo, base_tree: base.commit.tree.sha, tree });
  const { data: commit } = await github.rest.git.createCommit({ ...repo, message: r.title, tree: nextTree.sha, parents: [base.sha] });
  try { await github.rest.git.createRef({ ...repo, ref: `refs/heads/${branch}`, sha: commit.sha }); }
  catch (error) {
    if (error.status !== 422) throw error;
    const { data: ref } = await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` });
    const { data: existing } = await github.rest.git.getCommit({ ...repo, commit_sha: ref.object.sha });
    if (existing.tree.sha !== nextTree.sha || existing.parents[0]?.sha !== base.sha) throw new Error("Existing candidate branch differs; refusing to overwrite it");
  }
  const { data: pr } = await github.rest.pulls.create({ ...repo, base: candidate.context.default_branch, head: branch, title: r.title, body, draft: true });
  core.setOutput("pull_request", pr.number);
  core.notice(pr.html_url);
  await core.summary.addLink("Improvement Draft PR", pr.html_url).write();
}

export async function preparePrReview({ github, context, core, directory = OUTPUT }) {
  const repo = context.repo;
  core.setOutput("run_ai", "false");
  let number = Number(context.payload.inputs?.pull_request || 0);
  const run = context.payload.workflow_run;
  if (!number) {
    if (!run || run.event !== "pull_request" || run.conclusion === "cancelled") return;
    const { data: associated } = await github.rest.repos.listPullRequestsAssociatedWithCommit({ ...repo, commit_sha: run.head_sha });
    number = associated.find((p) => p.state === "open" && p.head.sha === run.head_sha)?.number;
  }
  if (!number || !Number.isSafeInteger(number)) return;
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: number });
  if (pr.state !== "open" || (run && run.head_sha !== pr.head.sha)) return;
  const trustedHead = pr.head.repo?.full_name === `${repo.owner}/${repo.repo}`;
  if (context.eventName !== "workflow_dispatch" && !trustedHead && !["OWNER", "MEMBER", "COLLABORATOR"].includes(pr.author_association)) {
    core.notice("External contributor PRs require a maintainer to dispatch the review workflow.");
    return;
  }
  const reviews = await github.paginate(github.rest.pulls.listReviews, { ...repo, pull_number: number, per_page: 100 });
  const tag = `<!-- sigma-factory-review:${pr.head.sha} -->`;
  if (reviews.some((r) => r.user?.login === "github-actions[bot]" && r.body?.includes(tag))) return;
  const { data: metadata } = await github.rest.repos.get(repo);
  if (pr.base.ref !== metadata.default_branch) return;
  const { data: base } = await github.rest.repos.getCommit({ ...repo, ref: metadata.default_branch });
  if (pr.base.sha !== base.sha) { core.notice("PR base changed during preparation; retry the review."); return; }
  const files = await github.paginate(github.rest.pulls.listFiles, { ...repo, pull_number: number, per_page: 100 });
  let remaining = 160000;
  const changes = files.slice(0, 100).map((f) => {
    const patch = (f.patch || "").slice(0, Math.min(remaining, 12000));
    remaining -= patch.length;
    return { path: f.filename, status: f.status, patch };
  });
  save("context.json", { number, head_sha: pr.head.sha, base_ref: pr.base.ref, base_sha: base.sha, title: pr.title, body: pr.body?.slice(0, 12000), ci: run?.conclusion || "manual", truncated: files.length > 100 || remaining === 0 || files.some((f) => !f.patch || f.patch.length > 12000), files: changes }, directory);
  if (!process.env.HAS_OPENAI_KEY) throw new Error("Configure GitHub Actions secret OPENAI_API_KEY");
  core.setOutput("base_sha", base.sha);
  core.setOutput("run_ai", "true");
}

export async function publishPrReview({ github, context, core, directory = OUTPUT }) {
  const input = JSON.parse(readFileSync(path.join(directory, "context.json"), "utf8"));
  const review = validateReview(JSON.parse(readFileSync(path.join(directory, "review.json"), "utf8")), input.head_sha);
  const repo = context.repo;
  const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: input.number });
  const { data: metadata } = await github.rest.repos.get(repo);
  if (pr.state !== "open" || pr.head.sha !== input.head_sha || input.base_ref !== metadata.default_branch
    || pr.base?.ref !== input.base_ref || pr.base?.sha !== input.base_sha) {
    core.notice("PR head or base changed; discard the stale review."); return;
  }
  const tag = `<!-- sigma-factory-review:${input.head_sha} -->`;
  const reviews = await github.paginate(github.rest.pulls.listReviews, { ...repo, pull_number: input.number, per_page: 100 });
  if (reviews.some((r) => r.user?.login === "github-actions[bot]" && r.body?.includes(tag))) return;
  const findings = review.findings.map((f) => `- ${f}`).join("\n");
  const body = `${tag}\n対象: ${input.head_sha}\n\n${review.summary}\n\n${findings}\n\n${input.truncated ? "差分の一部が省略されているため、全体確認済みとは扱いません。\n" : ""}[レビュー実行](${runUrl(context)})`;
  await github.rest.pulls.createReview({ ...repo, pull_number: input.number, commit_id: input.head_sha, event: "COMMENT", body });
}

export async function checkHealth({ github, context, core, now = Date.now() }) {
  const repo = context.repo;
  const { data: metadata } = await github.rest.repos.get(repo);
  const { data: runs } = await github.rest.actions.listWorkflowRuns({ ...repo, workflow_id: "software-factory.yml", branch: metadata.default_branch, status: "success", per_page: 20 });
  let last = null;
  for (const run of runs.workflow_runs) {
    const { data: jobs } = await github.rest.actions.listJobsForWorkflowRun({ ...repo, run_id: run.id, per_page: 100 });
    if (jobs.jobs.some((job) => job.name === "verify" && job.conclusion === "success")) { last = run; break; }
  }
  const healthy = last && now - Date.parse(last.updated_at) < 36 * 60 * 60 * 1000;
  const tag = "<!-- sigma-factory-health -->";
  const issues = await github.paginate(github.rest.issues.listForRepo, { ...repo, state: "open", per_page: 100 });
  const issue = issues.find((i) => i.user?.login === "github-actions[bot]" && i.body?.includes(tag));
  if (healthy) {
    if (issue) await github.rest.issues.update({ ...repo, issue_number: issue.number, state: "closed", state_reason: "completed" });
    core.notice("A verified AI run succeeded within 36 hours.");
    return;
  }
  const url = `https://github.com/${repo.owner}/${repo.repo}/actions/workflows/software-factory.yml`;
  const body = `${tag}\n36時間以内にAI候補を検証まで完了した日次実行を確認できません。readinessだけの成功は日次処理の成功に数えません。\n\n${last ? `前回成功: ${last.updated_at}\n${last.html_url}` : "成功したAI実行はまだありません。"}\n\n[日次workflow](${url})で認証・実行結果を確認し、必要ならmode=improveで再実行してください。`;
  if (!issue) await github.rest.issues.create({ ...repo, title: "[Factory] 日次処理の成功を確認できません", body });
  else if (issue.body !== body) await github.rest.issues.update({ ...repo, issue_number: issue.number, body });
}
