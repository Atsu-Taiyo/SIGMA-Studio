import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const IPC_HANDLE_PATTERN =
  /ipcMain\.handle\(\s*["']([^"']+)["']\s*,\s*(?:async\s*)?(?:\(([\s\S]*?)\)|([A-Za-z_$][\w$]*))\s*=>/gu;

describe("IPC handler signatures", () => {
  it("reserves the first callback parameter for the Electron event", () => {
    const ipcDir = fileURLToPath(new URL("./", import.meta.url));
    const violations: Array<{ channel: string; file: string; firstParameter: string }> = [];

    for (const file of readdirSync(ipcDir)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) {
        continue;
      }
      const source = readFileSync(path.join(ipcDir, file), "utf8");
      const declaredChannels = [
        ...source.matchAll(/ipcMain\.handle\(\s*["']([^"']+)["']/gu),
      ].map((match) => match[1]);
      const parsedHandlers = [...source.matchAll(IPC_HANDLE_PATTERN)];
      const parsedChannels = new Set(parsedHandlers.map((match) => match[1]));

      for (const channel of declaredChannels) {
        if (!parsedChannels.has(channel)) {
          violations.push({ channel, file, firstParameter: "<解析不能>" });
        }
      }

      for (const match of parsedHandlers) {
        const parameters = (match[2] ?? match[3] ?? "").trim();
        if (!parameters) {
          continue;
        }
        const firstParameter = parameters
          .split(",")[0]
          .trim()
          .split(":")[0]
          .trim();
        if (firstParameter !== "_event" && firstParameter !== "event") {
          violations.push({ channel: match[1], file, firstParameter });
        }
      }
    }

    const message = violations
      .map(({ channel, file, firstParameter }) => `${channel} (${file}: ${firstParameter})`)
      .join(", ");
    expect(violations, `IPC handlerの第1引数が不正です: ${message}`).toEqual([]);
  });
});
