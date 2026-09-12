/** Subscribe to local and cross-window changes, invalidating before notifying React. */
export function subscribeStoragePreference(
  storageKey: string,
  changeEvent: string,
  invalidate: () => void,
  onStoreChange: () => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handleChange = () => { invalidate(); onStoreChange(); };
  const handleStorage = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) handleChange();
  };
  window.addEventListener(changeEvent, handleChange);
  window.addEventListener("storage", handleStorage);
  return () => {
    window.removeEventListener(changeEvent, handleChange);
    window.removeEventListener("storage", handleStorage);
  };
}
