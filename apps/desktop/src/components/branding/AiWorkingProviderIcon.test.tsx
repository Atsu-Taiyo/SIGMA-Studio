import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AiWorkingProviderIcon } from "@/components/branding/AiWorkingProviderIcon";

describe("AiWorkingProviderIcon", () => {
  it("renders the shared shimmering provider mark", () => {
    const html = renderToStaticMarkup(
      <AiWorkingProviderIcon provider="claude" className="test-icon" />,
    );

    expect(html).toContain("ui-shimmer-icon");
    expect(html).toContain("ai-working-provider-icon");
    expect(html).toContain("test-icon");
    expect(html).toContain("width:16px");
  });
});
