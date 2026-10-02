import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** Windows readers and scanners can briefly prevent replacement of an existing file. */
export async function atomicRename(
  source: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (platform !== "win32" || attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) {
        throw error;
      }
      // Keep the old destination intact; never unlink it to make a rename succeed.
      await delay(20 * 2 ** attempt);
    }
  }
}
