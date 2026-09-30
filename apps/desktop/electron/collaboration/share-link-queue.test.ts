import { expect, it, vi } from "vitest";
import { ShareLinkQueue } from "./share-link-queue";
it("retains cold launch links until acknowledged, deduplicates, and signals the next request", () => {
  const notify = vi.fn(); const queue = new ShareLinkQueue(notify);
  const first = "sigma-studio://share/folder/12345678-1234-4234-8234-123456789012";
  const next = first.replace("folder", "document");
  expect(queue.enqueue("https://example.test")).toBe(false);
  expect(queue.peek()).toBeNull(); expect(notify).not.toHaveBeenCalled();
  queue.enqueue(first); queue.enqueue(first); queue.enqueue(next);
  const request = queue.peek()!;
  expect(request.url).toBe(first);
  queue.acknowledge("stale"); expect(queue.peek()).toEqual(request);
  queue.acknowledge(request.id); expect(queue.peek()?.url).toBe(next);
  queue.acknowledge(queue.peek()!.id); expect(queue.peek()).toBeNull();
});
