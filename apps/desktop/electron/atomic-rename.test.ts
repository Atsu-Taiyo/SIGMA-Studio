import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { atomicRename } from "./atomic-rename";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-rename-"));
  directories.push(directory);
  const source = path.join(directory, "document.tmp"), target = path.join(directory, "document.json");
  await fs.writeFile(source, "new");
  await fs.writeFile(target, "old");
  return { source, target };
}

it.each(["EPERM", "EACCES", "EBUSY"])("retries Windows %s without removing the original document", async code => {
  const { source, target } = await fixture();
  const rename = fs.rename.bind(fs);
  const spy = vi.spyOn(fs, "rename").mockImplementationOnce(async () => {
    expect(await fs.readFile(target, "utf8")).toBe("old");
    throw Object.assign(new Error("sharing violation"), { code });
  }).mockImplementation(rename);
  await atomicRename(source, target, "win32");
  expect(spy).toHaveBeenCalledTimes(2);
  expect(await fs.readFile(target, "utf8")).toBe("new");
  await expect(fs.access(source)).rejects.toThrow();
});

it("bounds retries and preserves both files when Windows continues to deny replacement", async () => {
  const { source, target } = await fixture();
  const error = Object.assign(new Error("denied"), { code: "EPERM" });
  const spy = vi.spyOn(fs, "rename").mockRejectedValue(error);
  await expect(atomicRename(source, target, "win32")).rejects.toBe(error);
  expect(spy).toHaveBeenCalledTimes(6);
  expect(await fs.readFile(target, "utf8")).toBe("old");
  expect(await fs.readFile(source, "utf8")).toBe("new");
});

it.each([["linux", "EPERM"], ["win32", "ENOSPC"]] as const)("does not retry %s %s", async (platform, code) => {
  const { source, target } = await fixture();
  const error = Object.assign(new Error("failed"), { code });
  const spy = vi.spyOn(fs, "rename").mockRejectedValue(error);
  await expect(atomicRename(source, target, platform)).rejects.toBe(error);
  expect(spy).toHaveBeenCalledOnce();
});
