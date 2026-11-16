// GHSA-ch52-4w7c-c8xp still reproduces in 4.3.0. Keep the regression tests
// passing before removing this patch, even if npm audit reports no advisory.
import { createHash } from "node:crypto";
import { globSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const originalHash = "ede1cc404a492fa348eb9d97a3007a0d72aa717bd22cd86a56bd0824c19729ca";
const anchor = "        // In all circumstances, a cache MUST NOT ignore the must-revalidate directive";
const guard = `        // SIGMA: max-stale must not bypass security-related reuse prohibitions.
        if (
            !this.storable() || this._rescc['no-cache'] ||
            (this._isShared && (
                this._rescc['proxy-revalidate'] ||
                (this._resHeaders['set-cookie'] && !this._rescc.public && !this._rescc.immutable)
            ))
        ) {
            return this._evaluateRequestMissResult(req);
        }

`;
const hash = source => createHash("sha256").update(source).digest("hex");

export function patchSource(source) {
  // Accept only the reviewed tarball or its exact, already-patched contents.
  const original = source.includes(guard) ? source.replace(guard, "") : source;
  if (hash(original) !== originalHash || original.split(anchor).length !== 2) {
    throw new Error("Unexpected http-cache-semantics source; review the security patch before updating");
  }
  return original.replace(anchor, guard + anchor);
}

export function patchInstalledPackages(root) {
  const locations = globSync([
    "node_modules/http-cache-semantics/package.json",
    "node_modules/.pnpm/*/node_modules/http-cache-semantics/package.json",
  ], { cwd: root });
  for (const location of locations) {
    const packagePath = path.join(root, location);
    const installed = JSON.parse(readFileSync(packagePath, "utf8"));
    if (installed.version !== "4.3.0") {
      throw new Error("Review the http-cache-semantics security patch before changing its version");
    }
    const sourcePath = path.join(path.dirname(packagePath), "index.js");
    const source = readFileSync(sourcePath, "utf8");
    const patched = patchSource(source);
    if (source !== patched) {
      // Replace the inode instead of modifying the shared pnpm store hardlink.
      const temporary = `${sourcePath}.sigma-patch-${process.pid}`;
      writeFileSync(temporary, patched);
      renameSync(temporary, sourcePath);
    }
    console.log(`Verified cache reuse security patch: ${location}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  patchInstalledPackages(fileURLToPath(new URL("../", import.meta.url)));
}
