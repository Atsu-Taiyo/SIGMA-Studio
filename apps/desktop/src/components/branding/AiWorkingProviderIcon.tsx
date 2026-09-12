import { renderProviderMark } from "@/components/branding/provider-logos";
import { Shimmer } from "@/components/ui/Shimmer";
import type { AiProvider } from "@/lib/ai/ai-providers";

interface AiWorkingProviderIconProps {
  provider: AiProvider;
  className?: string;
  size?: number;
}

/** AIの実行中を示す、本文アンカーと図形ロックで共通の煌めくプロバイダアイコン。 */
export function AiWorkingProviderIcon({
  provider,
  className = "",
  size = 16,
}: AiWorkingProviderIconProps) {
  return (
    <Shimmer variant="icon" className={`ai-working-provider-icon ${className}`.trim()}>
      {renderProviderMark(provider, { size })}
    </Shimmer>
  );
}
