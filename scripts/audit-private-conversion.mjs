#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|json)$/i;
const BUILD_TEXT_EXTENSIONS = /\.(?:[cm]?js|map|html|css|json|txt)$/i;
const PRIVATE_FILE_EXTENSIONS = /\.(?:prt|sdw|cab|pdf|ttf|otf|woff2?)$/i;
const BUNDLED_PUBLIC_FONT = /^apps\/desktop\/(?:out|\.next)\/(?:_next\/)?static\/media\/(?:KaTeX_|m-plus-1p-|noto-(?:sans-symbols|serif-jp)-|stix-two-math-)[^/]+\.(?:ttf|otf|woff2?)$/i;
const PRIVATE_PATHS = [
  /^(?:tmp|outputs?|materials|corpus|research)\//i,
  /(?:^|\/)private(?:-conversion)?\//i,
];
// Dependency names only. Ordinary UI copy mentioning the supported file type remains
// public; no source-document fingerprints live here.
const PRIVATE_CONTENT = [
  /(?:^|[\s"'])fontkit(?:[\s"'/]|$)/im,
];
const MAX_TEXT_BYTES = 32 * 1024 * 1024;

// Product- and file-specific rules never live in this public file. A maintainer can
// supply them locally as JSON ({ "paths": [regex...], "content": [regex...] }) named by
// SIGMA_PRIVATE_AUDIT_RULES. A bad file throws, so the gate fails closed.
let externalRulesCache;
function externalRules() {
  const file = process.env.SIGMA_PRIVATE_AUDIT_RULES ?? "";
  if (externalRulesCache?.file === file) return externalRulesCache.rules;
  const compile = (list) => (Array.isArray(list) ? list : []).map((source) => new RegExp(source, "i"));
  const parsed = file ? JSON.parse(readFileSync(file, "utf8")) : {};
  const rules = { paths: compile(parsed.paths), content: compile(parsed.content) };
  externalRulesCache = { file, rules };
  return rules;
}

export function privatePathReason(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  if (PRIVATE_FILE_EXTENSIONS.test(normalized)) return "source material or font file";
  if ([...PRIVATE_PATHS, ...externalRules().paths].some((pattern) => pattern.test(normalized))) return "private converter path";
  return undefined;
}

export function privateContentReason(content) {
  const text = Buffer.isBuffer(content) ? content.toString("utf8") : content;
  if ([...PRIVATE_CONTENT, ...externalRules().content].some((pattern) => pattern.test(text))) return "private converter import or dependency";
  return undefined;
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
}

function stagedEntries(cwd) {
  return git(cwd, "ls-files", "--stage", "-z").toString("utf8").split("\0").filter(Boolean).map((line) => {
    const match = /^(\d{6}) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(line);
    if (!match) throw new Error("Could not read Git index entry");
    return { mode: match[1], oid: match[2], stage: Number(match[3]), name: match[4] };
  });
}

function trackedEntries(cwd) {
  try {
    return git(cwd, "ls-tree", "-r", "-z", "HEAD").toString("utf8").split("\0").filter(Boolean).map((line) => {
      const match = /^(\d{6}) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(line);
      if (!match) throw new Error("Could not read Git tree entry");
      return { mode: match[1], oid: match[2], stage: 0, name: match[3] };
    });
  } catch (error) {
    // A fresh repository has no HEAD; its index is still audited by --staged.
    if (error?.status === 128) return [];
    throw error;
  }
}

export function auditGitEntries(entries, readBlob) {
  const findings = [];
  for (const entry of entries) {
    const reason = privatePathReason(entry.name);
    if (reason) {
      findings.push(`${entry.name}: ${reason}`);
      continue;
    }
    if (entry.stage !== 0) {
      findings.push(`${entry.name}: unresolved index stage`);
      continue;
    }
    if (entry.mode !== "100644" && entry.mode !== "100755") continue;
    if (!SOURCE_EXTENSIONS.test(entry.name) || entry.name === "scripts/audit-private-conversion.mjs") continue;
    const blob = readBlob(entry.oid);
    if (blob.length > MAX_TEXT_BYTES) {
      findings.push(`${entry.name}: source file exceeds audit limit`);
      continue;
    }
    const contentReason = privateContentReason(blob);
    if (contentReason) findings.push(`${entry.name}: ${contentReason}`);
  }
  return findings;
}

function auditGit(cwd, mode) {
  const entries = mode === "staged" ? stagedEntries(cwd) : trackedEntries(cwd);
  return auditGitEntries(entries, (oid) => git(cwd, "cat-file", "blob", oid));
}

export function auditPushedRefs(cwd, input) {
  const findings = [];
  const checkedBlobs = new Set();
  for (const line of input.split("\n").filter(Boolean)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) throw new Error("Could not read pre-push refs");
    const [localRef, localOid, , remoteOid] = fields;
    if (/^0+$/.test(localOid)) continue; // Deleting a remote ref sends no new objects.
    // A new public branch can expose commits already known to a different,
    // private remote. Audit its entire reachable history in that case.
    const range = /^0+$/.test(remoteOid)
      ? [localOid]
      : [localOid, `^${remoteOid}`];
    const changedPaths = git(cwd, "log", "-m", "--format=", "--name-only", "-z", ...range)
      .toString("utf8").split("\0").map((name) => name.replace(/^\n+/, "")).filter(Boolean);
    for (const name of changedPaths) {
      const reason = privatePathReason(name);
      if (reason) findings.push(`${localRef}: ${name}: ${reason}`);
    }
    const objects = git(cwd, "rev-list", "--objects", ...range).toString("utf8").split("\n");
    for (const object of objects) {
      const separator = object.indexOf(" ");
      if (separator < 0) continue; // Commit objects have no path.
      const oid = object.slice(0, separator);
      const name = object.slice(separator + 1);
      if (!SOURCE_EXTENSIONS.test(name) || name === "scripts/audit-private-conversion.mjs" || checkedBlobs.has(oid)) continue;
      checkedBlobs.add(oid);
      if (git(cwd, "cat-file", "-t", oid).toString("utf8").trim() !== "blob") continue;
      const size = Number(git(cwd, "cat-file", "-s", oid).toString("utf8"));
      if (size > MAX_TEXT_BYTES) {
        findings.push(`${localRef}: ${name}: source file exceeds audit limit`);
        continue;
      }
      const reason = privateContentReason(git(cwd, "cat-file", "blob", oid));
      if (reason) findings.push(`${localRef}: ${name}: ${reason}`);
    }
  }
  return findings;
}

function visitBuildFiles(directory, visit) {
  if (!existsSync(directory)) return false;
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = path.join(directory, item.name);
    if (item.isDirectory()) visitBuildFiles(absolutePath, visit);
    else if (item.isFile()) visit(absolutePath, false);
    else if (item.isSymbolicLink()) visit(absolutePath, true);
  }
  return true;
}

export function auditPublicBuildArtifacts(root = REPOSITORY_ROOT) {
  const findings = [];
  const desktop = path.join(root, "apps/desktop");
  let foundOutput = false;
  // `.next/dev` and `.next/cache` are local development state, never packaged.
  for (const directory of ["dist-electron", "out", ".next/server", ".next/static", ".next/standalone"]) {
    foundOutput = visitBuildFiles(path.join(desktop, directory), (absolutePath, isSymlink) => {
      const relativePath = path.relative(root, absolutePath).replaceAll(path.sep, "/");
      if (isSymlink) {
        findings.push(`${relativePath}: uninspectable build symlink`);
        return;
      }
      const pathReason = BUNDLED_PUBLIC_FONT.test(relativePath) ? undefined : privatePathReason(relativePath);
      if (pathReason) {
        findings.push(`${relativePath}: ${pathReason}`);
        return;
      }
      // Generated maps and chunks may be large; reject uninspectable text rather
      // than silently accepting an output that this gate did not examine.
      if (!BUILD_TEXT_EXTENSIONS.test(relativePath)) return;
      const size = lstatSync(absolutePath).size;
      if (size > MAX_TEXT_BYTES) {
        findings.push(`${relativePath}: build text exceeds audit limit`);
        return;
      }
      const contentReason = privateContentReason(readFileSync(absolutePath));
      if (contentReason) findings.push(`${relativePath}: ${contentReason}`);
    }) || foundOutput;
  }
  if (!foundOutput) findings.push("No public build output found");
  return findings;
}

function main() {
  const modes = process.argv.slice(2);
  if (!modes.length || modes.some((mode) => !["--staged", "--tracked", "--build", "--pushed"].includes(mode))) {
    console.error("Usage: node scripts/audit-private-conversion.mjs [--staged] [--tracked] [--build] [--pushed]");
    process.exitCode = 2;
    return;
  }
  // npm workspace scripts run from apps/desktop. Audit the whole repository,
  // so build paths and private-path rules keep the same meaning at any depth.
  const cwd = git(process.cwd(), "rev-parse", "--show-toplevel").toString("utf8").trim();
  const findings = [...new Set(modes.flatMap((mode) => mode === "--build"
    ? auditPublicBuildArtifacts(cwd)
    : mode === "--pushed"
      ? auditPushedRefs(cwd, readFileSync(0, "utf8"))
      : auditGit(cwd, mode.slice(2))))];
  if (findings.length) {
    for (const finding of findings.slice(0, 20)) console.error(`Blocked: ${finding}`);
    if (findings.length > 20) console.error(`Blocked: ${findings.length - 20} additional finding(s)`);
    process.exitCode = 1;
  } else {
    console.log(`Private conversion audit passed (${modes.join(", ")}).`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
