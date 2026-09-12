import { readFileSync } from "node:fs";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  WebMcpBridge as legacyBridge,
  WEBMCP_STATUS_EVENT as legacyStatusEvent,
  type WebMcpUiStatus as LegacyUiStatus,
} from "@/components/editor/webmcp/WebMcpBridge";
import {
  WEBMCP_HISTORY_LIMIT as legacyHistoryLimit,
  type WebMcpHistoryEntry as LegacyHistoryEntry,
} from "@/components/editor/webmcp/webmcp-history";
import { WEBMCP_HISTORY_LIMIT, type WebMcpHistoryEntry } from "./model/history";
import { WEBMCP_STATUS_EVENT, type WebMcpUiStatus } from "./model/ui-status";
import { WebMcpBridge } from "./view/WebMcpBridge";

describe("WebMCP composition boundary", () => {
  it("preserves component and contract identity through the legacy editor paths", () => {
    expect(legacyBridge).toBe(WebMcpBridge);
    expect(legacyStatusEvent).toBe(WEBMCP_STATUS_EVENT);
    expect(legacyHistoryLimit).toBe(WEBMCP_HISTORY_LIMIT);
    expectTypeOf<LegacyUiStatus>().toEqualTypeOf<WebMcpUiStatus>();
    expectTypeOf<LegacyHistoryEntry>().toEqualTypeOf<WebMcpHistoryEntry>();
  });

  it("owns WebMCP composition without reaching back through legacy editor modules", () => {
    const source = readFileSync(new URL("./view/WebMcpBridge.tsx", import.meta.url), "utf8");

    expect(source).not.toContain("@/components/editor/");
    expect(source).toContain('from "../model/history"');
    expect(source).toContain('from "../model/ui-status"');
  });

  it("lets connection status views consume the model without importing the bridge", () => {
    const source = readFileSync(new URL(
      "../../components/editor/webmcp/WebMcpDockSection.tsx",
      import.meta.url,
    ), "utf8");

    expect(source).toContain('from "@/features/webmcp/model/ui-status"');
    expect(source).not.toContain("/WebMcpBridge");
  });
});
