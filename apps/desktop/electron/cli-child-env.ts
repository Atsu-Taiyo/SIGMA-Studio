import path from "node:path";

/** Provider authentication overrides stay in their respective clients. */
export function buildCliChildEnv(keys: readonly string[], windowsKeys: readonly string[], extraPathEntries: readonly string[]): NodeJS.ProcessEnv & { NODE_ENV: string } {
  const next: NodeJS.ProcessEnv & { NODE_ENV: string } = {
    NODE_ENV: process.env.NODE_ENV ?? "production",
  };
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      next[key] = value;
    }
  }
  if (process.platform === "win32") {
    for (const key of windowsKeys) {
      const value = process.env[key];
      if (typeof value === "string" && value.length > 0) {
        next[key] = value;
      }
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if ((key === "LC_ALL" || key.startsWith("LC_")) && typeof value === "string" && value.length > 0) {
      next[key] = value;
    }
  }

  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const currentPath = getProcessPathEnv(next);
  const pathEntries = currentPath.split(path.delimiter).filter(Boolean);
  for (const entry of extraPathEntries) {
    if (!pathEntries.includes(entry)) {
      pathEntries.push(entry);
    }
  }
  next[pathKey] = pathEntries.join(path.delimiter);
  if (process.platform === "win32") {
    delete next.PATH;
  }

  return next;
}

export function getProcessPathEnv(env: NodeJS.ProcessEnv = process.env): string {
  return process.platform === "win32" ? env.Path ?? env.PATH ?? "" : env.PATH ?? "";
}
