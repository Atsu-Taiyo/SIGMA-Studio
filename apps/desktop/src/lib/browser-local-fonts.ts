import type { LocalFontFace } from "./local-font-contracts";

export type BrowserFontAccess = "prompt" | "loading" | "granted" | "denied" | "unsupported" | "error" | "empty";
export interface BrowserFontCatalog {
  status: BrowserFontAccess;
  systemFonts: LocalFontFace[] | null;
}
interface FontHost {
  queryLocalFonts?: () => Promise<LocalFontFace[]>;
  permissions?: Pick<Permissions, "query">;
}

/** Names only, kept in memory. CSS resolves the selected family from this PC; no font bytes are read or uploaded. */
export class BrowserLocalFonts {
  private catalog: BrowserFontCatalog;
  private listeners = new Set<() => void>();
  private permission: PermissionStatus | null = null;
  private pending: Promise<void> | null = null;
  private generation = 0;
  private readAt = 0;

  constructor(private readonly host: FontHost) {
    this.catalog = { status: host.queryLocalFonts ? "prompt" : "unsupported", systemFonts: null };
  }

  getSnapshot = (): BrowserFontCatalog => this.catalog;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.permission?.addEventListener("change", this.permissionChanged);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.permission?.removeEventListener("change", this.permissionChanged);
    };
  };

  private publish(catalog: BrowserFontCatalog): void {
    this.catalog = catalog;
    this.listeners.forEach(listener => listener());
  }

  private permissionChanged = (): void => {
    if (this.permission?.state === "granted") {
      void this.refresh();
    } else {
      // An in-flight enumeration must not put revoked names back into the menu.
      this.generation++;
      this.publish({ status: this.permission?.state === "denied" ? "denied" : "prompt", systemFonts: null });
    }
  };

  /** Never prompt on mount, focus or print. Restore a previously granted permission when possible. */
  async refresh(): Promise<void> {
    if (!this.host.queryLocalFonts || this.pending) return;
    const generation = this.generation;
    try {
      const permission = await this.host.permissions?.query({ name: "local-fonts" as PermissionName });
      if (permission && permission !== this.permission) {
        this.permission?.removeEventListener("change", this.permissionChanged);
        this.permission = permission;
        if (this.listeners.size) permission.addEventListener("change", this.permissionChanged);
      }
      if (generation !== this.generation || this.pending) return;
      if (permission?.state === "granted") {
        if (this.catalog.systemFonts && Date.now() - this.readAt < 2_000) return;
        await this.read(false);
      } else if (permission) {
        this.publish({ status: permission.state === "denied" ? "denied" : "prompt", systemFonts: null });
      }
    } catch {
      // Some hosts expose enumeration without a Permissions API descriptor. The explicit button still works.
    }
  }

  /** Call directly from the click handler, before awaiting anything, to preserve user activation. */
  request = (): Promise<void> => this.read(true);

  private read(explicit: boolean): Promise<void> {
    if (!this.host.queryLocalFonts) return Promise.resolve();
    if (this.pending) return this.pending;
    const generation = ++this.generation;
    this.publish({ ...this.catalog, status: "loading" });
    let rows: Promise<LocalFontFace[]>;
    try {
      rows = this.host.queryLocalFonts();
    } catch (error) {
      rows = Promise.reject(error);
    }
    this.pending = rows.then(faces => {
      if (generation !== this.generation) return;
      const valid = faces.length > 0 && faces.length <= 8192 && faces.every(face =>
        [face.family, face.fullName, face.postscriptName, face.style].every(value =>
          typeof value === "string" && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value))
        && face.family.trim().length > 0);
      this.readAt = Date.now();
      this.publish({
        status: valid ? "granted" : this.permission?.state === "denied" ? "denied" : faces.length === 0 ? "empty" : "error",
        systemFonts: valid ? faces.map(({ family, fullName, postscriptName, style }) => ({ family, fullName, postscriptName, style })) : null,
      });
    }).catch((error: unknown) => {
      if (generation !== this.generation) return;
      const name = error instanceof Error ? error.name : "";
      this.publish({
        status: name === "NotAllowedError" ? "denied" : !explicit && name === "SecurityError" ? "prompt" : "error",
        systemFonts: null,
      });
    }).finally(() => { this.pending = null; });
    return this.pending;
  }
}

let browserFonts: BrowserLocalFonts | undefined;
export function getBrowserLocalFonts(): BrowserLocalFonts {
  const host = window as Window & { queryLocalFonts?: () => Promise<LocalFontFace[]> };
  return browserFonts ??= new BrowserLocalFonts({
    queryLocalFonts: host.isSecureContext && host.queryLocalFonts ? host.queryLocalFonts.bind(host) : undefined,
    permissions: host.navigator.permissions,
  });
}
