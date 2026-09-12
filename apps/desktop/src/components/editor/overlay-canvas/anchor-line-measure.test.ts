// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { measureElementLineBoxes } from "./anchor";

afterEach(() => vi.restoreAllMocks());

const rect = (top: number, height: number) => new DOMRect(10, top, 180, height);

describe("container line measurement", () => {
  for (const html of [
    "<blockquote><p>first<br>second<br>third</p></blockquote>",
    "<ol><li><p>first<br>second<br>third</p></li></ol>",
  ]) {
    it(`keeps visual lines separate inside ${html.split(">")[0].slice(1)}`, () => {
      const host = document.createElement("div");
      host.innerHTML = html;
      const glyphs = [rect(2, 16), rect(26, 16), rect(50, 16)];
      // Browser ranges over block containers include both their children's
      // bounding boxes and the glyph boxes. Over the paragraph itself, they
      // contain only inline boxes (including the taller math atom on line 2).
      const math = new DOMRect(50, 22, 25, 24);
      vi.spyOn(document, "createRange").mockImplementation(() => {
        let selected: Node;
        return {
          selectNodeContents: (node: Node) => { selected = node; },
          getClientRects: () => selected instanceof Element && selected.tagName === "P"
            ? [...glyphs, math]
            : [rect(0, 70), ...glyphs, math],
          detach: () => {},
        } as unknown as Range;
      });
      const lines = measureElementLineBoxes(host.firstElementChild!, { top: 0, left: 0 }, 1, 1);
      expect(lines.map(({ top, height }) => ({ top, height }))).toEqual([
        { top: 2, height: 16 }, { top: 22, height: 24 }, { top: 50, height: 16 },
      ]);
    });
  }
});
