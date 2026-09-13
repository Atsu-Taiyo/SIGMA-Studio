import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Reuse the tar reader already installed by the desktop packaging toolchain.
const require = createRequire(import.meta.url);
const tar = require("tar");
const repository = "git+https://github.com/Atsu-Taiyo/SIGMA-Studio.git";
const requiredFiles = ["package.json", "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "dist/index.js", "dist/index.d.ts", "dist/styles.css"];
const credentialPatterns = [
  /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]{64,}-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
];

function contentRules(environment) {
  try {
    const patterns = JSON.parse(environment.RELEASE_CONTENT_RULES);
    if (!Array.isArray(patterns) || !patterns.length || patterns.some((value) => typeof value !== "string" || !value)) throw new Error();
    return patterns.map((pattern) => new RegExp(pattern, "iu"));
  } catch {
    throw new Error("Package audit configuration is missing or invalid.");
  }
}

export async function auditNpmTarball(file, expected, environment = process.env) {
  const rules = contentRules(environment);
  const files = new Map();
  let failure;
  let totalBytes = 0;
  try {
    await tar.t({
      file,
      strict: true,
      onentry(entry) {
        const name = entry.path.replace(/^package\//u, "");
        const safePath = entry.path.startsWith("package/") && !name.includes("\\") && !name.split("/").some((part) => part === ".." || part === "." || part === "");
        const allowed = requiredFiles.includes(name) || (name.startsWith("dist/") && /\.(?:js|mjs|cjs|d\.ts|css|woff2?|ttf|eot|png|jpe?g|gif|svg)$/u.test(name));
        if (!safePath || !allowed || entry.type !== "File" || files.has(name)) failure = "Unexpected package entry.";
        if (files.size >= 10000 || entry.size > 64 * 1024 * 1024 || totalBytes + entry.size > 256 * 1024 * 1024) failure = "Package exceeds audit limits.";
        totalBytes += entry.size;
        const chunks = [];
        files.set(name, null);
        entry.on("data", (chunk) => { if (!failure) chunks.push(chunk); });
        entry.on("end", () => {
          if (failure) return;
          const content = Buffer.concat(chunks);
          const text = content.toString("utf8");
          if (rules.some((rule) => rule.test(name) || rule.test(text)) || credentialPatterns.some((rule) => rule.test(text))) {
            failure = "Package content policy failed.";
            return;
          }
          files.set(name, content);
        });
      },
    });
  } catch {
    throw new Error("Package archive could not be inspected.");
  }
  if (failure) throw new Error(failure);
  if (requiredFiles.some((name) => !files.get(name)?.length)) throw new Error("Required package files are missing or empty.");
  let manifest;
  try { manifest = JSON.parse(files.get("package.json").toString("utf8")); } catch { throw new Error("Invalid package manifest."); }
  if (manifest.name !== expected.name || manifest.version !== expected.version || manifest.repository?.url !== repository || manifest.license !== "MIT" || manifest.private === true) {
    throw new Error("Package identity does not match this release.");
  }
  if (manifest.name === "@sigma-studio/editor" && manifest.dependencies?.["@sigma-studio/viewer"] !== expected.version) {
    throw new Error("Editor must depend on the matching Viewer release.");
  }
  const license = files.get("LICENSE").toString("utf8");
  const notices = files.get("THIRD_PARTY_NOTICES.md").toString("utf8");
  if (!license.includes("Permission is hereby granted") || !["## katex", "## mathlive", "SIL OPEN FONT LICENSE"].every((text) => notices.includes(text))) {
    throw new Error("Required license notices are incomplete.");
  }
  return {
    name: manifest.name,
    version: manifest.version,
    files: files.size,
    integrity: `sha512-${createHash("sha512").update(await readFile(file)).digest("base64")}`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/audit-npm-tarballs.mjs <tarball-directory>");
    const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    for (const name of ["viewer", "editor"]) {
      const file = path.resolve(process.argv[2], `sigma-studio-${name}-${version}.tgz`);
      console.log(JSON.stringify(await auditNpmTarball(file, { name: `@sigma-studio/${name}`, version })));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
