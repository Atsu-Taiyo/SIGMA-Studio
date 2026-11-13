import { safeStorage } from "electron";

export interface SecureCacheCodec {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

function requireEncryption(): void {
  if (!safeStorage.isEncryptionAvailable() || (process.platform === "linux"
    && (!safeStorage.getSelectedStorageBackend || ["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend())))) {
    throw new Error("SECURE_STORAGE_UNAVAILABLE");
  }
}

/** Never fall back to plaintext for a cached authorization decision. */
export const secureCacheCodec: SecureCacheCodec = {
  encrypt(value) { requireEncryption(); return safeStorage.encryptString(value).toString("base64"); },
  decrypt(value) { requireEncryption(); return safeStorage.decryptString(Buffer.from(value, "base64")); },
};
