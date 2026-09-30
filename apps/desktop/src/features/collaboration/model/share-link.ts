import type { SigmaCommentAnchor } from "@/features/document";
import { decodeDocumentLocation, encodeDocumentLocation } from "@/lib/document-location";
import type { SharedTargetRef } from "./catalog";

export const SHARE_LINK_SCHEME = "sigma-studio";
export type SharedLink = { target: SharedTargetRef; token?: string; location?: SigmaCommentAnchor };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Links identify a catalog node, never a device-local file or a server URL. */
export function createShareLink(target: SharedTargetRef, token?: string, location?: SigmaCommentAnchor): string {
  const url = new URL(`${SHARE_LINK_SCHEME}://share/${target.kind}/${target.catalogNodeId}`);
  const hash = new URLSearchParams();
  if (token) hash.set("invitation", token);
  if (location) {
    const encoded = encodeDocumentLocation(location);
    if (target.kind !== "document" || !encoded) throw new Error("INVALID_LOCATION");
    hash.set("location", encoded);
  }
  url.hash = hash.toString();
  return url.href;
}

export function parseShareLink(value: string): SharedLink | null {
  if (value.length > 8192) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== `${SHARE_LINK_SCHEME}:` || url.hostname !== "share" || url.username || url.password || url.port || url.search) return null;
    const [, kind, id, extra] = url.pathname.split("/");
    if (extra !== undefined || !["workspace", "folder", "document"].includes(kind) || !UUID.test(id ?? "")) return null;
    const hash = new URLSearchParams(url.hash.slice(1));
    const token = hash.get("invitation");
    if ([...hash.keys()].some(key => key !== "invitation" && key !== "location") || hash.getAll("invitation").length > 1 || (token !== null && !TOKEN.test(token))) return null;
    const location = hash.has("location") ? decodeDocumentLocation(hash.get("location")) : null;
    if (hash.getAll("location").length > 1 || (hash.has("location") && (!location || kind !== "document"))) return null;
    return { ...(location ? { location } : {}), target: { kind, catalogNodeId: id } as SharedTargetRef, ...(token ? { token } : {}) };
  } catch { return null; }
}

export function invitationToken(value: string): string | null {
  const trimmed = value.trim();
  return TOKEN.test(trimmed) ? trimmed : parseShareLink(trimmed)?.token ?? null;
}
