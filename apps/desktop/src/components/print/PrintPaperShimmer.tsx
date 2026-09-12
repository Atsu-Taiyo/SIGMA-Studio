import type { CSSProperties } from "react";

import { Shimmer } from "@/components/ui/Shimmer";

import type { PagedRenderDisplayMode } from "./paged-render/PagedRenderSurface";

interface PrintPaperShimmerProps {
  displayMode?: PagedRenderDisplayMode;
  heightMm: number;
  widthMm: number;
}

/** Keeps the preview's paper geometry visible while its document layout settles. */
export function PrintPaperShimmer({
  displayMode = "vertical",
  heightMm,
  widthMm,
}: PrintPaperShimmerProps) {
  const paperCount = displayMode === "vertical" ? 1 : 2;

  return (
    <div
      className={`print-paper-shimmer print-paper-shimmer--${displayMode}`}
      aria-hidden="true"
    >
      {Array.from({ length: paperCount }, (_, index) => (
        <Shimmer
          key={index}
          variant="surface"
          className="print-paper-shimmer-sheet"
          style={{
            "--print-paper-shimmer-height": `${heightMm}mm`,
            "--print-paper-shimmer-width": `${widthMm}mm`,
          } as CSSProperties}
        />
      ))}
    </div>
  );
}
