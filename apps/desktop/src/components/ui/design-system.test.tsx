import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChartColumn, ChartLine } from "lucide-react";

import { Button, IconButton } from "./Button";
import { ChoiceGroup } from "./ChoiceGroup";
import { Disclosure } from "./Disclosure";
import { ModalBody, ModalFrame, ModalHeader } from "./Modal";

describe("design system controls", () => {
  it("keeps button hierarchy and marks circular icon controls in the markup", () => {
    const html = renderToStaticMarkup(
      <>
        <Button tone="primary">保存</Button>
        <IconButton label="削除" tone="danger">×</IconButton>
        <IconButton label="元に戻す" tooltip={{ label: "直前の操作を戻す", shortcut: "⌘Z" }}>↶</IconButton>
      </>,
    );

    expect(html).toContain('data-tone="primary"');
    expect(html).toContain('data-tone="danger"');
    expect(html).toContain('data-icon-only="true"');
    expect(html).toContain('aria-label="削除"');
    expect(html).toContain('data-tooltip-trigger=""');
    expect(html).toContain('aria-label="元に戻す"');
  });

  it("marks an exclusive icon choice as a radiogroup and flags its selection in the markup", () => {
    const html = renderToStaticMarkup(
      <ChoiceGroup
        aria-label="種類"
        onChange={() => {}}
        options={[
          { value: "bar", label: "棒グラフ", icon: ChartColumn },
          { value: "line", label: "折れ線グラフ", icon: ChartLine },
        ]}
        value="line"
      />,
    );

    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('role="radio"');
    expect(html).toContain('data-selected="true"');
    expect(html).toContain('aria-checked="true"');
    // The label travels with the icon, so the choice is not an unnamed pictogram.
    expect(html).toContain("折れ線グラフ");
  });

  it("defers portalled dialogs during SSR and keeps embedded content renderable", () => {
    const portalHtml = renderToStaticMarkup(
      <ModalFrame open onDismiss={() => {}} ariaLabel="設定">
        <ModalHeader title="設定" onClose={() => {}} />
        <ModalBody>内容</ModalBody>
      </ModalFrame>,
    );
    const embeddedHtml = renderToStaticMarkup(
      <ModalFrame open embedded onDismiss={() => {}} ariaLabel="設定">
        <ModalBody>
          <Disclosure label="詳細設定" defaultOpen>内容</Disclosure>
        </ModalBody>
      </ModalFrame>,
    );

    expect(portalHtml).toBe("");
    expect(embeddedHtml).not.toContain('role="dialog"');
    expect(embeddedHtml).toContain('aria-expanded="true"');
    expect(embeddedHtml).toContain("内容");
  });
});
