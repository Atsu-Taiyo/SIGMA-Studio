import { getShapesSelectionBounds } from "@/features/drawing";
import {
  inlineNodesToPlainText,
  type BoxBlockChildBlock,
  type SigmaBlock,
  type LayoutSectionChildBlock,
  type ProblemAreaBlock,
} from "@/features/document";
import { exportOverlaySvg } from "@/features/rendering/adapters/svg";
import { isOfficialMaterial } from "@/lib/official-materials";
import type { MaterialContent, MaterialItem } from "@/types/material";
import { useT } from "@/lib/i18n/react";
import type { Translate } from "@/lib/i18n/translator";

export function MaterialPreview({ material }: { material: MaterialItem }) {
  return <MaterialContentPreview content={material.content} title={material.name} box={isOfficialMaterial(material)} />;
}

export function MaterialContentPreview({ content, title, box = false }: { content: MaterialContent; title: string; box?: boolean }) {
  const t = useT("workspace");
  const svg = getMaterialPreviewSvg(content);
  const rows = getMaterialPreviewRows(content.blocks, t);
  const text = rows.map((row) => row.text).join(" / ").slice(0, 64);
  const boxComposite = box && Boolean(svg) && rows.length > 0;
  const previewClassName = [
    "material-library-preview",
    svg && rows.length > 0 ? "mixed" : svg ? "with-figure" : "text-only",
    boxComposite ? "box" : "",
    !svg && rows.length === 0 ? "empty" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className={previewClassName} aria-hidden="true" title={text || title}>
      <div className="material-preview-workspace">
        <div className="material-preview-paper">
          {rows.length > 0 && (
            <div className="material-preview-flow">
              {rows.map((row) => (
                <span className={`material-preview-flow-row ${row.variant}`} key={row.key}>{row.text}</span>
              ))}
            </div>
          )}
          {svg ? (
            <div className="material-library-preview-svg" dangerouslySetInnerHTML={{ __html: svg }} />
          ) : rows.length === 0 ? (
            <span className="material-preview-empty-label">{t("asset.emptyLabel")}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function getMaterialPreviewSvg(content: MaterialContent): string | undefined {
  const snapshot = content.overlaySnapshot;
  const bounds = getShapesSelectionBounds(snapshot.shapes);
  if (!bounds) {
    return undefined;
  }

  const padding = 8;
  return exportOverlaySvg(snapshot.shapes, snapshot.assets, {
    width: Math.max(1, bounds.w + padding * 2),
    height: Math.max(1, bounds.h + padding * 2),
    offsetX: bounds.x - padding,
    offsetY: bounds.y - padding,
  });
}

type MaterialPreviewRowVariant = "section" | "heading" | "paragraph" | "list" | "problem";

interface MaterialPreviewRow {
  key: string;
  text: string;
  variant: MaterialPreviewRowVariant;
}

function getMaterialPreviewRows(blocks: readonly SigmaBlock[], t: Translate<"workspace">): MaterialPreviewRow[] {
  return blocks
    .map((block, index): MaterialPreviewRow | null => {
      const text = getMaterialBlockPreviewText(block);
      if (!text) {
        return null;
      }
      const variant = getMaterialPreviewRowVariant(block);
      return {
        key: `${block.id}-${index}`,
        text: getMaterialPreviewRowLabel(text, variant, t),
        variant,
      };
    })
    .filter((row): row is MaterialPreviewRow => row !== null)
    .slice(0, 4);
}

function getMaterialPreviewRowVariant(block: SigmaBlock): MaterialPreviewRowVariant {
  if (block.type === "section") {
    return "section";
  }
  if (block.type === "heading") {
    return "heading";
  }
  if (block.type === "list") {
    return "list";
  }
  if (block.type === "boxBlock") {
    return "paragraph";
  }
  if (block.type === "problem") {
    return "problem";
  }
  return "paragraph";
}

function getMaterialPreviewRowLabel(
  text: string,
  variant: MaterialPreviewRowVariant,
  t: Translate<"workspace">,
): string {
  if (variant === "list") {
    return t("asset.previewBullet", { replace: { text } });
  }
  if (variant === "problem") {
    return t("asset.previewProblem", { replace: { text } });
  }
  return text;
}

function getMaterialBlockPreviewText(block: SigmaBlock): string {
  if (block.type === "section") {
    return block.title.trim();
  }
  if (block.type === "heading" || block.type === "paragraph") {
    return inlineNodesToPlainText(block.children).trim();
  }
  if (block.type === "list") {
    return block.items
      .map((item) => inlineNodesToPlainText(item.children).trim())
      .find(Boolean) ?? "";
  }
  if (block.type === "layoutSection") {
    return block.children
      .map(getLayoutSectionChildPreviewText)
      .find(Boolean) ?? "";
  }

  if (block.type === "boxBlock") {
    return getBoxBlockPreviewText(block);
  }

  if (block.type === "divider") {
    return "";
  }

  if (block.type === "quote") {
    return block.blocks.map(getRichBlockPreviewText).find(Boolean) ?? "";
  }

  if (block.type === "codeBlock") {
    return inlineNodesToPlainText(block.children).trim();
  }

  return [...block.lead, ...block.prompt, ...block.hints, ...block.solution]
    .map(getRichBlockPreviewText)
    .find(Boolean) ?? "";
}

function getLayoutSectionChildPreviewText(block: LayoutSectionChildBlock): string {
  if (block.type === "section") {
    return block.title.trim();
  }

  if (block.type === "divider") {
    return "";
  }

  if (block.type === "boxBlock") {
    return getBoxBlockPreviewText(block);
  }

  return getRichBlockPreviewText(block);
}

function getRichBlockPreviewText(block: ProblemAreaBlock): string {
  if (block.type === "layoutSection") {
    return block.children.map(getLayoutSectionChildPreviewText).find(Boolean) ?? "";
  }
  if (block.type === "boxBlock") {
    return getBoxBlockPreviewText(block);
  }
  if (block.type === "heading" || block.type === "paragraph" || block.type === "codeBlock") {
    return inlineNodesToPlainText(block.children).trim();
  }
  if (block.type === "quote") {
    return block.blocks.map(getRichBlockPreviewText).find(Boolean) ?? "";
  }
  if (block.type === "divider") {
    return "";
  }
  return block.items
    .map((item) => inlineNodesToPlainText(item.children).trim())
    .find(Boolean) ?? "";
}

function getBoxBlockPreviewText(block: Extract<SigmaBlock, { type: "boxBlock" }>): string {
  const title = inlineNodesToPlainText(block.title ?? []).trim();
  if (title) {
    return title;
  }
  return block.blocks.map(getBoxBlockChildPreviewText).find(Boolean) ?? "";
}

function getBoxBlockChildPreviewText(block: BoxBlockChildBlock): string {
  if (block.type === "problem") return getMaterialBlockPreviewText(block);
  if (block.type === "layoutSection") {
    return block.children.map(getLayoutSectionChildPreviewText).find(Boolean) ?? "";
  }
  return getLayoutSectionChildPreviewText(block);
}
