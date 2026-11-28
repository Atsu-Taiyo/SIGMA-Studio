"use client";

import { shortAiModelLabel } from "@/lib/ai/ai-model-catalog";
import type { AiProvider } from "@/lib/ai/ai-providers";
import type { Translate } from "@/lib/i18n";

export interface AiModelButtonLabelProps {
  provider: AiProvider;
  /** 内蔵AIはモデルを選ばせないので、AI の名前をそのまま出す。 */
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  /** 思考の深さの呼び名。選べないモデル・内蔵AIでは null (何も出さない)。 */
  effortLabel: string | null;
  t: Translate<"ai">;
}

/**
 * モデルのボタンに出す名前。どの AI かは隣のロゴが示すので、モデルの短い名前 (Fable 5.2 など) と、
 * その後ろに薄い字で思考の深さだけを出す。会社・製品の名前を含む全体は、ボタンの title と読み上げが持つ。
 * チャット・実行カード・枠の描画の 3 つの入力欄が、同じ並びを使う。
 */
export function AiModelButtonLabel({ provider, providerLabel, modelId, modelLabel, effortLabel, t }: AiModelButtonLabelProps) {
  const name = provider === "sigma" ? providerLabel : shortAiModelLabel(provider, { id: modelId, label: modelLabel }, t);
  return (
    <span className="ai-chat-model-button-label">
      <span className="ai-chat-model-button-name">{name}</span>
      {effortLabel && <span className="ai-chat-model-button-effort">{effortLabel}</span>}
    </span>
  );
}
