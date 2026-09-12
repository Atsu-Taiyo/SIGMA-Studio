import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AiProposalActions } from "./AiProposalActions";
import { AiProposalDecisionButton } from "./AiProposalDecisionButton";

describe("AI proposal actions", () => {
  it("keeps proposal decisions on the shared icon-button hierarchy", () => {
    const html = renderToStaticMarkup(
      <>
        <AiProposalDecisionButton decision="dismiss" />
        <AiProposalDecisionButton decision="apply" />
      </>,
    );

    expect(html).toContain('data-tone="danger"');
    expect(html).toContain('data-tone="primary"');
    expect(html).toContain('data-size="sm"');
    expect(html).toContain('aria-label="破棄"');
    expect(html).toContain('aria-label="適用"');
    expect(html).toContain("lucide-check");
  });

  it("fixes the shared reading order to dismiss, continue, then apply", () => {
    const html = renderToStaticMarkup(
      <AiProposalActions
        applying={false}
        dismissReasonPlaceholder="例: 内容が意図と異なる"
        onDismiss={() => {}}
        onOpenConversation={() => {}}
        onApply={() => {}}
      />,
    );

    expect(html.indexOf('aria-label="破棄"')).toBeLessThan(html.indexOf('aria-label="続けて修正"'));
    expect(html.indexOf('aria-label="続けて修正"')).toBeLessThan(html.indexOf('aria-label="適用"'));
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('aria-modal="true"');
  });
});
