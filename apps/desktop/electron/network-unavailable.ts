/** Only transport failures qualify for offline access; protocol/authentication failures do not. */
export class NetworkUnavailableError extends Error {}

export function isNetworkUnavailable(error: unknown): boolean {
  return error instanceof NetworkUnavailableError;
}

/** Call at the fetch boundary, so a TypeError in response validation never becomes an offline grant. */
export function transportFailure(error: unknown): never {
  if (error instanceof TypeError || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))) {
    throw new NetworkUnavailableError("NETWORK_UNAVAILABLE");
  }
  throw error;
}
