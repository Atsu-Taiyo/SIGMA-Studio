import type { CollaborationProfileRecord } from "../../src/features/collaboration/model/bridge";
import { profileImageResponse, sanitizeGoogleAvatarUrl } from "./auth";
import { readResponseJson } from "./transport";

/**
 * 自分で決める名前とアイコン (共有サーバーの `/profile` `/profiles/*`)。名前も画像も共有サーバーに保存する。
 * 見られるのは本人と共有している相手だけで、その判定はサーバーが持つ。
 *
 * ここは main の中だけで動く: 画面 (renderer) は CSP で外へ出られず (`connect-src 'self'`)、
 * アイコンの画像も `sigma-collaboration-profile://avatar?user=<id>&v=<版>` を通して main が取りに行く。
 */

export type { CollaborationProfileRecord };

type Fetcher = (route: string, init?: RequestInit) => Promise<Response>;

/** 送る前に画面側で 256px 四方へ縮める。サーバーの上限 (512KB) より小さく抑える。 */
export const MAX_AVATAR_UPLOAD_BYTES = 512 * 1024;
export const AVATAR_UPLOAD_TYPES = ["image/webp", "image/png", "image/jpeg"] as const;
const MAX_AVATAR_RESPONSE_BYTES = 1024 * 1024;
const LOOKUP_TTL_MS = 60_000;
const MINE_TTL_MS = 5 * 60_000;
const MAX_LOOKUP_IDS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CollaborationProfiles {
  private mine: { userId: string; value: CollaborationProfileRecord; at: number } | null = null;
  private mineLoading: Promise<CollaborationProfileRecord | null> | null = null;
  private readonly visible = new Map<string, { value: CollaborationProfileRecord | null; at: number }>();
  /** `visible` を引いたアカウント。見える相手はアカウントごとに違うので、替わったら捨てる。 */
  private visibleOwner: string | null = null;
  /** 画像は版ごとに変わらないので、版をつけた鍵で少しだけ手元に置く。 */
  private readonly avatars = new Map<string, Promise<{ type: string; bytes: Uint8Array } | null>>();

  constructor(
    private readonly fetcher: Fetcher,
    private readonly currentUserId: () => string | null,
  ) {}

  /** 自分のプロフィール (名前・アイコンの版)。失敗したら null (Google の名前とアイコンで続ける)。 */
  async current(options: { fresh?: boolean } = {}): Promise<CollaborationProfileRecord | null> {
    const userId = this.currentUserId();
    if (!userId) return null;
    if (!options.fresh && this.mine?.userId === userId && Date.now() - this.mine.at < MINE_TTL_MS) return this.mine.value;
    if (!options.fresh && this.mineLoading) return this.mineLoading;
    const loading = this.fetchJson("/profile").then((value) => {
      const record = parseProfile(value);
      if (record && record.userId === this.currentUserId()) this.remember(record);
      return record;
    }).catch(() => (this.mine?.userId === userId ? this.mine.value : null));
    this.mineLoading = loading;
    try {
      return await loading;
    } finally {
      if (this.mineLoading === loading) this.mineLoading = null;
    }
  }

  /** 手元にあるぶんだけ (待たない)。`info()` のように毎回呼ぶところが使う。 */
  cached(): CollaborationProfileRecord | null {
    const userId = this.currentUserId();
    return this.mine?.userId === userId ? this.mine.value : null;
  }

  async setDisplayName(displayName: string | null): Promise<CollaborationProfileRecord> {
    return this.write(await this.fetchJson("/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName }),
    }));
  }

  async setAvatar(bytes: Uint8Array, type: (typeof AVATAR_UPLOAD_TYPES)[number]): Promise<CollaborationProfileRecord> {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_AVATAR_UPLOAD_BYTES) throw new Error("AVATAR_TOO_LARGE");
    return this.write(await this.fetchJson("/profile/avatar", {
      method: "PUT",
      headers: { "Content-Type": type },
      body: bytes as unknown as BodyInit,
    }));
  }

  async clearAvatar(): Promise<CollaborationProfileRecord> {
    return this.write(await this.fetchJson("/profile/avatar", { method: "DELETE" }));
  }

  /** 共有している相手の名前とアイコン。見えない id は返さない。 */
  async lookup(userIds: readonly string[]): Promise<CollaborationProfileRecord[]> {
    const viewer = this.currentUserId();
    if (!viewer) return [];
    if (this.visibleOwner !== viewer) {
      this.visible.clear();
      this.visibleOwner = viewer;
    }
    const ids = [...new Set(userIds.filter((id) => UUID.test(id)).map((id) => id.toLowerCase()))].slice(0, MAX_LOOKUP_IDS);
    const now = Date.now();
    const missing = ids.filter((id) => {
      const entry = this.visible.get(id);
      return !entry || now - entry.at >= LOOKUP_TTL_MS;
    });
    if (missing.length > 0) {
      const rows = await this.fetchJson("/profiles/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userIds: missing }),
      });
      const found = new Map((Array.isArray(rows) ? rows : []).map(parseProfile).filter((row): row is CollaborationProfileRecord => Boolean(row)).map((row) => [row.userId.toLowerCase(), row]));
      // 待っている間にアカウントが替わったら、前のアカウントから見えた結果を残さない。
      if (this.currentUserId() !== viewer) return [];
      for (const id of missing) this.visible.set(id, { value: found.get(id) ?? null, at: now });
    }
    return ids.map((id) => this.visible.get(id)?.value).filter((row): row is CollaborationProfileRecord => Boolean(row));
  }

  /** `sigma-collaboration-profile://avatar?user=<id>&v=<版>` の中身。 */
  async avatarResponse(userId: string, version: string): Promise<Response> {
    if (!UUID.test(userId) || !/^\d{1,15}$/.test(version) || !this.currentUserId()) return new Response(null, { status: 404 });
    const key = `${this.currentUserId()}:${userId.toLowerCase()}:${version}`;
    let pending = this.avatars.get(key);
    if (!pending) {
      pending = this.fetchAvatar(userId);
      this.avatars.set(key, pending);
      // 失敗は持ち続けない (次に開いたときにもう一度取りに行く)。
      void pending.then((value) => { if (!value) this.avatars.delete(key); });
      if (this.avatars.size > 200) this.avatars.delete(this.avatars.keys().next().value!);
    }
    const avatar = await pending;
    if (!avatar) return new Response(null, { status: 404 });
    return new Response(avatar.bytes as unknown as BodyInit, {
      headers: { "Content-Type": avatar.type, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" },
    });
  }

  /** サインアウト・アカウントの切り替えで、前のアカウントの名前と画像を残さない。 */
  clear(): void {
    this.mine = null;
    this.mineLoading = null;
    this.visible.clear();
    this.visibleOwner = null;
    this.avatars.clear();
  }

  private async fetchAvatar(userId: string): Promise<{ type: string; bytes: Uint8Array } | null> {
    try {
      const response = await this.fetcher(`/profiles/${encodeURIComponent(userId)}/avatar`);
      const type = response.headers.get("Content-Type")?.split(";")[0].trim() ?? "";
      if (!(AVATAR_UPLOAD_TYPES as readonly string[]).includes(type)) {
        await response.body?.cancel();
        return null;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      return bytes.byteLength > 0 && bytes.byteLength <= MAX_AVATAR_RESPONSE_BYTES ? { type, bytes } : null;
    } catch {
      return null;
    }
  }

  private write(value: unknown): CollaborationProfileRecord {
    const record = parseProfile(value);
    if (!record) throw new Error("PROFILE_INVALID_RESPONSE");
    this.remember(record);
    // 自分の行も引き直させる (共有相手として自分を引く場面: コメントの差出人)。
    this.visible.delete(record.userId.toLowerCase());
    return record;
  }

  private remember(record: CollaborationProfileRecord): void {
    this.mine = { userId: record.userId, value: record, at: Date.now() };
  }

  private async fetchJson(route: string, init?: RequestInit): Promise<unknown> {
    const response = await this.fetcher(route, init);
    return readResponseJson<unknown>(response, 256 * 1024);
  }
}

export function parseProfile(value: unknown): CollaborationProfileRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.userId !== "string" || !UUID.test(row.userId)) return null;
  const text = (input: unknown, max: number) => (typeof input === "string" && input.trim() ? input.trim().slice(0, max) : undefined);
  const displayName = text(row.displayName, 60);
  const providerDisplayName = text(row.providerDisplayName, 120);
  const providerAvatarUrl = sanitizeGoogleAvatarUrl(row.providerAvatarUrl);
  const avatarVersion = typeof row.avatarVersion === "number" && Number.isSafeInteger(row.avatarVersion) && row.avatarVersion > 0 ? row.avatarVersion : 0;
  return {
    userId: row.userId,
    ...(displayName ? { displayName } : {}),
    ...(providerDisplayName ? { providerDisplayName } : {}),
    avatarVersion,
    ...(providerAvatarUrl ? { providerAvatarUrl } : {}),
  };
}

/**
 * `sigma-collaboration-profile://avatar?…` の受け口。`?user=<id>&v=<版>` は本人が決めたアイコン
 * (共有サーバーから)、`?url=<Google の URL>` は Google のアイコン。
 */
export function profileProtocolResponse(source: string, profiles: CollaborationProfiles): Promise<Response> {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
  const user = url.searchParams.get("user");
  if (user !== null) return profiles.avatarResponse(user, url.searchParams.get("v") ?? "");
  return profileImageResponse(source);
}
