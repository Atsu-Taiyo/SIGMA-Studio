// bridge.mjs の純粋な関数の型 (アプリ側のテストが読むためのもの。実行には使わない)。

export interface BridgeProjectedEvent {
  type: "text" | "reasoning" | "tool-call" | "tool-result";
  text?: string;
  id?: string;
  name?: string;
  arguments?: string;
  isError?: boolean;
  images?: Array<{ mimeType: string; data: string }>;
}

export function projectSessionEvent(event: unknown): BridgeProjectedEvent[];
export function describeTurnEnd(events: unknown[]): { kind: string; message?: string };
export function finalResponseOf(events: unknown[]): string;
export function parseStartedSubagentId(text: unknown): string | null;

export function createSessionTreeTracker(rootSessionId: string): {
  observe(notification: unknown): void;
  isRootIdle(): boolean;
  isQuiet(): boolean;
  hasUnreadInbox(): boolean;
  isSettled(): boolean;
  usedSubagents(): boolean;
};

export function createSubagentResultHold(subagentToolName: string | null): {
  filter(projected: BridgeProjectedEvent): BridgeProjectedEvent[];
  release(notification: unknown): BridgeProjectedEvent[];
};
