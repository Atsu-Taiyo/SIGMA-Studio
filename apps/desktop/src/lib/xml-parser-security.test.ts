import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);

it("rejects unterminated stop-node XML within a bounded child process", () => {
  // GHSA-474x-hrwr-fgx4: the library's optional stopNodes path used to scan
  // the rest of this malformed input again at every '<'. SIGMA's parsers do
  // not enable that option; this guards the upstream dependency mitigation.
  // Isolate the CPU budget so a regression cannot hang the Vitest worker.
  const result = spawnSync(process.execPath, ["--input-type=commonjs", "-e", `
    const { XMLParser } = require(process.argv[1]);
    const parser = new XMLParser({ stopNodes: ["stop"] });
    try {
      parser.parse("<stop>" + "<a ".repeat(50_000));
    } catch {
      process.stdout.write("invalid-xml");
    }
  `, require.resolve("fast-xml-parser")], {
    encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL",
  });

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe("invalid-xml");
}, 10_000);
