import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import type { DownloadItem } from "electron";

const APP_ROOT = path.resolve(__dirname, "../..");
const PARTITION = "persist:sigma-studio-browser";

test("an interrupted download remains tracked and cancellable after fifty newer downloads finish", async () => {
  const server = createServer((request, response) => {
    const name = (request.url ?? "/").slice(1);
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${name}"`,
      "content-length": name === "interrupted.bin" ? 1_000_000 : Buffer.byteLength(name),
      "accept-ranges": "bytes",
      etag: '"download-fixture"',
      "last-modified": "Thu, 01 Jan 1970 00:00:00 GMT",
    });
    if (name === "interrupted.bin") {
      response.write(Buffer.alloc(4096, 42));
      // A real truncated HTTP response makes Chromium emit updated/interrupted.
      setTimeout(() => response.destroy(), 50);
    } else {
      response.end(name);
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const url = `http://127.0.0.1:${address.port}/`;
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-download-history-"));
  const downloads = path.join(profile, "downloads");
  mkdirSync(downloads);
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  let launched: ElectronApplication | undefined;
  try {
    const app = launched = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.browser));
    await expect(page.locator(".startup-splash")).toBeHidden();
    await app.evaluate(({ app, session }, { downloads, partition }) => {
      app.setPath("downloads", downloads);
      const holder = globalThis as unknown as { interruptedDownload?: DownloadItem };
      session.fromPartition(partition).on("will-download", (_event, item) => {
        if (item.getFilename() === "interrupted.bin") holder.interruptedDownload = item;
      });
    }, { downloads, partition: PARTITION });
    await page.evaluate(() => window.desktopAPI!.browser!.openTab());
    const list = () => page.evaluate(async () => (await window.desktopAPI!.browser!.getState())!.downloads);
    await app.evaluate(({ session }, { url, partition }) => session.fromPartition(partition).downloadURL(url), { url: `${url}interrupted.bin`, partition: PARTITION });
    await expect.poll(async () => (await list()).find(item => item.filename === "interrupted.bin")?.state).toBe("interrupted");
    const interrupted = (await list()).find(item => item.filename === "interrupted.bin")!;

    await app.evaluate(({ session }, { url, partition }) => {
      for (let index = 0; index < 50; index++) session.fromPartition(partition).downloadURL(`${url}finished-${index}.txt`);
    }, { url, partition: PARTITION });
    await expect.poll(async () => (await list()).filter(item => item.state === "completed").length).toBe(49);
    expect(await list()).toHaveLength(50);
    expect((await list()).find(item => item.id === interrupted.id)?.state).toBe("interrupted");
    for (let index = 0; index < 50; index++) {
      const name = `finished-${index}.txt`;
      expect(readFileSync(path.join(downloads, name), "utf8")).toBe(name);
    }

    await page.evaluate(() => window.desktopAPI!.browser!.clearDownloads());
    expect((await list()).map(item => item.id)).toEqual([interrupted.id]);
    await page.evaluate(id => window.desktopAPI!.browser!.cancelDownload(id), interrupted.id);
    await expect.poll(async () => (await list())[0]?.state).toBe("cancelled");
    expect(await app.evaluate(() => (globalThis as unknown as { interruptedDownload: DownloadItem }).interruptedDownload.getState())).toBe("cancelled");
    await page.evaluate(() => window.desktopAPI!.browser!.clearDownloads());
    expect(await list()).toEqual([]);
  } finally {
    try {
      await launched?.close();
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(profile, { recursive: true, force: true });
    }
  }
});
