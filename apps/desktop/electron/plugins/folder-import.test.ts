import { renameSync, symlinkSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { sampleDocument } from "@/lib/sample-document";
import { SigmaDocumentSchema } from "@/lib/sigma-doc-schema";
import { serializeDocumentText } from "@/lib/document-text-transfer";
import { convertFolder, FOLDER_IMPORT_LIMITS, type ConvertFolderOptions } from "./folder-import";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function setup(files: Record<string, string> = { "a.smp": "input" }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-folder-")); roots.push(root);
  const inputDirectory = path.join(root, "in"); const outputParent = path.join(root, "out");
  await fs.mkdir(inputDirectory); await fs.mkdir(outputParent);
  for (const [name, value] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(inputDirectory, name)), { recursive: true });
    await fs.writeFile(path.join(inputDirectory, name), value);
  }
  const convertFile = vi.fn(async () => ({ ok: true as const, document: sampleDocument, issues: [{ code: "notice", detail: "test" }], sourceName: "sample.smp" }));
  const options: ConvertFolderOptions = { inputDirectory, outputParent, extensions: [".smp"], jobId: "job", convertFile, serialize: document => serializeDocumentText(document as typeof sampleDocument) };
  return { root, options, convertFile };
}

it("saves canonical JSON with hierarchy and original extension, reloads it, and reports bounded metadata", async () => {
  const { options, convertFile } = await setup({ "math/a.smp": "one", "other/a.SMP": "two", "a.smp": "three" });
  const progress = vi.fn();
  const result = await convertFolder({ ...options, onProgress: progress });
  expect(result.counts).toEqual({ success: 3, skipped: 0, failed: 0 });
  expect(convertFile).toHaveBeenCalledTimes(3);
  for (const name of ["math/a.smp", "other/a.SMP", "a.smp"]) {
    const file = path.join(result.outputDirectory, `${name}.sigma`);
    expect(SigmaDocumentSchema.parse(JSON.parse(await fs.readFile(file, "utf8")))).toEqual(SigmaDocumentSchema.parse(sampleDocument));
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  }
  const report = JSON.parse(await fs.readFile(path.join(result.outputDirectory, "conversion-report.json"), "utf8"));
  expect(report.entries).toEqual(result.entries);
  expect(JSON.stringify(report)).not.toContain(options.inputDirectory);
  expect(result.entries.every(entry => entry.issueCount === 1 && !("document" in entry))).toBe(true);
  expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({ completed: 3, total: 3 });
});

it("skips unsupported, hidden, temporary, unsafe and empty entries and never follows links", async () => {
  const { options, convertFile, root } = await setup({ "ok.smp": "yes", "image.png": "x", ".hidden/a.smp": "x", "~a.smp": "x", "a.tmp.smp": "x", "CON.smp": "x", "a:smp.smp": "x", "empty.smp": "" });
  await fs.symlink(options.inputDirectory, path.join(options.inputDirectory, "loop"));
  await fs.symlink(path.join(root, "out"), path.join(options.inputDirectory, "outside"));
  await fs.symlink(path.join(options.inputDirectory, "ok.smp"), path.join(options.inputDirectory, "linked.smp"));
  const result = await convertFolder(options);
  expect(result.counts).toEqual({ success: 1, skipped: 10, failed: 0 });
  expect(convertFile).toHaveBeenCalledTimes(1);
  expect(result.entries.find(entry => entry.relativePath === ".hidden")).toMatchObject({ reason: "hidden", scope: "subtree" });
  expect(result.entries.filter(entry => entry.reason === "link")).toHaveLength(3);
});

it.each([
  [{ inputBytes: 1 }, "input-size"], [{ totalInputBytes: 5 }, "input-total"], [{ files: 1 }, "file-limit"],
  [{ depth: 1 }, "depth-limit"], [{ outputBytes: 1 }, "output-size"],
])("enforces limits %j and continues", async (limits, reason) => {
  const { options } = await setup({ "a.smp": "12345", "b.smp": "12345", "sub/deep/c.smp": "12345" });
  const result = await convertFolder({ ...options, limits });
  expect(result.entries.some(entry => entry.reason === reason)).toBe(true);
});

it("enforces aggregate output size and refuses raising limits", async () => {
  const { options } = await setup({ "a.smp": "x", "b.smp": "y" });
  const size = Buffer.byteLength(options.serialize(sampleDocument));
  const result = await convertFolder({ ...options, limits: { totalOutputBytes: size } });
  expect(result.counts).toEqual({ success: 1, skipped: 0, failed: 1 });
  expect(result.entries.some(entry => entry.reason === "output-total")).toBe(true);
  await expect(convertFolder({ ...options, limits: { entries: FOLDER_IMPORT_LIMITS.entries + 1 } })).rejects.toThrow("invalid-input");
});

it("marks unscanned entries separately from subtree skips", async () => {
  const { options } = await setup({ ".hidden/a.smp": "x", "a.smp": "x", "b.smp": "x" });
  const result = await convertFolder({ ...options, limits: { entries: 1 } });
  expect(result.truncated).toBe(true);
  expect(result.entries.length).toBeLessThanOrEqual(1);
});

it("continues after worker timeouts, invalid results and notification errors", async () => {
  const { options } = await setup({ "a.smp": "a", "b.smp": "b", "c.smp": "c" });
  let calls = 0;
  const result = await convertFolder({ ...options,
    onProgress() { throw new Error("UI disconnected"); },
    convertFile: async () => ++calls < 3 ? { ok: false, error: calls === 1 ? "timeout" : "import-failed" } : { ok: true, document: sampleDocument, issues: [], sourceName: "c.smp" },
  });
  expect(result.counts).toEqual({ success: 1, skipped: 0, failed: 2 });
});

it("rejects output inside input without creating anything", async () => {
  const { options } = await setup();
  await expect(convertFolder({ ...options, outputParent: options.inputDirectory })).rejects.toThrow("invalid-input");
  expect(await fs.readdir(options.inputDirectory)).toEqual(["a.smp"]);
});

it.each(["file", "directory"])("rejects a scanned %s replaced before reading", async kind => {
  const { options } = await setup({ "sub/a.smp": "a" });
  let changed = false;
  const result = await convertFolder({ ...options, onProgress(progress) {
    if (progress.phase !== "converting" || changed) return;
    changed = true;
    // Synchronous operation makes the race reproducible at the read boundary.
    const filename = kind === "file" ? path.join(options.inputDirectory, "sub/a.smp") : path.join(options.inputDirectory, "sub");
    renameSync(filename, `${filename}-old`);
    symlinkSync(`${filename}-old`, filename);
  } });
  expect(result.entries).toContainEqual(expect.objectContaining({ status: "failed", reason: "changed" }));
});

it("never overwrites collisions and continues after a save failure", async () => {
  const { options } = await setup({ "a.smp": "a", "b.smp": "b" });
  const original = fs.open.bind(fs);
  const write = vi.spyOn(fs, "open");
  // Inject an existing output at the exact exclusive-create boundary.
  const actual = await import("node:fs");
  write.mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (args[1] === "wx" && String(args[0]).endsWith("a.smp.sigma")) actual.writeFileSync(args[0] as string, "existing");
    return original(...args);
  });
  const result = await convertFolder(options);
  expect(result.counts).toEqual({ success: 1, failed: 1, skipped: 0 });
  expect(await fs.readFile(path.join(result.outputDirectory, "a.smp.sigma"), "utf8")).toBe("existing");
});

it("returns results when only the report write fails", async () => {
  const { options } = await setup();
  const original = fs.writeFile.bind(fs);
  vi.spyOn(fs, "writeFile").mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
    if (String(args[0]).endsWith("conversion-report.json")) throw new Error("disk full /private/path");
    return original(...args);
  });
  const result = await convertFolder(options);
  expect(result.reportError).toBe("write-failed");
  expect(result.counts.success).toBe(1);
  expect(JSON.stringify(result)).not.toContain("/private/path");
});
