import { constants } from "node:fs";
import fs from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";
import type { FolderImportEntry, FolderImportProgress, FolderImportReason, FolderImportResult, ExtensionRunResult } from "@/lib/extension-contracts";

/** Host limits are independent of a converter's implementation. Overrides may only lower them. */
export const FOLDER_IMPORT_LIMITS = {
  entries: 10_000, files: 500, inputBytes: 64 * 1024 * 1024, totalInputBytes: 512 * 1024 * 1024,
  outputBytes: 128 * 1024 * 1024, totalOutputBytes: 1024 * 1024 * 1024, depth: 32,
} as const;
type Limits = { -readonly [K in keyof typeof FOLDER_IMPORT_LIMITS]: number };
interface Candidate { relativePath: string; stat: Stats }
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const unchanged = (a: Stats, b: Stats) => same(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const inside = (root: string, target: string) => { const rel = path.relative(root, target); return !rel || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel)); };

function nameReason(name: string, directory: boolean): FolderImportReason | null {
  if (name.startsWith(".")) return "hidden";
  if (name.startsWith("~") || name.endsWith("~") || /\.(tmp|temp|bak|swp|swo)(\.|$)/i.test(name)) return "temporary";
  if (/[\u0000-\u001f\u007f\\/:*?"<>|]/u.test(name) || /[. ]$/.test(name)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)
    || Buffer.byteLength(name + (directory ? "" : ".sigma"), "utf8") > 255) return "unsafe-name";
  return null;
}

/** Check every descendant component, including the root's identity, before I/O. */
export async function checkFolderPath(root: string, identity: Stats, target: string): Promise<void> {
  if (!inside(root, target) || !same(identity, await fs.lstat(root))) throw new Error("changed");
  let current = root;
  for (const component of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("changed");
  }
  if (await fs.realpath(target) !== target) throw new Error("changed");
}

async function directoryRoot(selected: string): Promise<{ root: string; identity: Stats }> {
  if (!path.isAbsolute(selected)) throw new Error("invalid-input");
  const selectedStat = await fs.lstat(selected);
  if (!selectedStat.isDirectory() || selectedStat.isSymbolicLink()) throw new Error("invalid-input");
  const root = await fs.realpath(selected);
  const identity = await fs.lstat(root);
  if (!same(selectedStat, identity)) throw new Error("invalid-input");
  return { root, identity };
}

export interface ConvertFolderOptions {
  inputDirectory: string;
  outputParent: string;
  jobId: string;
  extensions: string[];
  convertFile(bytes: Uint8Array, filename: string): Promise<ExtensionRunResult>;
  serialize(document: unknown): string;
  onProgress?(progress: FolderImportProgress): void;
  limits?: Partial<Limits>;
}

/** Stream directory entries, retain only bounded metadata, convert/save one document at a time. */
export async function convertFolder(options: ConvertFolderOptions): Promise<FolderImportResult> {
  const limits = { ...FOLDER_IMPORT_LIMITS } as Limits;
  for (const key of Object.keys(options.limits ?? {}) as Array<keyof Limits>) {
    const value = options.limits![key]!;
    if (!Number.isSafeInteger(value) || value < 1 || value > limits[key]) throw new Error("invalid-input");
    limits[key] = value;
  }
  const input = await directoryRoot(options.inputDirectory);
  const parent = await directoryRoot(options.outputParent);
  if (inside(input.root, parent.root)) throw new Error("invalid-input");
  const result: FolderImportResult = {
    ok: true, kind: "folder", jobId: options.jobId, outputDirectory: "",
    counts: { success: 0, skipped: 0, failed: 0 }, entries: [], truncated: false,
  };
  const candidates: Candidate[] = [];
  const directories = new Map<string, Stats>([[input.root, input.identity]]);
  let seen = 0;
  let inputBytes = 0;
  let completed = 0;
  const progress = (phase: FolderImportProgress["phase"], currentPath?: string) => {
    try { options.onProgress?.({ phase, counts: { ...result.counts }, completed, total: candidates.length, ...(currentPath ? { currentPath } : {}) }); } catch { /* Notifications do not own the job. */ }
  };
  const row = (relativePath: string, status: FolderImportEntry["status"], reason: FolderImportReason, scope: FolderImportEntry["scope"], extra: Partial<FolderImportEntry> = {}) => {
    result.entries.push({ relativePath, status, reason, scope, ...extra });
    result.counts[status] += 1;
  };
  async function checkInput(target: string) {
    await checkFolderPath(input.root, input.identity, target);
    let current = path.dirname(target);
    while (inside(input.root, current)) {
      const identity = directories.get(current);
      if (!identity || !same(identity, await fs.lstat(current))) throw new Error("changed");
      if (current === input.root) break;
      current = path.dirname(current);
    }
  }
  async function scan(directory: string, depth: number): Promise<void> {
    try {
      await checkFolderPath(input.root, input.identity, directory);
      if (!same(directories.get(directory)!, await fs.lstat(directory))) throw new Error("changed");
      const handle = await fs.opendir(directory);
      for await (const entry of handle) {
        if (seen >= limits.entries) { result.truncated = true; break; }
        seen += 1;
        const target = path.join(directory, entry.name);
        const relativePath = path.relative(input.root, target).split(path.sep).join("/");
        let stat: Stats;
        try { await checkInput(target); stat = await fs.lstat(target); }
        catch { row(relativePath, entry.isSymbolicLink() ? "skipped" : "failed", entry.isSymbolicLink() ? "link" : "read-failed", entry.isDirectory() ? "subtree" : "file"); continue; }
        const scope = stat.isDirectory() ? "subtree" : "file";
        const ignored = nameReason(entry.name, stat.isDirectory());
        if (stat.isSymbolicLink() || ignored) { row(relativePath, "skipped", stat.isSymbolicLink() ? "link" : ignored!, scope); continue; }
        if (stat.isDirectory()) {
          if (depth >= limits.depth) row(relativePath, "skipped", "depth-limit", "subtree");
          else { directories.set(target, stat); await scan(target, depth + 1); }
        } else if (!stat.isFile() || !options.extensions.some(ext => ext.toLowerCase() === path.extname(entry.name).toLowerCase())) row(relativePath, "skipped", "unsupported", "file");
        else if (!stat.size) row(relativePath, "skipped", "empty", "file");
        else if (stat.size > limits.inputBytes) row(relativePath, "skipped", "input-size", "file");
        else if (candidates.length >= limits.files) row(relativePath, "skipped", "file-limit", "file");
        else if (inputBytes + stat.size > limits.totalInputBytes) row(relativePath, "skipped", "input-total", "file");
        else { candidates.push({ relativePath, stat }); inputBytes += stat.size; }
        if (result.truncated) break;
      }
    } catch { row(path.relative(input.root, directory).split(path.sep).join("/") || ".", "failed", "read-failed", "subtree"); }
  }
  progress("scanning");
  await scan(input.root, 0);
  await checkFolderPath(parent.root, parent.identity, parent.root);
  result.outputDirectory = await fs.mkdtemp(path.join(parent.root, "SIGMA-import-"));
  // mkdtemp uses 0700; explicitly keep that contract on every platform supporting modes.
  await fs.chmod(result.outputDirectory, 0o700);
  const output = { root: result.outputDirectory, identity: await fs.lstat(result.outputDirectory) };
  const outputDirectories = new Map<string, Stats>([[output.root, output.identity]]);
  async function prepareOutput(relativePath: string): Promise<string> {
    let current = output.root;
    await checkFolderPath(parent.root, parent.identity, output.root);
    await checkFolderPath(output.root, output.identity, output.root);
    for (const component of path.dirname(relativePath).split("/").filter(part => part !== ".")) {
      current = path.join(current, component);
      if (!outputDirectories.has(current)) {
        await fs.mkdir(current, { mode: 0o700 });
        outputDirectories.set(current, await fs.lstat(current));
      }
      await checkFolderPath(output.root, output.identity, current);
      if (!same(outputDirectories.get(current)!, await fs.lstat(current))) throw new Error("changed");
    }
    return path.join(output.root, `${relativePath}.sigma`);
  }
  let outputBytes = 0;
  for (const candidate of candidates) {
    progress("converting", candidate.relativePath);
    let reason: FolderImportReason = "changed";
    try {
      const target = path.join(input.root, candidate.relativePath);
      await checkInput(target);
      const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let bytes: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || !unchanged(candidate.stat, stat)) throw new Error("changed");
        bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead) throw new Error("changed");
          offset += read.bytesRead;
        }
        await checkInput(target);
        if (!unchanged(candidate.stat, await handle.stat()) || !unchanged(candidate.stat, await fs.lstat(target))) throw new Error("changed");
      } finally { await handle.close(); }
      reason = "import-failed";
      const converted = await options.convertFile(bytes, path.basename(target));
      if (!converted.ok) { row(candidate.relativePath, "failed", converted.error, "file"); continue; }
      reason = "output-size";
      const text = options.serialize(converted.document);
      const size = Buffer.byteLength(text, "utf8");
      if (size > limits.outputBytes) throw new Error("output-size");
      reason = "output-total";
      if (outputBytes + size > limits.totalOutputBytes) throw new Error("output-total");
      reason = "write-failed";
      const filename = await prepareOutput(candidate.relativePath);
      const destination = await fs.open(filename, "wx", 0o600);
      try { await destination.writeFile(text); }
      catch (error) { await fs.unlink(filename).catch(() => {}); throw error; }
      finally { await destination.close(); }
      outputBytes += size;
      row(candidate.relativePath, "success", "converted", "file", { outputPath: `${candidate.relativePath}.sigma`, issueCount: converted.issues.length });
    } catch { row(candidate.relativePath, "failed", reason, "file"); }
    finally { completed += 1; progress("converting"); }
  }
  try {
    await checkFolderPath(parent.root, parent.identity, output.root);
    await checkFolderPath(output.root, output.identity, output.root);
    await fs.writeFile(path.join(output.root, "conversion-report.json"), JSON.stringify({
      counts: result.counts, entries: result.entries, truncated: result.truncated,
    }, null, 2), { flag: "wx", mode: 0o600 });
  } catch { result.reportError = "write-failed"; }
  return result;
}
