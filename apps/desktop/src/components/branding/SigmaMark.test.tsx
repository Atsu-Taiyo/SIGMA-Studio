import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SIGMA_MARK_PATH, SigmaMark } from "./SigmaMark";

describe("SigmaMark", () => {
  it("draws the same Σ as the app icon source", () => {
    const iconSvg = readFileSync(new URL("../../../build/icon.svg", import.meta.url), "utf8");

    expect(iconSvg).toContain(`d="${SIGMA_MARK_PATH}"`);
  });

  it("stays decorative and takes its size from the prop", () => {
    const html = renderToStaticMarkup(<SigmaMark size={40} />);

    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("width:40px");
    expect(html).toContain("height:40px");
    expect(html).toContain(SIGMA_MARK_PATH);
  });
});
