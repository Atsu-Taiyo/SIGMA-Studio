export interface WindowCloseHandshake {
  requestClose(): boolean;
  acknowledge(sender: unknown): boolean;
  notifyReady(sender: unknown): boolean;
  cancel(sender: unknown): boolean;
  forceFinish(): boolean;
  dispose(): void;
}

type WindowCloseState = "idle" | "pending" | "acknowledged" | "finished";

export function createWindowCloseHandshake(input: {
  sendCloseRequested: () => void;
  finishClose: () => void;
  onCancel: () => void;
  isExpectedSender: (sender: unknown) => boolean;
  timeoutMs?: number;
}): WindowCloseHandshake {
  let state: WindowCloseState = "idle";
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const clearAcknowledgementTimeout = () => {
    if (timeout !== null) clearTimeout(timeout);
    timeout = null;
  };

  const finish = () => {
    if (state === "finished") return false;
    state = "finished";
    clearAcknowledgementTimeout();
    input.finishClose();
    return true;
  };

  return {
    requestClose() {
      if (state === "finished") return false;
      if (state === "pending" || state === "acknowledged") return true;
      state = "pending";
      timeout = setTimeout(() => {
        if (state === "pending") finish();
      }, input.timeoutMs ?? 3_000);
      try {
        input.sendCloseRequested();
      } catch {
        // The acknowledgement timeout still closes an unavailable renderer.
      }
      return true;
    },
    acknowledge(sender) {
      if (state !== "pending" || !input.isExpectedSender(sender)) return false;
      state = "acknowledged";
      clearAcknowledgementTimeout();
      return true;
    },
    notifyReady(sender) {
      if ((state !== "pending" && state !== "acknowledged") || !input.isExpectedSender(sender)) {
        return false;
      }
      return finish();
    },
    cancel(sender) {
      if ((state !== "pending" && state !== "acknowledged") || !input.isExpectedSender(sender)) {
        return false;
      }
      state = "idle";
      clearAcknowledgementTimeout();
      input.onCancel();
      return true;
    },
    forceFinish() {
      if (state !== "pending" && state !== "acknowledged") return false;
      return finish();
    },
    dispose() {
      state = "finished";
      clearAcknowledgementTimeout();
    },
  };
}
