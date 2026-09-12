import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AiChatTextInput } from "./AiChatTextInput";

describe("AiChatTextInput", () => {
  it("provides the shared AI input class while preserving surface-specific props", () => {
    const html = renderToStaticMarkup(
      <AiChatTextInput aria-label="追加指示" className="surface-input" rows={1} placeholder="入力" />,
    );

    expect(html).toContain('class="ai-chat-input surface-input"');
    expect(html).toContain('aria-label="追加指示"');
    expect(html).toContain('placeholder="入力"');
  });

  it("does not leak the auto-grow implementation prop to the textarea", () => {
    const html = renderToStaticMarkup(<AiChatTextInput autoGrow={false} aria-label="入力" />);

    expect(html).not.toContain("autoGrow");
    expect(html).toContain('aria-label="入力"');
  });
});
