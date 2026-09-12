import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("TextFlowEditor locale placeholder", () => {
  it("does not recreate useEditor when the placeholder string changes", () => {
    const source = readFileSync(fileURLToPath(new URL("./TextFlowEditor.tsx", import.meta.url)), "utf8");
    expect(source).toMatch(/placeholderRef\.current = placeholder \?\? t\("body\.placeholder"\)/);
    expect(source).toMatch(/Placeholder\.configure\(\{\s*placeholder: \(\) => placeholderRef\.current \}\)/);
    expect(source).toMatch(/getPlaceholder: \(\) => showPlaceholder \? placeholderRef\.current : ""/);
    expect(source).toMatch(/readMountedEditorDom/);
    expect(source).not.toMatch(/resolvedPlaceholder/);
    expect(source).toMatch(
      /\[mathEnvironment, mathFractionSizing, readOnlyBoxTitle, showPlaceholder, singleBlock\]/,
    );
  });
});
