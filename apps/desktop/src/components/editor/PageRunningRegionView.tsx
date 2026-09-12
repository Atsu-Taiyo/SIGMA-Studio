import {
  getRunningRegionOverlaySize,
  mmToPx,
  pageRunningRegionHasContent,
  type PageMetrics,
  type MathFractionSizing,
  type PageRunningRegion,
} from "@/features/document";
import { TextFlowStaticBlock } from "@/components/editor/text-flow/TextFlowStaticBlock";
import type { CSSProperties } from "react";

import { PageRunningRegionOverlay } from "./PageRunningRegionOverlay";

interface PageRunningRegionViewProps {
  region?: PageRunningRegion;
  kind: "header" | "footer";
  title: string;
  pageNumber: number;
  totalPages: number;
  metrics: PageMetrics;
  mathFractionSizing?: MathFractionSizing | null;
}

export function PageRunningRegionView({
  region,
  kind,
  title,
  pageNumber,
  totalPages,
  metrics,
  mathFractionSizing,
}: PageRunningRegionViewProps) {
  if (!region?.enabled || !pageRunningRegionHasContent(region)) {
    return null;
  }

  if (pageNumber === 1 && !region.showOnFirstPage) {
    return null;
  }

  const style = {
    left: `${metrics.margins.leftPx}px`,
    right: `${metrics.margins.rightPx}px`,
    height: `${mmToPx(region.heightMm)}px`,
    [kind === "header" ? "top" : "bottom"]: `${mmToPx(region.offsetMm)}px`,
  } as CSSProperties;
  const overlaySize = getRunningRegionOverlaySize(metrics.content.widthPx, region);

  // The running text is rendered by the same component as the body, inside the body's own
  // `.text-flow-editor` typography — no `.print-*` family and no `variant` fork. Every production
  // caller passed `variant="print"`, and `.text-flow-editor p` (0,1,1) already outranked
  // `.print-paragraph` (0,1,0), so the body rules were what applied all along.
  const resolveText = (text: string) => renderTemplateText(text, title, pageNumber, totalPages);

  return (
    <div className={`page-running-region ${kind} free`} style={style}>
      <PageRunningRegionOverlay
        overlay={region.overlay}
        widthPx={overlaySize.widthPx}
        heightPx={overlaySize.heightPx}
      />
      <div className="page-running-text-layer text-flow-shell">
        <div className="text-flow-editor">
          {region.blocks.map((block) => (
            <TextFlowStaticBlock
              key={block.id}
              block={block}
              mathFractionSizing={mathFractionSizing}
              resolveText={resolveText}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function renderTemplateText(text: string, title: string, pageNumber: number, totalPages: number): string {
  return text
    .split(/(\{title\}|\{page\}|\{total\}|\/\s*title|\/\s*page|\/\s*total)/g)
    .map((part) => {
      const normalized = part.replace(/\s+/g, "");
      if (normalized === "{title}" || normalized === "/title") {
        return title;
      }
      if (normalized === "{page}" || normalized === "/page") {
        return String(pageNumber);
      }
      if (normalized === "{total}" || normalized === "/total") {
        return String(totalPages);
      }
      return part;
    })
    .join("");
}
