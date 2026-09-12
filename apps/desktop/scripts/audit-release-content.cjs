/* eslint-disable @typescript-eslint/no-require-imports -- packaging hook runs in CommonJS. */
const fs = require("node:fs/promises");
const path = require("node:path");
const asar = require("@electron/asar");

async function auditReleaseContent(resources, environment = process.env) {
  const configured = environment.RELEASE_CONTENT_RULES;
  if (!configured) {
    if (environment.SIGMA_STUDIO_REQUIRE_RELEASE_AUDIT === "true") {
      throw new Error("Release content audit configuration is required.");
    }
    return;
  }
  let rules;
  try {
    const patterns = JSON.parse(configured);
    if (!Array.isArray(patterns) || !patterns.length || patterns.some((value) => typeof value !== "string" || !value)) {
      throw new Error();
    }
    rules = patterns.map((pattern) => new RegExp(pattern, "iu"));
  } catch {
    throw new Error("Release content audit configuration is invalid.");
  }
  let checked = 0;
  const inspect = (name, content) => {
    checked += 1;
    const text = content.toString("utf8");
    for (let index = 0; index < rules.length; index += 1) {
      if (rules[index].test(name) || rules[index].test(text)) {
        // Never put configured rules, source text, or matching names in public logs.
        throw new Error(`Release content audit failed (rule ${index + 1}, file ${checked}).`);
      }
    }
  };
  const visit = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(file);
      } else if (entry.isFile() && entry.name.endsWith(".asar")) {
        for (const archiveEntry of asar.listPackage(file)) {
          const name = archiveEntry.replace(/^[/\\]+/, "");
          const info = asar.statFile(file, name, false);
          if (info.files || info.link || info.unpacked) continue;
          inspect(name, asar.extractFile(file, name));
        }
      } else if (entry.isFile()) {
        inspect(path.relative(resources, file), await fs.readFile(file));
      }
    }
  };
  await visit(resources);
  if (!checked) throw new Error("Release content audit found no files.");
  console.log(`[release-audit] ${checked} packaged files passed`);
}

module.exports = { auditReleaseContent };
