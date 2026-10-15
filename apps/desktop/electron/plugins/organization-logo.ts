import { createHash } from "node:crypto";

export const LOGO_MAX_BYTES = 512 * 1024;

const LOGO_PATH = /^[a-f0-9-]{36}\/[a-f0-9]{64}\.(png|jpg|webp)$/;

/** 先頭のバイト列で画像の種類を判定する。拡張子や Content-Type は信用しない。 */
export function logoMime(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString() === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString() === "WEBP") return "image/webp";
  throw new Error("Unsupported organization logo");
}

/**
 * 所属団体のロゴを、ログイン中の本人の権限で取得して data URL にする。
 * 取得先は設定済みの Auth と同じオリジンの固定パスだけで、リダイレクト・大きすぎる画像・
 * 種類の食い違い・ファイル名のハッシュ不一致はすべて拒否する。
 */
export async function loadOrganizationLogo({ origin, path, authorization, fetchImpl = fetch }: {
  origin: string;
  path: string;
  authorization: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const base = new URL(origin);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/"
    || !/^Bearer [A-Za-z0-9_.-]+$/.test(authorization) || !LOGO_PATH.test(path)) throw new Error("Invalid logo source");
  const response = await fetchImpl(`${base.origin}/storage/v1/object/authenticated/sigma-organization-logos/${path}`, {
    headers: { Authorization: authorization },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  const mime = response.headers.get("content-type")?.split(";")[0];
  if (!response.ok || response.redirected || (response.url && new URL(response.url).origin !== base.origin)
    || Number(response.headers.get("content-length")) > LOGO_MAX_BYTES || !response.body
    || !["image/png", "image/jpeg", "image/webp"].includes(mime ?? "")) {
    await response.body?.cancel();
    throw new Error("Organization logo unavailable");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LOGO_MAX_BYTES) throw new Error("Organization logo too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, total);
  if (logoMime(bytes) !== mime || createHash("sha256").update(bytes).digest("hex") !== path.split("/")[1].split(".")[0]) {
    throw new Error("Organization logo verification failed");
  }
  return `data:${mime};base64,${bytes.toString("base64")}`;
}
