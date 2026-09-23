import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { CollaborationAuth, collaborationConfig, profileImageResponse, sanitizeGoogleAvatarUrl } from "./auth";
import { googleAuthorization } from "./oauth";
vi.mock("electron", () => ({ shell: { openExternal: vi.fn() }, safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "gnome_libsecret", encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() } }));
vi.mock("./oauth", () => ({ googleAuthorization: vi.fn() }));
const directories: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetAllMocks(); await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-auth-")); directories.push(directory);
  const auth = new CollaborationAuth(directory, { apiUrl: "https://sync.example.test", authUrl: "https://auth.example.test", publicKey: "sb_publishable_test" });
  vi.mocked(googleAuthorization).mockResolvedValue({ code: "one-use-code", verifier: "private-verifier" });
  return { directory, auth };
}
it("does not persist a late Google login response after sign-out", async () => {
  const { directory, auth } = await fixture();
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  vi.stubGlobal("fetch", vi.fn(() => { started.resolve(); return response.promise; }));
  const verification = auth.signInWithGoogle();
  await started.promise;
  await auth.signOut();
  response.resolve(Response.json({ access_token: "fixture", refresh_token: "fixture-refresh", expires_in: 3600, user: { id: "fixture-user" } }));
  await expect(verification).rejects.toThrow("AUTH_CANCELLED");
  expect(auth.user()).toBeNull();
  await expect(fs.access(path.join(directory, "auth.enc"))).rejects.toThrow();
});
it("accepts only public identity keys and secure production endpoints", () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("SIGMA_COLLABORATION_URL", "https://sync.example.test");
  vi.stubEnv("SIGMA_SUPABASE_URL", "https://auth.example.test");
  vi.stubEnv("SIGMA_SUPABASE_ANON_KEY", "sb_publishable_fixture");
  expect(collaborationConfig()).not.toBeNull();
  vi.stubEnv("SIGMA_SUPABASE_ANON_KEY", "sb_secret_fixture");
  expect(collaborationConfig()).toBeNull();
  vi.stubEnv("SIGMA_SUPABASE_ANON_KEY", "sb_publishable_fixture");
  vi.stubEnv("SIGMA_COLLABORATION_URL", "http://127.0.0.1:8787");
  expect(collaborationConfig()).toBeNull();
});
it("persists only Supabase session fields and reloads the authenticated user", async () => {
  const { directory, auth } = await fixture();
  const request = vi.fn(async () => Response.json({ access_token: "fixture", refresh_token: "fixture-refresh", provider_token: "discard-google-token", expires_in: 3600, user: { id: "fixture-user", email: "test@example.test" } }));
  vi.stubGlobal("fetch", request);
  await auth.signInWithGoogle();
  expect(request).toHaveBeenCalledWith("https://auth.example.test/auth/v1/token?grant_type=pkce", expect.objectContaining({ body: JSON.stringify({ auth_code: "one-use-code", code_verifier: "private-verifier" }) }));
  expect(Buffer.from(await fs.readFile(path.join(directory, "auth.enc"), "utf8"), "base64").toString()).not.toContain("discard-google-token");
  const reopened = new CollaborationAuth(directory, auth.config);
  await reopened.initialize();
  expect(reopened.user()?.id).toBe("fixture-user");
});
it("keeps only sanitized Google profile fields", async () => {
  const { auth } = await fixture();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    access_token: "fixture", refresh_token: "fixture-refresh", expires_in: 3600,
    user: { id: "fixture-user", email: "test@example.test", user_metadata: {
      full_name: "  Test Person  ", avatar_url: "https://lh3.googleusercontent.com/a/photo",
      provider_secret: "discard-me",
    } },
  })));
  await auth.signInWithGoogle();
  expect(auth.user()).toEqual({
    id: "fixture-user", email: "test@example.test", displayName: "Test Person",
    avatarUrl: "https://lh3.googleusercontent.com/a/photo",
  });
});
it("proxies only bounded Google-hosted image responses without redirects", async () => {
  expect(sanitizeGoogleAvatarUrl("http://127.0.0.1/avatar")).toBeUndefined();
  expect(sanitizeGoogleAvatarUrl("https://example.test/avatar")).toBeUndefined();
  const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
    headers: { "Content-Type": "image/png", "Content-Length": "3" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  const response = await profileImageResponse("sigma-collaboration-profile://avatar?url=https%3A%2F%2Flh3.googleusercontent.com%2Fa%2Fphoto");
  expect(response.status).toBe(200);
  expect(fetchMock).toHaveBeenCalledWith("https://lh3.googleusercontent.com/a/photo", expect.objectContaining({ redirect: "manual" }));
  expect((await profileImageResponse("sigma-collaboration-profile://avatar?url=http%3A%2F%2F127.0.0.1%2Fsecret")).status).toBe(404);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/secret" } })));
  expect((await profileImageResponse("sigma-collaboration-profile://avatar?url=https%3A%2F%2Flh3.googleusercontent.com%2Fa")).status).toBe(404);
});
it("rejects overlapping logins and cancels before exchanging any code", async () => {
  const { auth } = await fixture();
  vi.mocked(googleAuthorization).mockImplementation(async (_url, _open, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("AUTH_CANCELLED")), { once: true })));
  const request = vi.fn(); vi.stubGlobal("fetch", request);
  const pending = auth.signInWithGoogle();
  await expect(auth.signInWithGoogle()).rejects.toThrow("AUTH_IN_PROGRESS");
  auth.cancelSignIn();
  await expect(pending).rejects.toThrow("AUTH_CANCELLED");
  expect(request).not.toHaveBeenCalled();
});
