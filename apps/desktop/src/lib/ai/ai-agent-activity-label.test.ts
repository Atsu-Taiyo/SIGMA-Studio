import { describe, expect, it } from "vitest";

import { formatAgentActivityLabel, summarizeRunningActivity } from "@/lib/ai/ai-agent-activity-label";

describe("formatAgentActivityLabel", () => {
  it("maps draft tool names to human-readable labels", () => {
    expect(formatAgentActivityLabel({
      kind: "tool",
      phase: "streaming",
      message: "draft_insert_shape: shape を追加しました。",
    })).toBe("図形を追加しています");
  });

  it("maps the page-layout tool to a user-facing label", () => {
    expect(formatAgentActivityLabel({
      kind: "tool",
      phase: "streaming",
      message: "update_page_layout: ページ設定を変更しました。",
    })).toBe("ページ設定を変更");
  });

  it("strips block ids from technical messages", () => {
    expect(formatAgentActivityLabel({
      kind: "tool",
      phase: "streaming",
      message: "draft_insert_body_content: block-id abc-123-def を更新しました。",
    })).toBe("本文を編集しています");
  });

  it("maps the column-layout MCP tool to a readable label", () => {
    expect(formatAgentActivityLabel({
      kind: "tool",
      phase: "streaming",
      message: "update_column_layout: 2段組みに変更しました。",
    })).toBe("段組みを変更しています");
  });

  it("keeps activity labels from the runtime", () => {
    expect(formatAgentActivityLabel({
      kind: "activity",
      phase: "thinking",
      message: "考えています…",
    })).toBe("考えています…");
  });
});

describe("summarizeRunningActivity", () => {
  it("uses the latest non-stream event", () => {
    expect(summarizeRunningActivity([
      { kind: "phase", phase: "preparing", message: "準備中..." },
      { kind: "tool", phase: "streaming", message: "draft_insert_graph: ok" },
      { kind: "stream", phase: "streaming", message: "..." },
    ])).toBe("グラフを追加しています");
  });
});
