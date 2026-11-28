import { Eye, ShieldCheck, Zap, type LucideIcon } from "lucide-react";
import type { AiPermissionMode } from "@/lib/ai/ai-permission-mode";

/**
 * AIの権限の 3 段階の見せ方 (アイコンと、`ai` 辞書のキー)。
 * 入力欄のピルと設定画面が同じ並び・同じ言葉を使うよう、ここに 1 つだけ置く。
 */
export const AI_PERMISSION_COPY = {
  readOnly: { icon: Eye, label: "permission.readOnly", description: "permission.readOnlyDescription" },
  ask: { icon: ShieldCheck, label: "permission.ask", description: "permission.askDescription" },
  auto: { icon: Zap, label: "permission.auto", description: "permission.autoDescription" },
} as const satisfies Record<AiPermissionMode, { icon: LucideIcon; label: string; description: string }>;
