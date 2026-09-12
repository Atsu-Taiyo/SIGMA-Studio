/** Explicit acknowledgement of the SigmaDoc projection installed in a source DOM. */
interface ContentRevision {
  expected?: string;
  applied?: string;
}

const revisions = new WeakMap<HTMLElement, ContentRevision>();
export const TEXT_FLOW_MEASUREMENT_READY = "sigma-text-flow-measurement-ready";

export function expectTextFlowContent(root: HTMLElement, key: string): void {
  const revision = revisions.get(root) ?? {};
  revision.expected = key;
  revisions.set(root, revision);
}

export function acknowledgeTextFlowContent(root: HTMLElement, key: string): void {
  const revision = revisions.get(root) ?? {};
  if (revision.applied === key) return;
  revision.applied = key;
  revisions.set(root, revision);
  root.dispatchEvent(new Event(TEXT_FLOW_MEASUREMENT_READY, { bubbles: true }));
}

/** No retry count can turn an old editing document into a current measurement. */
export function isTextFlowMeasurementReady(flow: HTMLElement): boolean {
  return Array.from(flow.querySelectorAll<HTMLElement>(".ProseMirror")).every((root) => {
    const revision = revisions.get(root);
    return !revision || (revision.expected !== undefined && revision.expected === revision.applied);
  });
}
