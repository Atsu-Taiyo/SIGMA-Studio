export type AiDisplayMode = "inline" | "sidebar";

export interface AiSurfaceState {
  displayMode: AiDisplayMode;
  aiSidebarOpen: boolean;
  aiInlineOpen: boolean;
}

export interface AiSurfaceResolution {
  hostVisible: boolean;
  hostClassName: "ai-chat-host--inline" | "ai-chat-host--sidebar";
  gridHasAiColumn: boolean;
  catcherVisible: boolean;
}

export function resolveAiSurface(state: AiSurfaceState): AiSurfaceResolution {
  const isInline = state.displayMode === "inline";
  const hostVisible = isInline ? state.aiInlineOpen : state.aiSidebarOpen;
  return {
    hostVisible,
    hostClassName: isInline ? "ai-chat-host--inline" : "ai-chat-host--sidebar",
    // The grid only reserves a column for the docked sidebar. The inline editor is a
    // fixed overlay anchored to the selection, so the body width never changes.
    gridHasAiColumn: !isInline && state.aiSidebarOpen,
    // A transparent click-catcher (no dim) backs the inline editor so a click away
    // dismisses it without the heavy dialog feel.
    catcherVisible: isInline && state.aiInlineOpen,
  };
}

export function openInline(): AiSurfaceState {
  return { displayMode: "inline", aiSidebarOpen: false, aiInlineOpen: true };
}

export function promoteToSidebar(): AiSurfaceState {
  return { displayMode: "sidebar", aiSidebarOpen: true, aiInlineOpen: false };
}

export function closeSurface(): AiSurfaceState {
  return { displayMode: "inline", aiSidebarOpen: false, aiInlineOpen: false };
}

export function toggleSurface(state: AiSurfaceState): AiSurfaceState {
  if (state.aiInlineOpen || state.aiSidebarOpen) {
    return closeSurface();
  }
  return openInline();
}

export function isInlineToggleShortcut(event: KeyboardEvent): boolean {
  if (event.isComposing) return false;
  if (event.altKey || event.shiftKey) return false;
  if (!(event.metaKey || event.ctrlKey)) return false;
  return event.key === "k" || event.key === "K";
}

interface CancellableTurn {
  role: string;
  isRunning?: boolean;
  endedAt?: number | null;
  error?: string | null;
}

export function cancelRunningTurns<T extends CancellableTurn>(
  turns: T[],
  endedAt: number,
  message: string,
): T[] {
  if (!turns.some((turn) => turn.role === "assistant" && turn.isRunning)) {
    return turns;
  }
  return turns.map((turn) =>
    turn.role === "assistant" && turn.isRunning
      ? { ...turn, isRunning: false, endedAt, error: message }
      : turn,
  );
}
