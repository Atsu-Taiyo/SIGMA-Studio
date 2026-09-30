import { randomUUID } from "node:crypto";
import { parseShareLink } from "@/features/collaboration/model/share-link";

export class ShareLinkQueue {
  private requests: { id: string; url: string }[] = [];
  constructor(private readonly notify: () => void) {}
  enqueue(url: string): boolean {
    if (!parseShareLink(url)) return false;
    if (!this.requests.some(request => request.url === url)) this.requests.push({ id: randomUUID(), url });
    this.notify();
    return true;
  }
  peek() { return this.requests[0] ?? null; }
  acknowledge(id: string) {
    if (this.requests[0]?.id !== id) return;
    this.requests.shift();
    if (this.requests.length) this.notify();
  }
}
