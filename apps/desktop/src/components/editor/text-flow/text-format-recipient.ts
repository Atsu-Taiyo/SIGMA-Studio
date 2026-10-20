/** Resolve once per event: a command must not move focus and then run again in a replica. */
export interface TextFormatCandidate<T> {
  editor: T;
  focused: boolean;
  replica: boolean;
  ownsSelectedBlock: boolean;
}

const recipients = new WeakMap<Event, unknown>();

export function resolveTextFormatRecipient<T>(event: Event, candidates: readonly TextFormatCandidate<T>[], waitForFocusedCandidate = false): T | null {
  if (!recipients.has(event)) {
    const focused = candidates.find(candidate => candidate.focused);
    if (!focused && waitForFocusedCandidate) return null;
    const recipient = focused ?? candidates.find(candidate => !candidate.replica && candidate.ownsSelectedBlock);
    // A standalone running-region listener may be visited after the body listeners.
    if (recipient) recipients.set(event, recipient.editor);
  }
  return (recipients.get(event) ?? null) as T | null;
}
