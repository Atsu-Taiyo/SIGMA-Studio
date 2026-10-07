export type LinkDestination = "browser" | "external";
export type LinkWarning = "unencrypted" | "credentials" | "international" | "address";

export interface LinkConfirmationRequest {
  id: string;
  /** Display only. Embedded passwords are never sent to the renderer. */
  url: string;
  host: string;
  destination: LinkDestination;
  warnings: LinkWarning[];
}

export interface LinkConfirmationAPI {
  pending(): Promise<LinkConfirmationRequest | null>;
  respond(id: string, approved: boolean): Promise<void>;
  onChanged(handler: () => void): () => void;
}

/** Signs to inspect, not a reputation or malware verdict. Show the actual ASCII host. */
export function inspectLink(value: string, destination: LinkDestination): Omit<LinkConfirmationRequest, "id"> | null {
  if (typeof value !== "string" || value.length > 16_384) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:", ...(destination === "external" ? ["mailto:"] : [])].includes(url.protocol)) return null;
    const warnings: LinkWarning[] = [];
    if (url.protocol === "http:") warnings.push("unencrypted");
    if (url.username || url.password) {
      warnings.push("credentials");
      url.username = "";
      url.password = "";
    }
    if (url.hostname.split(".").some(part => part.startsWith("xn--"))) warnings.push("international");
    if (url.hostname === "localhost" || url.hostname.endsWith(".local") || /^\[|^\d+(\.\d+){3}$/.test(url.hostname)) warnings.push("address");
    return { url: url.href, host: url.host || url.pathname, destination, warnings };
  } catch {
    return null;
  }
}
