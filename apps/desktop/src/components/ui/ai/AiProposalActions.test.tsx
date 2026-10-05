import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AiProposalActions, placeDismissReasonPopover } from "./AiProposalActions";
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

describe("placeDismissReasonPopover", () => {
  const viewport = { width: 1000, height: 800 };
  const popover = { width: 240, height: 150 };

  it("opens below the dismiss button, right-aligned to it", () => {
    expect(placeDismissReasonPopover({ top: 100, bottom: 128, right: 600 }, popover, viewport))
      .toEqual({ top: 136, left: 360 });
  });

  it("flips above the button when there is no room below", () => {
    expect(placeDismissReasonPopover({ top: 700, bottom: 728, right: 600 }, popover, viewport))
      .toEqual({ top: 542, left: 360 });
  });

  it("stays inside the viewport when neither side fits whole, and near the left edge", () => {
    const tall = { width: 240, height: 760 };
    expect(placeDismissReasonPopover({ top: 300, bottom: 328, right: 100 }, tall, viewport))
      .toEqual({ top: 32, left: 8 });
  });
});
