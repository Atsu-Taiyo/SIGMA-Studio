import { buildInsertShape } from "@/components/editor/overlay-canvas/shapes/create-shape";
import { createChartShapeProps } from "@/components/editor/overlay-canvas/shapes/chart";
import { createPlainTableSpec } from "@/components/editor/overlay-canvas/shapes/table";
import type { InsertTool } from "@/components/editor/overlay-canvas/interaction-mode";
import type { OverlayAsset, OverlayShape } from "@/features/document";

export function pocketShapeFixtures(): { shapes: Record<OverlayShape["type"], OverlayShape>; assets: Record<string, OverlayAsset> } {
  const insert = (command: InsertTool["command"]): OverlayShape => {
    const shape = buildInsertShape({ kind: "insert", command }, { x: 20, y: 30 }, { x: 220, y: 150 }, `source_${command}`);
    if (!shape) throw new Error(`Cannot create ${command}`);
    return shape;
  };
  const asset: OverlayAsset = {
    id: "source_asset", type: "image",
    props: {
      w: 20, h: 20, name: "image.svg", isAnimated: false, mimeType: "image/svg+xml",
      src: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20"/></svg>',
      fileSize: 120,
    },
  };
  return {
    // 種別追加時に、ポケットの往復検証から漏れないよう網羅性を型で確かめる。
    shapes: {
      group: { id: "source_group", type: "group", x: 20, y: 30, props: { w: 200, h: 120 } },
      geo: insert("rectangle"),
      arc: insert("arc"),
      arrow: insert("arrow"),
      line: insert("line"),
      text: insert("text"),
      image: { id: "source_image", type: "image", x: 20, y: 30, props: { w: 20, h: 20, assetId: asset.id } },
      callout: insert("callout"),
      graph2dShape: insert("graph"),
      graph3dShape: insert("graph3d"),
      tableShape: insert("table"),
      chartShape: { id: "source_chart", type: "chartShape", x: 20, y: 30, props: createChartShapeProps(createPlainTableSpec(), "source_table", 200, 120) },
    },
    assets: { [asset.id]: asset },
  };
}
