import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const OUTPUT = ".factory-output";
const STATUSES = new Set(["change", "proposal", "noop"]);

function text(value, name, maximum = 12000) {
  if (typeof value !== "string" || value.length > maximum) throw new Error(`Invalid ${name}`);
  return value;
}

export function validateResult(result) {
  if (!result || !STATUSES.has(result.status)) throw new Error("Invalid candidate status");
  if (Buffer.byteLength(JSON.stringify(result)) > 48000) throw new Error("Candidate report is too large");
  if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(result.topic)) throw new Error("Invalid topic");
  if (!text(result.title, "title", 160).trim()) throw new Error("Missing title");
  text(result.summary, "summary");
  for (const field of ["evidence", "limitations"]) {
    if (!Array.isArray(result[field]) || result[field].length > 20) throw new Error(`Invalid ${field}`);
    result[field].forEach((value) => text(value, field, 2000));
  }
  if (!Array.isArray(result.sources) || result.sources.length > 10) throw new Error("Invalid sources");
  for (const source of result.sources) {
    const url = new URL(text(source.url, "source URL", 2000));
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid source URL");
    text(source.revision, "source revision", 200);
    text(source.reason, "source reason", 2000);
  }
  if (!Array.isArray(result.tests) || result.tests.length > 30) throw new Error("Invalid tests");
  result.tests.forEach((test) => {
    text(test.command, "test command", 1000);
    text(test.result, "test result", 2000);
  });
  if (result.status !== "noop" && (!result.evidence.length || !result.sources.length)) {
    throw new Error("Changes and proposals need evidence and external references");
  }
  return result;
}

export function git(args, cwd = process.cwd(), input) {
  const result = spawnSync("git", args, { cwd, input, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}

export function inspectPatch(patch, cwd = process.cwd()) {
  if (Buffer.byteLength(patch) > 512 * 1024) throw new Error("Patch exceeds 512 KiB");
  if (/^(?:old mode|new mode|rename from|rename to|copy from|copy to|GIT binary patch)\b/m.test(patch)
    || /^(?:new|deleted) file mode (?!100644$)/m.test(patch)) {
    throw new Error("Binary, rename, copy, executable and symlink changes need manual implementation");
  }
  const stats = git(["apply", "--numstat", "-z"], cwd, patch).split("\0").filter(Boolean);
  const files = stats.map((stat) => {
    const match = /^(\d+)\t(\d+)\t([^\0]+)$/.exec(stat);
    if (!match) throw new Error("Unsupported patch entry");
    const [, added, removed, filename] = match;
    if (filename.split("/").some((part) => !part || part === "." || part === "..") || filename.includes("\\") || /[\u0000-\u001f\u007f]/.test(filename)) {
      throw new Error("Unsafe patch path");
    }
    const allowed = /^(?:apps\/desktop\/(?:src|electron|mcp|tests)\/|packages\/(?:editor|viewer)\/src\/|docs\/)/.test(filename);
    const policy = /(?:^|\/)AGENTS\.md$/.test(filename)
      || /^(?:docs\/(?:software-factory|architecture|design-rules|sigma-doc-schema|pdf-parity-architecture)\.md)$/.test(filename);
    if (!allowed || policy) throw new Error(`Path needs manual implementation: ${filename}`);
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filename) && Number(added) === 0 && Number(removed) > 0) {
      throw new Error("Removing tests needs manual implementation");
    }
    return { path: filename, added: Number(added), removed: Number(removed) };
  });
  if (!files.length || files.length > 20 || files.reduce((n, f) => n + f.added + f.removed, 0) > 1000) {
    throw new Error("Candidate must contain 1–20 files and at most 1000 changed lines");
  }
  return files;
}

export function candidateDigest(result, patch) {
  return createHash("sha256").update(JSON.stringify(result)).update("\0").update(patch).digest("hex");
}

export function inspectCandidate(directory, cwd = process.cwd(), apply = false) {
  const result = validateResult(JSON.parse(readFileSync(path.join(directory, "result.json"), "utf8")));
  const patch = readFileSync(path.join(directory, "change.patch"), "utf8");
  const context = JSON.parse(readFileSync(path.join(directory, "context.json"), "utf8"));
  if (!/^[a-f0-9]{40}$/.test(context.base_sha) || git(["rev-parse", "HEAD"], cwd).trim() !== context.base_sha) {
    throw new Error("Candidate is not based on the checked-out trusted commit");
  }
  let files = [];
  if (result.status === "change") {
    files = inspectPatch(patch, cwd);
    git(["apply", "--check", "--index"], cwd, patch);
    if (apply) {
      git(["apply", "--index"], cwd, patch);
      for (const file of files) {
        const filename = path.join(cwd, file.path);
        if (existsSync(filename) && !lstatSync(filename).isFile()) throw new Error("Candidate contains a non-regular file");
      }
    }
  } else if (patch.trim()) throw new Error("Proposals and noops must not change files");
  return { result, patch, files, context, digest: candidateDigest(result, patch) };
}

export function validateReview(review, digest) {
  if (!review || review.candidate_digest !== digest || !["approve", "reject"].includes(review.verdict)) {
    throw new Error("Review does not match the candidate");
  }
  text(review.summary, "review summary");
  if (!Array.isArray(review.findings) || review.findings.length > 30) throw new Error("Invalid review findings");
  review.findings.forEach((finding) => text(finding, "review finding", 3000));
  if (review.verdict === "approve" && review.findings.length) throw new Error("Unresolved findings block publication");
  return review;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = path.resolve(OUTPUT);
  if (process.argv[2] === "collect") {
    const context = JSON.parse(readFileSync(path.join(directory, "context.json"), "utf8"));
    if (!/^[a-f0-9]{40}$/.test(context.base_sha)) throw new Error("Invalid base commit");
    git(["add", "--intent-to-add", "--all", "--", ".", `:(exclude)${OUTPUT}/**`]);
    const patch = git(["diff", "--no-ext-diff", "--no-textconv", "--binary", context.base_sha, "--", ".", `:(exclude)${OUTPUT}/**`]);
    writeFileSync(path.join(directory, "change.patch"), patch);
  } else if (process.argv[2] === "verify") {
    const candidate = inspectCandidate(directory, process.cwd(), true);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ digest: candidate.digest, status: candidate.result.status, files: candidate.files }, null, 2));
    if (process.env.GITHUB_OUTPUT) writeFileSync(process.env.GITHUB_OUTPUT, `status=${candidate.result.status}\n`, { flag: "a" });
    console.log(`Verified ${candidate.result.status}: ${candidate.files.length} changed files`);
  } else throw new Error("Use collect or verify");
}
