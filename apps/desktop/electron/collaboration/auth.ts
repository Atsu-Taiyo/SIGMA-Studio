import { safeStorage, shell } from "electron";
import { promises as fs } from "node:fs";
import path from "node:path";
import { durableWrite } from "./journal";
import { googleAuthorization } from "./oauth";

export interface CollaborationConfig {
  apiUrl: string;
  authUrl: string;
  publicKey: string;
}
interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in: number;
  user: {
    id: string;
    email?: string;
    user_metadata?: Record<string, unknown>;
    displayName?: string;
    avatarUrl?: string;
  };
}
function secureStorageAvailable(): boolean {
  return (
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== "linux" ||
      (typeof safeStorage.getSelectedStorageBackend === "function" &&
        !["basic_text", "unknown"].includes(
          safeStorage.getSelectedStorageBackend(),
        )))
  );
}
// Replaced only by the Electron build. Unit tests and source execution have no defaults.
declare const __SIGMA_COLLABORATION_DEFAULTS__: Record<string, string> | null;
export function collaborationConfig(): CollaborationConfig | null {
  const defaults = typeof __SIGMA_COLLABORATION_DEFAULTS__ === "undefined" ? null : __SIGMA_COLLABORATION_DEFAULTS__;
  const apiUrl = process.env.SIGMA_COLLABORATION_URL ?? defaults?.SIGMA_COLLABORATION_URL;
  const authUrl = process.env.SIGMA_SUPABASE_URL ?? defaults?.SIGMA_SUPABASE_URL;
  const publicKey = process.env.SIGMA_SUPABASE_ANON_KEY ?? defaults?.SIGMA_SUPABASE_ANON_KEY;
  if (!apiUrl || !authUrl || !publicKey) return null;
  try {
    for (const address of [apiUrl, authUrl]) {
      const url = new URL(address);
      if (
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.protocol !== "https:" &&
          !(
            process.env.NODE_ENV !== "production" &&
            url.protocol === "http:" &&
            ["127.0.0.1", "localhost"].includes(url.hostname)
          ))
      )
        return null;
    }
    if (
      !publicKey.startsWith("sb_publishable_") &&
      JSON.parse(
        Buffer.from(publicKey.split(".")[1] ?? "", "base64url").toString(),
      ).role !== "anon"
    )
      return null;
  } catch {
    return null;
  }
  return { apiUrl, authUrl, publicKey };
}
/** Only main owns tokens. The renderer receives email and actor id, never bearer credentials. */
export class CollaborationAuth {
  private tokens?: Tokens;
  private refreshTask?: Promise<void>;
  private login?: AbortController;
  private generation = 0;
  private persistence: Promise<void> = Promise.resolve();
  constructor(
    private readonly directory: string,
    readonly config: CollaborationConfig,
  ) {}
  async initialize(): Promise<void> {
    try {
      if (!secureStorageAvailable()) return;
      const encrypted = await fs.readFile(
        path.join(this.directory, "auth.enc"),
        "utf8",
      );
      this.tokens = JSON.parse(
        safeStorage.decryptString(Buffer.from(encrypted, "base64")),
      ) as Tokens;
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      )
        this.tokens = undefined;
    }
  }
  user(): { id: string; email?: string; displayName?: string; avatarUrl?: string } | null {
    return this.tokens?.user ?? null;
  }
  async signInWithGoogle(): Promise<void> {
    if (this.login) throw new Error("AUTH_IN_PROGRESS");
    if (!secureStorageAvailable()) throw new Error("SECURE_STORAGE_UNAVAILABLE");
    const login = new AbortController();
    this.login = login;
    const generation = this.generation;
    try {
      const { code, verifier } = await googleAuthorization(this.config.authUrl, (url) => shell.openExternal(url), login.signal);
      const tokens = await this.authRequest("/token?grant_type=pkce", { auth_code: code, code_verifier: verifier }) as Tokens;
      if (this.generation !== generation || login.signal.aborted) throw new Error("AUTH_CANCELLED");
      await this.store(tokens, generation, login.signal);
    } finally {
      if (this.login === login) this.login = undefined;
    }
  }
  cancelSignIn(): void {
    this.login?.abort();
  }
  async authorization(): Promise<string> {
    if (!this.tokens) throw new Error("AUTH_REQUIRED");
    if ((this.tokens.expires_at ?? 0) * 1000 < Date.now() + 60_000) {
      const generation = this.generation;
      this.refreshTask ??= this.authRequest("/token?grant_type=refresh_token", {
        refresh_token: this.tokens.refresh_token,
      })
        .then((value) => {
          if (generation !== this.generation) throw new Error("AUTH_REQUIRED");
          return this.store(value as Tokens, generation);
        })
        .finally(() => {
          this.refreshTask = undefined;
        });
      await this.refreshTask;
    }
    return `Bearer ${this.tokens!.access_token}`;
  }
  async signOut(): Promise<void> {
    this.cancelSignIn();
    this.generation++;
    const authorization = this.tokens?.access_token;
    this.tokens = undefined;
    await this.persistence.catch(() => {});
    await fs.rm(path.join(this.directory, "auth.enc"), { force: true });
    if (authorization)
      await fetch(`${this.config.authUrl}/auth/v1/logout`, {
        method: "POST",
        headers: {
          apikey: this.config.publicKey,
          Authorization: `Bearer ${authorization}`,
        },
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
  }
  private async authRequest(route: string, body: unknown): Promise<unknown> {
    const response = await fetch(`${this.config.authUrl}/auth/v1${route}`, {
      method: "POST",
      headers: {
        apikey: this.config.publicKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(
        response.status === 429 ? "AUTH_RATE_LIMIT" : "AUTH_FAILED",
      );
    return response.json();
  }
  private store(tokens: Tokens, generation: number, signal?: AbortSignal): Promise<void> {
    const next = this.persistence.then(async () => {
      if (signal?.aborted) throw new Error("AUTH_CANCELLED");
      if (generation !== this.generation) throw new Error("AUTH_REQUIRED");
      if (!tokens.access_token || !tokens.refresh_token || !tokens.user?.id)
        throw new Error("AUTH_FAILED");
      // Discard Google provider tokens and unrelated response fields.
      const metadata = tokens.user.user_metadata ?? {};
      const displayName = [tokens.user.displayName, metadata.full_name, metadata.name]
        .find((value): value is string => typeof value === "string" && value.trim().length > 0)
        ?.trim().slice(0, 120);
      const rawAvatar = [tokens.user.avatarUrl, metadata.avatar_url, metadata.picture]
        .find((value): value is string => typeof value === "string");
      const avatarUrl = sanitizeGoogleAvatarUrl(rawAvatar);
      tokens = { access_token: tokens.access_token, refresh_token: tokens.refresh_token,
        expires_at: tokens.expires_at ?? Math.floor(Date.now() / 1000) + tokens.expires_in,
        expires_in: tokens.expires_in, user: {
          id: tokens.user.id,
          ...(tokens.user.email ? { email: tokens.user.email.slice(0, 254) } : {}),
          ...(displayName ? { displayName } : {}),
          ...(avatarUrl ? { avatarUrl } : {}),
        } };
      if (!secureStorageAvailable())
        throw new Error("SECURE_STORAGE_UNAVAILABLE");
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      await durableWrite(
        path.join(this.directory, "auth.enc"),
        safeStorage.encryptString(JSON.stringify(tokens)).toString("base64"),
      );
      if (signal?.aborted) {
        await fs.rm(path.join(this.directory, "auth.enc"), { force: true });
        throw new Error("AUTH_CANCELLED");
      }
      if (generation === this.generation) this.tokens = tokens;
    });
    this.persistence = next.catch(() => {});
    return next;
  }
}

export function sanitizeGoogleAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !(url.hostname === "googleusercontent.com" || url.hostname.endsWith(".googleusercontent.com")) ||
      url.username || url.password
    ) return;
    return url.toString();
  } catch {
    return;
  }
}

const MAX_PROFILE_IMAGE_BYTES = 2 * 1024 * 1024;
const PROFILE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export async function profileImageResponse(source: string): Promise<Response> {
  let requested: string | null = null;
  try {
    requested = new URL(source).searchParams.get("url");
  } catch {
    return new Response(null, { status: 404 });
  }
  const avatarUrl = sanitizeGoogleAvatarUrl(requested);
  if (!avatarUrl) return new Response(null, { status: 404 });
  try {
    const response = await fetch(avatarUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "image/png,image/jpeg,image/webp,image/gif" },
    });
    const type = response.headers.get("Content-Type")?.split(";")[0].trim() ?? "";
    const declared = Number(response.headers.get("Content-Length"));
    if (!response.ok || !PROFILE_IMAGE_TYPES.has(type) || (Number.isFinite(declared) && declared > MAX_PROFILE_IMAGE_BYTES))
      return new Response(null, { status: 404 });
    const reader = response.body?.getReader();
    if (!reader) return new Response(null, { status: 404 });
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.length;
      if (length > MAX_PROFILE_IMAGE_BYTES) {
        await reader.cancel();
        return new Response(null, { status: 413 });
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new Response(bytes, {
      headers: {
        "Content-Type": type,
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
