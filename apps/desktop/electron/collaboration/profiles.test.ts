import { describe, expect, it, vi } from "vitest";

import { CollaborationProfiles, parseProfile, profileProtocolResponse } from "./profiles";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const HIDDEN = "33333333-3333-4333-8333-333333333333";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function client(handler: (route: string, init?: RequestInit) => Response | Promise<Response>, userId: string | null = ME) {
  const fetcher = vi.fn(async (route: string, init?: RequestInit) => handler(route, init));
  return { profiles: new CollaborationProfiles(fetcher, () => userId), fetcher };
}

describe("parseProfile", () => {
  it("keeps only a valid id, trimmed names, a positive icon version and Google's https icon", () => {
    expect(parseProfile({ userId: OTHER, displayName: "  花子  ", providerDisplayName: "Hanako", avatarVersion: 4, providerAvatarUrl: "https://lh3.googleusercontent.com/a/x" })).toEqual({
      userId: OTHER, displayName: "花子", providerDisplayName: "Hanako", avatarVersion: 4, providerAvatarUrl: "https://lh3.googleusercontent.com/a/x",
    });
    expect(parseProfile({ userId: OTHER, avatarVersion: -1, providerAvatarUrl: "https://evil.example/x.png" })).toEqual({ userId: OTHER, avatarVersion: 0 });
    expect(parseProfile({ userId: "not-a-uuid", avatarVersion: 1 })).toBeNull();
  });
});

describe("CollaborationProfiles", () => {
  it("looks people up once per minute and returns only the ones the server lets this account see", async () => {
    const { profiles, fetcher } = client((route, init) => {
      expect(route).toBe("/profiles/lookup");
      expect(JSON.parse(String(init?.body))).toEqual({ userIds: [OTHER, HIDDEN] });
      return Response.json([{ userId: OTHER, displayName: "花子", avatarVersion: 2 }]);
    });
    expect(await profiles.lookup([OTHER, HIDDEN, "bad id", OTHER.toUpperCase()])).toEqual([{ userId: OTHER, displayName: "花子", avatarVersion: 2 }]);
    expect(await profiles.lookup([OTHER, HIDDEN])).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("forgets who was visible when another account signs in", async () => {
    let viewer = ME;
    const fetcher = vi.fn(async () => Response.json(viewer === ME ? [{ userId: OTHER, displayName: "花子", avatarVersion: 0 }] : []));
    const profiles = new CollaborationProfiles(fetcher, () => viewer);
    expect(await profiles.lookup([OTHER])).toHaveLength(1);
    viewer = HIDDEN;
    expect(await profiles.lookup([OTHER])).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not ask the server when nobody is signed in", async () => {
    const { profiles, fetcher } = client(() => Response.json([]), null);
    expect(await profiles.lookup([OTHER])).toEqual([]);
    expect(await profiles.current()).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("serves an icon image from the server only for a real id and version, and only image types", async () => {
    const { profiles, fetcher } = client((route) => route === `/profiles/${OTHER}/avatar`
      ? new Response(PNG, { headers: { "Content-Type": "image/png" } })
      : new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } }));
    const response = await profiles.avatarResponse(OTHER, "3");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    // 同じ版は手元から返す。
    await profiles.avatarResponse(OTHER, "3");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await profiles.avatarResponse(HIDDEN, "1")).status).toBe(404);
    expect((await profiles.avatarResponse("../profile", "1")).status).toBe(404);
    expect((await profiles.avatarResponse(OTHER, "1; drop")).status).toBe(404);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("remembers the profile it just saved, so the next info() shows the new name without waiting", async () => {
    const { profiles } = client((_route, init) => Response.json({ userId: ME, displayName: JSON.parse(String(init?.body)).displayName, avatarVersion: 0 }));
    expect(profiles.cached()).toBeNull();
    await profiles.setDisplayName("新しい名前");
    expect(profiles.cached()).toMatchObject({ displayName: "新しい名前" });
    profiles.clear();
    expect(profiles.cached()).toBeNull();
  });

  it("refuses an empty or oversized icon before sending it", async () => {
    const { profiles, fetcher } = client(() => Response.json({ userId: ME, avatarVersion: 1 }));
    await expect(profiles.setAvatar(new Uint8Array(), "image/png")).rejects.toThrow("AVATAR_TOO_LARGE");
    await expect(profiles.setAvatar(new Uint8Array(512 * 1024 + 1), "image/webp")).rejects.toThrow("AVATAR_TOO_LARGE");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("profileProtocolResponse", () => {
  it("routes ?user= to the account's own icon on the server", async () => {
    const { profiles } = client(() => new Response(PNG, { headers: { "Content-Type": "image/png" } }));
    const response = await profileProtocolResponse(`sigma-collaboration-profile://avatar?user=${OTHER}&v=2`, profiles);
    expect(response.status).toBe(200);
    expect((await profileProtocolResponse("sigma-collaboration-profile://avatar?url=https%3A%2F%2Fevil.example%2Fa.png", profiles)).status).toBe(404);
  });
});
