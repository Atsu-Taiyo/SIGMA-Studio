import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { sampleDocument } from "@/lib/sample-document";

import { AiRunCardComposer } from "./ai-run-card-composer";

describe("AiRunCardComposer", () => {
  it("uses the sidebar composer shell, toolbar, and add button", () => {
    const html = renderToStaticMarkup(
      <AiRunCardComposer
        roomId="room-1"
        documentIdentityKey="doc-1"
        document={sampleDocument}
        anchor={{ primaryBlockId: null, blockIds: [], shapeIds: [] }}
        provider="claude"
      />,
    );

    expect(html).toContain('class="ai-chat-input-shell"');
    expect(html).toContain('class="ai-chat-toolbar"');
    expect(html).toContain('aria-label="コンテキストを追加"');
    expect(html).toContain("lucide-plus");
    expect(html).not.toContain("ai-run-card-composer-shell");
    expect(html).not.toContain("ai-run-card-composer-actions");
  });
});
