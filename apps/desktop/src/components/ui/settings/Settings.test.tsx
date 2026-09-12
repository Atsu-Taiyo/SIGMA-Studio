import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SettingsField, SettingsRow, SettingsSection, SettingsStatus, Switch, Tabs } from "./index";
import { resolveTabsKeyboardIndex } from "./Tabs";

describe("settings primitives", () => {
  it("keeps section, row, and field semantics explicit", () => {
    const html = renderToStaticMarkup(
      <SettingsSection title="AI" description="接続を管理します" actions={<button>追加</button>}>
        <SettingsRow label="Web検索" description="必要な時だけ検索します" control={<span>操作</span>} />
        <SettingsField label="CLI" htmlFor="cli" meta="必須">
          <input id="cli" />
        </SettingsField>
      </SettingsSection>,
    );

    expect(html).toContain("<section");
    expect(html).toContain("接続を管理します");
    expect(html).toContain('for="cli"');
    expect(html).toContain("必要な時だけ検索します");
  });

  it("announces statuses and exposes a labelled switch", () => {
    const html = renderToStaticMarkup(
      <>
        <SettingsStatus tone="success">保存しました</SettingsStatus>
        <SettingsStatus tone="error">保存できませんでした</SettingsStatus>
        <Switch checked label="Web検索" onCheckedChange={() => {}} />
      </>,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-label="Web検索"');
  });

  it("connects the active tab and its panel", () => {
    const html = renderToStaticMarkup(
      <Tabs
        label="AIエージェント設定"
        value="claude"
        onValueChange={() => {}}
        items={[
          { value: "chatgpt", label: "ChatGPT" },
          { value: "claude", label: "Claude" },
        ]}
      >
        Claude設定
      </Tabs>,
    );

    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toMatch(/aria-controls="([^"]+)"/);
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain("Claude設定");
  });

  it("moves between enabled tabs with arrow, Home, and End keys", () => {
    const disabled = [false, true, false];

    expect(resolveTabsKeyboardIndex(disabled, 0, "ArrowRight")).toBe(2);
    expect(resolveTabsKeyboardIndex(disabled, 2, "ArrowRight")).toBe(0);
    expect(resolveTabsKeyboardIndex(disabled, 0, "ArrowLeft")).toBe(2);
    expect(resolveTabsKeyboardIndex(disabled, 2, "Home")).toBe(0);
    expect(resolveTabsKeyboardIndex(disabled, 0, "End")).toBe(2);
    expect(resolveTabsKeyboardIndex(disabled, 0, "Enter")).toBeNull();
  });
});
