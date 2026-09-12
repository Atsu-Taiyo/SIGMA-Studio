import type { SigmaCommentAgent, SigmaCommentAgentVendor } from "@/features/document";
import { SIGMA_COMMENT_AGENT_VENDORS } from "@/features/document";

/**
 * コメントの差出人が AI のときの見た目。**ブランド名なので翻訳しない** (i18n 辞書には
 * 載せない: 「OpenAI」は日本語 UI でも「OpenAI」)。色はベンダーの主色で、アバターの
 * 地色として使う。ロゴを持たないベンダーは汎用の AI マークで描く (`hasLogo: false`)。
 */
export interface CommentAgentBrand {
  vendor: SigmaCommentAgentVendor;
  label: string;
  background: string;
  foreground: string;
  hasLogo: boolean;
}

const BRANDS: Record<SigmaCommentAgentVendor, CommentAgentBrand> = {
  openai: { vendor: "openai", label: "OpenAI", background: "#0d0d0d", foreground: "#ffffff", hasLogo: true },
  anthropic: { vendor: "anthropic", label: "Anthropic", background: "#d97757", foreground: "#ffffff", hasLogo: true },
  google: { vendor: "google", label: "Google", background: "#1c69ff", foreground: "#ffffff", hasLogo: true },
  microsoft: { vendor: "microsoft", label: "Microsoft", background: "#ffffff", foreground: "#5e5e5e", hasLogo: true },
  meta: { vendor: "meta", label: "Meta", background: "#0064e0", foreground: "#ffffff", hasLogo: false },
  xai: { vendor: "xai", label: "xAI", background: "#111827", foreground: "#ffffff", hasLogo: false },
  mistral: { vendor: "mistral", label: "Mistral", background: "#fa500f", foreground: "#ffffff", hasLogo: false },
  other: { vendor: "other", label: "AI", background: "#475569", foreground: "#ffffff", hasLogo: false },
};

export function getCommentAgentBrand(vendor: SigmaCommentAgentVendor): CommentAgentBrand {
  return BRANDS[vendor] ?? BRANDS.other;
}

/**
 * ツール入力や保存済み文書から来た値を vendor へ寄せる。知らない語は握りつぶさず
 * `other` にする (ロゴが無いだけで、AI が書いたという事実は表示に残す)。
 */
export function resolveCommentAgentVendor(value: unknown): SigmaCommentAgentVendor {
  if (typeof value !== "string") {
    return "other";
  }
  const normalized = value.trim().toLowerCase();
  const exact = SIGMA_COMMENT_AGENT_VENDORS.find((vendor) => vendor === normalized);
  if (exact) {
    return exact;
  }
  // 製品名で来ることが多いので、代表的なものだけ提供元へ寄せる。
  if (/(^|[^a-z])(openai|chatgpt|gpt|codex|o\d)([^a-z]|$)/.test(normalized)) {
    return "openai";
  }
  if (normalized.includes("claude") || normalized.includes("anthropic")) {
    return "anthropic";
  }
  if (normalized.includes("gemini") || normalized.includes("antigravity") || normalized.includes("google")) {
    return "google";
  }
  if (normalized.includes("copilot") || normalized.includes("microsoft")) {
    return "microsoft";
  }
  if (normalized.includes("llama") || normalized.includes("meta")) {
    return "meta";
  }
  if (normalized.includes("grok") || normalized === "x" || normalized.includes("xai")) {
    return "xai";
  }
  if (normalized.includes("mistral") || normalized.includes("codestral")) {
    return "mistral";
  }
  return "other";
}

/** デスクトップ版の AI プロバイダ表示名 (ChatGPT / Claude / Antigravity) から素性を作る。 */
export function getCommentAgentForProviderName(authorName: string): SigmaCommentAgent {
  return { vendor: resolveCommentAgentVendor(authorName) };
}
