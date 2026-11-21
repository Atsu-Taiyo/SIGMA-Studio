// Measure allocated files once per inode; do not follow workspace symlinks.
// APFS clone extent sharing cannot be inferred from stat(2). These are file
// allocation counts, not a claim about physical bytes reclaimed by deletion.
import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";

const roots = process.argv.slice(2);
if (!roots.length) throw new Error("Pass node_modules directories (and optionally the shared store) to measure together");
const files = new Map();
let pathBytes = 0;
let paths = 0;
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const location = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) { walk(location); continue; }
    if (!entry.isFile()) continue;
    const stat = lstatSync(location);
    const key = `${stat.dev}:${stat.ino}`;
    pathBytes += stat.size;
    paths++;
    const file = files.get(key);
    if (file) file.paths++;
    else files.set(key, { bytes: stat.size, allocated: stat.blocks * 512, links: stat.nlink, paths: 1 });
  }
}
for (const root of roots) walk(root);
const sum = (filter, field) => [...files.values()].filter(filter).reduce((total, file) => total + file[field], 0);
console.log(JSON.stringify({
  roots, filePaths: paths, uniqueInodes: files.size, apparentPathBytes: pathBytes,
  inodeUniqueApparentBytes: sum(() => true, "bytes"),
  inodeUniqueAllocatedBytes: sum(() => true, "allocated"),
  // nlink > paths within the measured tree proves another hardlink exists
  // outside it. It does not prove which store/worktree owns that link.
  externallyLinkedAllocatedBytes: sum(file => file.links > file.paths, "allocated"),
  exclusiveInodeAllocatedBytes: sum(file => file.links === file.paths, "allocated"),
}, null, 2));
