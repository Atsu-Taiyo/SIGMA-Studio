import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { getModuleSpecifiers } from "../../../../tests/helpers/source-dependencies";

describe("AI host composition boundary", () => {
  it.each(["AiEditorHost.tsx", "use-ai-inline-drag.ts"])("%s owns presentation without shell, provider or proposal state", (file) => {
    const dependencies = getModuleSpecifiers(readFileSync(new URL(file, import.meta.url), "utf8"));
    expect(dependencies.filter((name) => /(?:EditorShell|AiEditPanel)$/.test(name)
      || name.includes("ai-run-") || name.includes("ai-edit-client")
      || name.includes("proposal") || name.includes("runtime"))).toEqual([]);
  });
});
