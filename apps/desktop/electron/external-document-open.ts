import fs from "node:fs/promises";
import path from "node:path";
import type { DesktopExternalDocument } from "../src/types/desktop";

/** Generic JSON is deliberately excluded from OS/command-line activation. */
export function isSigmaDocumentPath(filePath: string): boolean {
  return /\.(?:sigma|sigma\.json|sigmadoc\.json)$/i.test(filePath);
}

export function documentPathsFromArgv(
  argv: readonly string[],
  workingDirectory: string,
  defaultApp: boolean,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const paths = platform === "win32" ? path.win32 : path.posix;
  return [...new Set(argv.slice(defaultApp ? 2 : 1)
    .filter((argument) => !argument.startsWith("-") && isSigmaDocumentPath(argument))
    .map((argument) => paths.resolve(workingDirectory, argument)))];
}

/** Paths stay in main until the ready editor has finished handling each request. */
export class ExternalDocumentOpenQueue {
  private pending: { id: number; filePath: string }[] = [];
  private nextId = 1;

  constructor(private readonly notify: () => void) {}

  enqueue(filePaths: readonly string[]): void {
    for (const filePath of filePaths) {
      if (!path.isAbsolute(filePath) || !isSigmaDocumentPath(filePath)) continue;
      if (this.pending.some((entry) => entry.filePath === filePath)) continue;
      this.pending.push({ id: this.nextId++, filePath });
    }
    if (this.pending.length) this.notify();
  }

  async readNext(): Promise<DesktopExternalDocument | null> {
    const entry = this.pending[0];
    if (!entry) return null;
    try {
      // Avoid reading directories, pipes or devices delivered by a file activation.
      if (!(await fs.stat(entry.filePath)).isFile()) throw new Error("Not a regular file");
      const data = await fs.readFile(entry.filePath, "utf8");
      return { ...entry, data };
    } catch (error) {
      return { ...entry, error: error instanceof Error ? error.message : String(error) };
    }
  }

  acknowledge(id: number): void {
    if (this.pending[0]?.id === id) this.pending.shift();
  }
}
