/** Packaged apps never grant a network page access to the preload bridge. */
export function resolveDevServerUrl(isPackaged: boolean, value?: string): string | null {
  if (isPackaged || !value) return null;
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("SIGMA_STUDIO_DEV_SERVER_URL must be an HTTP origin on 127.0.0.1 with an explicit port");
  }
  return url.href;
}

export function isDevServerNavigation(value: string, devUrl: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === new URL(devUrl).origin && !url.username && !url.password;
  } catch {
    return false;
  }
}
