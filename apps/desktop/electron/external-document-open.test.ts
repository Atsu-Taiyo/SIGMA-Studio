import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { documentPathsFromArgv, ExternalDocumentOpenQueue } from "./external-document-open";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("OS document arguments", () => {
  it("handles packaged Windows paths, spaces, Unicode, relative paths and duplicates", () => {
    expect(documentPathsFromArgv([
      "C:\\Sigma Studio.exe", "C:\\Downloads\\数学 1.sigma", "..\\旧.sigma.json", "C:\\Downloads\\数学 1.sigma",
      "--inspect=9222", "--config=settings.sigma", "settings.json", "https://example.com/file.txt",
    ], "C:\\Downloads\\folder", false, "win32")).toEqual([
      "C:\\Downloads\\数学 1.sigma", "C:\\Downloads\\旧.sigma.json",
    ]);
  });

  it.each(["linux", "darwin"] as const)("handles initial and second-instance %s argv without importing the dev entry", (platform) => {
    expect(documentPathsFromArgv([
      "/Electron", "/dev-entry.sigma", "./数学 2.SIGMA", "../旧.sigmadoc.json", "--", "ordinary.json",
    ], "/tmp/downloads", true, platform)).toEqual([
      "/tmp/downloads/数学 2.SIGMA", "/tmp/旧.sigmadoc.json",
    ]);
  });
});

describe("OS open queue", () => {
  it("buffers before readiness, reads without writing, deduplicates pending paths and retains until acknowledged", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-open-"));
    directories.push(directory);
    const first = path.join(directory, "数学 1.sigma");
    const second = path.join(directory, "旧.sigma.json");
    await fs.writeFile(first, '{"unchanged":true}');
    await fs.writeFile(second, "legacy");
    const notify = vi.fn();
    const queue = new ExternalDocumentOpenQueue(notify);
    queue.enqueue([first, first, second, path.join(directory, "settings.json"), "relative.sigma"]);
    expect(notify).toHaveBeenCalledOnce();
    const read = await queue.readNext();
    expect(read).toEqual({ id: 1, filePath: first, data: '{"unchanged":true}' });
    expect(await queue.readNext()).toEqual(read); // renderer remount can retry
    queue.acknowledge(999);
    expect(await queue.readNext()).toEqual(read);
    queue.acknowledge(1);
    expect(await queue.readNext()).toEqual({ id: 2, filePath: second, data: "legacy" });
    queue.acknowledge(2);
    expect(await queue.readNext()).toBeNull();
    expect(await fs.readFile(first, "utf8")).toBe('{"unchanged":true}');
    expect(await fs.readFile(second, "utf8")).toBe("legacy");
    queue.enqueue([first]); // an explicit later open is a new request
    expect((await queue.readNext())?.id).toBe(3);
  });

  it("reports missing paths and directories then allows the next file", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-open-"));
    directories.push(directory);
    const folder = path.join(directory, "folder.sigma");
    await fs.mkdir(folder);
    const queue = new ExternalDocumentOpenQueue(() => {});
    queue.enqueue([path.join(directory, "missing.sigma"), folder]);
    expect(await queue.readNext()).toMatchObject({ id: 1, error: expect.stringContaining("ENOENT") });
    queue.acknowledge(1);
    expect(await queue.readNext()).toMatchObject({ id: 2, error: "Not a regular file" });
    queue.acknowledge(2);
    expect(await queue.readNext()).toBeNull();
  });
});
