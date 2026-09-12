// The upstream package has no TypeScript declarations. Keep this boundary limited
// to the descriptor-owned advisory locking API used by the desktop store.
declare module "fs-native-extensions" {
  export function tryLock(fd: number): boolean;
  export function unlock(fd: number): void;
}
