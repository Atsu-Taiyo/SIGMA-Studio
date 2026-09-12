import { tryLock, unlock } from "fs-native-extensions";

// Descriptor-owned locks: OFD locks on Linux, flock on macOS, LockFileEx on
// Windows. A false result means contention; unsupported operations must throw.
export function tryLockFileDescriptor(fd: number): boolean {
  return tryLock(fd);
}

export function unlockFileDescriptor(fd: number): void {
  unlock(fd);
}
