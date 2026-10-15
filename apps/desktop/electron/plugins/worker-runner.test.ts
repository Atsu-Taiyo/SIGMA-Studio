import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PluginError } from "./manifest";
import { createWorkerRunner } from "./worker-runner";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function worker(source: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-worker-"));
  directories.push(directory);
  const filename = path.join(directory, "worker.cjs");
  await fs.writeFile(filename, `const { parentPort, workerData } = require("node:worker_threads");\n${source}\n`);
  return filename;
}

describe("createWorkerRunner", () => {
  it("returns the result a worker posts and passes the payload through", async () => {
    const filename = await worker(`parentPort.postMessage({ ok: true, result: { echoed: workerData.value } });`);
    expect(await createWorkerRunner()(filename, { value: 42 })).toEqual({ echoed: 42 });
  });

  it("fails a worker that reports failure, throws, or exits without a result", async () => {
    const run = createWorkerRunner();
    await expect(run(await worker(`parentPort.postMessage({ ok: false });`), {})).rejects.toMatchObject({ code: "import-failed" });
    await expect(run(await worker(`throw new Error("boom");`), {})).rejects.toMatchObject({ code: "import-failed" });
    await expect(run(await worker(`process.exit(0);`), {})).rejects.toBeInstanceOf(PluginError);
  });

  it("stops a worker that runs too long", async () => {
    const filename = await worker(`setInterval(() => {}, 1000);`);
    await expect(createWorkerRunner({ timeoutMs: 200 })(filename, {})).rejects.toMatchObject({ code: "timeout" });
  });

  it("serves local font requests and hands over only the bytes it was asked for", async () => {
    const filename = await worker(`
      parentPort.once("message", (message) => parentPort.postMessage({ ok: true, result: { type: message.type, sizes: message.fonts.map((font) => font.bytes.byteLength), family: message.fonts[0].family } }));
      parentPort.postMessage({ type: "local-font-request", families: ["Example Mincho"] });`);
    const seen: Array<{ families: string[]; bundled: string[]; prefixes: string[] }> = [];
    const run = createWorkerRunner({
      loadLocalFonts: async (families, context) => {
        seen.push({ families, bundled: [...context.bundledFamilies], prefixes: [...context.ownFamilyPrefixes] });
        return [{ family: "Example Mincho", bytes: new Uint8Array([1, 2, 3, 4]) }];
      },
    });
    expect(await run(filename, {}, { bundledFamilies: new Set(["Bundled"]), ownFamilyPrefixes: ["Own"] })).toEqual({ type: "local-font-response", sizes: [4], family: "Example Mincho" });
    expect(seen).toEqual([{ families: ["Example Mincho"], bundled: ["Bundled"], prefixes: ["Own"] }]);
  });

  it.each([
    ["not a list", `"Example"`],
    ["too many", `Array.from({ length: 129 }, () => "A")`],
    ["not strings", `[1]`],
    ["too long", `["${"a".repeat(257)}"]`],
  ])("rejects a font request whose families are %s without calling the loader", async (_name, families) => {
    const filename = await worker(`parentPort.postMessage({ type: "local-font-request", families: ${families} });`);
    let calls = 0;
    const run = createWorkerRunner({ loadLocalFonts: async () => { calls += 1; return []; } });
    await expect(run(filename, {})).rejects.toMatchObject({ code: "import-failed" });
    expect(calls).toBe(0);
  });

  it("reports unavailable when the loader cannot read local fonts", async () => {
    const filename = await worker(`parentPort.postMessage({ type: "local-font-request", families: ["A"] });`);
    const run = createWorkerRunner({ loadLocalFonts: async () => { throw new Error("denied"); } });
    await expect(run(filename, {})).rejects.toMatchObject({ code: "unavailable" });
  });
});
