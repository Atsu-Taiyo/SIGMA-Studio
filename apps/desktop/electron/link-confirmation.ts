import { randomUUID } from "node:crypto";
import { inspectLink, type LinkConfirmationRequest, type LinkDestination } from "@/lib/link-confirmation";

/** One immutable request at a time. A page cannot replace a destination while it is being reviewed. */
export class LinkConfirmation {
  private current: { request: LinkConfirmationRequest; finish(approved: boolean): void } | null = null;

  constructor(private readonly changed: () => void) {}

  pending(): LinkConfirmationRequest | null { return this.current?.request ?? null; }

  confirm(url: string, destination: LinkDestination, signal?: AbortSignal): Promise<boolean> {
    const details = inspectLink(url, destination);
    if (!details || this.current || signal?.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
      const request = { ...details, id: randomUUID() };
      const abort = () => this.respond(request.id, false);
      this.current = { request, finish: approved => {
        signal?.removeEventListener("abort", abort);
        resolve(approved);
      } };
      signal?.addEventListener("abort", abort, { once: true });
      this.changed();
    });
  }

  respond(id: string, approved: boolean): void {
    if (!this.current || this.current.request.id !== id) return;
    const previous = this.current;
    this.current = null;
    previous.finish(approved === true);
    this.changed();
  }

  cancel(): void { if (this.current) this.respond(this.current.request.id, false); }
}
