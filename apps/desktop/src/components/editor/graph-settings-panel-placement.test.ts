import { describe, expect, it } from "vitest";

import {
  GRAPH_SETTINGS_PANEL_GAP_PX,
  GRAPH_SETTINGS_PANEL_MARGIN_PX,
  GRAPH_SETTINGS_PANEL_WIDTH_PX,
  getGraphSettingsPanelPlacement,
} from "./graph-settings-panel-placement";

const PANEL = { width: GRAPH_SETTINGS_PANEL_WIDTH_PX, height: 520 };
const VIEWPORT = { width: 1440, height: 900 };

function graphRect(left: number, top: number, width = 444, height = 432) {
  return { left, top, width, height };
}

describe("getGraphSettingsPanelPlacement", () => {
  it("places the panel to the right of the graph when there is room", () => {
    const placement = getGraphSettingsPanelPlacement(graphRect(300, 200), PANEL, VIEWPORT, null);

    expect(placement.side).toBe("right");
    expect(placement.left).toBe(300 + 444 + GRAPH_SETTINGS_PANEL_GAP_PX);
    expect(placement.top).toBe(200);
  });

  it("falls back to the left of the graph when the right side is too narrow", () => {
    const placement = getGraphSettingsPanelPlacement(graphRect(700, 200), PANEL, VIEWPORT, null);

    expect(placement.side).toBe("left");
    expect(placement.left).toBe(700 - GRAPH_SETTINGS_PANEL_GAP_PX - GRAPH_SETTINGS_PANEL_WIDTH_PX);
  });

  it("falls back below the graph when neither side fits", () => {
    const narrow = { width: 700, height: 1200 };
    const placement = getGraphSettingsPanelPlacement(graphRect(160, 100, 380, 300), PANEL, narrow, null);

    expect(placement.side).toBe("below");
    expect(placement.top).toBe(100 + 300 + GRAPH_SETTINGS_PANEL_GAP_PX);
  });

  it("uses the available height below a graph before covering it with a wide grid panel", () => {
    const rect = graphRect(130, 250, 320, 190);
    const placement = getGraphSettingsPanelPlacement(rect, { width: 620, minWidth: 300, height: 480 }, { width: 760, height: 720 }, null);
    expect(placement.side).toBe("below");
    expect(placement.top).toBe(rect.top + rect.height + GRAPH_SETTINGS_PANEL_GAP_PX);
    expect(placement.maxHeight).toBe(260);
    expect(placement.top + placement.maxHeight).toBe(712);
  });

  it("clamps into the viewport when no side has room", () => {
    const tight = { width: 620, height: 520 };
    const placement = getGraphSettingsPanelPlacement(graphRect(120, 60, 380, 400), PANEL, tight, null);

    expect(placement.side).toBe("clamped");
    expect(placement.left).toBeGreaterThanOrEqual(GRAPH_SETTINGS_PANEL_MARGIN_PX);
    expect(placement.left + GRAPH_SETTINGS_PANEL_WIDTH_PX).toBeLessThanOrEqual(
      tight.width - GRAPH_SETTINGS_PANEL_MARGIN_PX,
    );
  });

  it("never lets the panel run past the bottom of the viewport", () => {
    const placement = getGraphSettingsPanelPlacement(graphRect(300, 700), PANEL, VIEWPORT, null);

    expect(placement.top + PANEL.height).toBeLessThanOrEqual(VIEWPORT.height - GRAPH_SETTINGS_PANEL_MARGIN_PX);
    expect(placement.top).toBeGreaterThanOrEqual(GRAPH_SETTINGS_PANEL_MARGIN_PX);
  });

  it("caps maxHeight to the viewport so the body scrolls instead of overflowing", () => {
    const short = { width: 1440, height: 400 };
    const placement = getGraphSettingsPanelPlacement(graphRect(300, 100), PANEL, short, null);

    expect(placement.maxHeight).toBe(short.height - GRAPH_SETTINGS_PANEL_MARGIN_PX * 2);
  });

  it("applies a manual drag offset on top of the automatic position", () => {
    const placement = getGraphSettingsPanelPlacement(graphRect(300, 200), PANEL, VIEWPORT, { dx: -40, dy: 60 });

    expect(placement.left).toBe(300 + 444 + GRAPH_SETTINGS_PANEL_GAP_PX - 40);
    expect(placement.top).toBe(260);
  });

  it("keeps a manually dragged panel inside the viewport", () => {
    const placement = getGraphSettingsPanelPlacement(
      graphRect(300, 200),
      PANEL,
      VIEWPORT,
      { dx: 9000, dy: 9000 },
    );

    expect(placement.left + GRAPH_SETTINGS_PANEL_WIDTH_PX).toBeLessThanOrEqual(
      VIEWPORT.width - GRAPH_SETTINGS_PANEL_MARGIN_PX,
    );
    expect(placement.top + PANEL.height).toBeLessThanOrEqual(VIEWPORT.height - GRAPH_SETTINGS_PANEL_MARGIN_PX);
  });

  it("does not overlap the graph when it is placed on either side", () => {
    for (const rect of [graphRect(300, 200), graphRect(700, 200)]) {
      const placement = getGraphSettingsPanelPlacement(rect, PANEL, VIEWPORT, null);
      const overlaps =
        placement.left < rect.left + rect.width &&
        rect.left < placement.left + GRAPH_SETTINGS_PANEL_WIDTH_PX;

      expect(overlaps).toBe(false);
    }
  });

  it("shrinks the panel width rather than overflowing a very narrow viewport", () => {
    const tiny = { width: 260, height: 600 };
    const placement = getGraphSettingsPanelPlacement(graphRect(20, 20, 200, 200), PANEL, tiny, null);

    expect(placement.width).toBe(tiny.width - GRAPH_SETTINGS_PANEL_MARGIN_PX * 2);
    expect(placement.left).toBe(GRAPH_SETTINGS_PANEL_MARGIN_PX);
  });
});

describe("縮められる幅を持つパネル", () => {
  const graph = { left: 520, top: 120, width: 420, height: 300 };
  const viewport = { width: 1440, height: 960 };

  it("希望幅が横に入らないときは、覆わずに済む幅まで縮める", () => {
    const placement = getGraphSettingsPanelPlacement(
      graph,
      { width: 620, minWidth: 300, height: 520 },
      viewport,
      null,
    );

    expect(placement.side).toBe("right");
    // 右に残るのは 1440 - 8 - (940 + 12) = 480px。
    expect(placement.width).toBe(480);
    expect(placement.left).toBe(952);
    expect(placement.left + placement.width).toBeLessThanOrEqual(viewport.width - 8);
  });

  it("下限にも満たないときだけ下・重ねへ落ちる", () => {
    const wide = { left: 200, top: 120, width: 1100, height: 200 };
    const placement = getGraphSettingsPanelPlacement(
      wide,
      { width: 620, minWidth: 300, height: 300 },
      viewport,
      null,
    );

    expect(placement.side).toBe("below");
    expect(placement.width).toBe(620);
  });

  it("minWidth を渡さないパネルは今までどおり縮まない", () => {
    const placement = getGraphSettingsPanelPlacement(
      graph,
      { width: 620, height: 520 },
      viewport,
      null,
    );

    expect(placement.side).not.toBe("right");
    expect(placement.width).toBe(620);
  });
});
