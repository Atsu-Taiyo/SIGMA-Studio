import { afterEach, describe, expect, it, vi } from "vitest";

import { createWindowCloseHandshake } from "./window-close-handshake";

afterEach(() => vi.useRealTimers());

function setup() {
  const expectedSender = {};
  const sendCloseRequested = vi.fn();
  const finishClose = vi.fn();
  const onCancel = vi.fn();
  const handshake = createWindowCloseHandshake({
    sendCloseRequested,
    finishClose,
    onCancel,
    isExpectedSender: (sender) => sender === expectedSender,
  });
  return { expectedSender, sendCloseRequested, finishClose, onCancel, handshake };
}

describe("window close handshake", () => {
  it("waits indefinitely for ready after acknowledgement", () => {
    vi.useFakeTimers();
    const { expectedSender, finishClose, handshake } = setup();
    handshake.requestClose();
    expect(handshake.acknowledge(expectedSender)).toBe(true);
    vi.advanceTimersByTime(30_000);
    expect(finishClose).not.toHaveBeenCalled();
  });

  it("closes after three seconds without an acknowledgement", () => {
    vi.useFakeTimers();
    const { finishClose, handshake } = setup();
    handshake.requestClose();
    vi.advanceTimersByTime(2_999);
    expect(finishClose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(finishClose).toHaveBeenCalledTimes(1);
  });

  it("closes when an acknowledged renderer reports ready", () => {
    const { expectedSender, sendCloseRequested, finishClose, handshake } = setup();
    expect(handshake.requestClose()).toBe(true);
    expect(handshake.requestClose()).toBe(true);
    expect(sendCloseRequested).toHaveBeenCalledTimes(1);
    expect(handshake.acknowledge(expectedSender)).toBe(true);
    expect(handshake.notifyReady(expectedSender)).toBe(true);
    expect(finishClose).toHaveBeenCalledTimes(1);
    expect(handshake.requestClose()).toBe(false);
  });

  it("returns to idle after cancel and sends the next request", () => {
    const { expectedSender, sendCloseRequested, onCancel, handshake } = setup();
    handshake.requestClose();
    handshake.acknowledge(expectedSender);
    expect(handshake.cancel(expectedSender)).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(handshake.requestClose()).toBe(true);
    expect(sendCloseRequested).toHaveBeenCalledTimes(2);
  });

  it("ignores unexpected senders", () => {
    const { expectedSender, finishClose, onCancel, handshake } = setup();
    handshake.requestClose();
    expect(handshake.acknowledge({})).toBe(false);
    expect(handshake.notifyReady({})).toBe(false);
    expect(handshake.cancel({})).toBe(false);
    expect(finishClose).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    expect(handshake.acknowledge(expectedSender)).toBe(true);
  });

  it("does not force-finish while idle and force-finishes while pending", () => {
    const { finishClose, handshake } = setup();
    expect(handshake.forceFinish()).toBe(false);
    expect(finishClose).not.toHaveBeenCalled();
    handshake.requestClose();
    expect(handshake.forceFinish()).toBe(true);
    expect(handshake.forceFinish()).toBe(false);
    expect(finishClose).toHaveBeenCalledTimes(1);
  });

  it("force-finishes an acknowledged close request", () => {
    const { expectedSender, finishClose, handshake } = setup();
    handshake.requestClose();
    handshake.acknowledge(expectedSender);

    expect(handshake.forceFinish()).toBe(true);
    expect(finishClose).toHaveBeenCalledTimes(1);
    expect(handshake.notifyReady(expectedSender)).toBe(false);
  });

  it("disposes without allowing a later timeout or renderer response", () => {
    vi.useFakeTimers();
    const { expectedSender, finishClose, handshake } = setup();
    handshake.requestClose();
    handshake.dispose();
    vi.advanceTimersByTime(3_000);
    expect(handshake.acknowledge(expectedSender)).toBe(false);
    expect(handshake.notifyReady(expectedSender)).toBe(false);
    expect(finishClose).not.toHaveBeenCalled();
  });
});
