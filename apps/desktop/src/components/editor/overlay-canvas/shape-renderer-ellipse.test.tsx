import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GeoSvgBody } from "./shape-renderer";

describe("editable ellipse geometry", () => {
  it("uses the complete saved bounds for small and large circles", () => {
    for (const diameter of [4, 8, 40]) {
      const shape = { type: "geo", props: { geo: "ellipse", w: diameter, h: diameter,
        fill: "solid", fillColor: "#000000", color: "#000000" } } as Parameters<typeof GeoSvgBody>[0]["shape"];
      const markup = renderToStaticMarkup(createElement(GeoSvgBody, { shape }));
      expect(markup).toContain(`cx="${diameter / 2}"`);
      expect(markup).toContain(`rx="${diameter / 2}"`);
      expect(markup).toContain(`ry="${diameter / 2}"`);
    }
  });
});
