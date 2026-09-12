import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AiAppliedChangeCard } from "./AiAppliedChangeCard";

describe("AiAppliedChangeCard", () => {
  it("shows exact-diff content and a safe rollback action without provider branding", () => {
    const html = renderToStaticMarkup(
      <AiAppliedChangeCard
        canRevert
        onRevert={() => {}}
      >
        <div aria-label="実際の差分">+3行</div>
      </AiAppliedChangeCard>,
    );

    expect(html).not.toContain("Claude");
    expect(html).toContain('aria-label="実際の差分"');
    expect(html).toContain("+3行");
    expect(html).toContain('aria-label="適用を元に戻す"');
    expect(html).toContain("元に戻す");
    expect(html).not.toContain("disabled");
  });

  it("keeps the rollback action visible but disabled, with the reason readable, when it cannot run", () => {
    const html = renderToStaticMarkup(
      <AiAppliedChangeCard
        canRevert={false}
        revertBlockedReason="この適用には取り消しに必要な情報が記録されていないため、元に戻せません"
        onRevert={() => {}}
      >
        <span>+1行</span>
      </AiAppliedChangeCard>,
    );

    expect(html).toContain('data-can-revert="false"');
    expect(html).toContain('aria-label="適用を元に戻す"');
    expect(html).toContain("disabled");
    expect(html).toContain("この適用には取り消しに必要な情報が記録されていないため、元に戻せません");
  });

  it("keeps the action disabled while a rollback is in flight, without showing a blocked reason", () => {
    const html = renderToStaticMarkup(
      <AiAppliedChangeCard
        canRevert
        reverting
        revertBlockedReason="この適用は元に戻せません"
        onRevert={() => {}}
      >
        <span>+1行</span>
      </AiAppliedChangeCard>,
    );

    expect(html).toContain('data-can-revert="true"');
    expect(html).toContain("disabled");
    expect(html).not.toContain("この適用は元に戻せません");
  });

  it("omits the rollback action entirely when the surface has no revert handler", () => {
    const html = renderToStaticMarkup(
      <AiAppliedChangeCard canRevert={false}>
        <span>+1行</span>
      </AiAppliedChangeCard>,
    );

    expect(html).not.toContain('aria-label="適用を元に戻す"');
  });
});
