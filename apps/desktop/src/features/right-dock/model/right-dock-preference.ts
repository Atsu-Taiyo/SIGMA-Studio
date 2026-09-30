import { clampRightDockWidth, RIGHT_DOCK_DEFAULT_WIDTH } from "./right-dock-state";

/**
 * 次回起動時に引き継ぐ好み。幅だけを引き継ぐ。開閉と開いていたページは引き継がない
 * (起動直後は教材に集中できるよう閉じておき、開けば Hub から選べる)。
 * 以前は最後に見ていた面も保存していたが、その値が残っていても読み飛ばす。
 */
export interface RightDockPreference {
  width: number;
}

const STORAGE_KEY = "sigma-studio:right-dock";

export const DEFAULT_RIGHT_DOCK_PREFERENCE: RightDockPreference = { width: RIGHT_DOCK_DEFAULT_WIDTH };

export function readRightDockPreference(storage: Pick<Storage, "getItem"> | null = safeStorage()): RightDockPreference {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) ?? "null") as Partial<RightDockPreference> | null;
    return {
      width: typeof parsed?.width === "number" ? clampRightDockWidth(parsed.width, Infinity) : DEFAULT_RIGHT_DOCK_PREFERENCE.width,
    };
  } catch {
    return DEFAULT_RIGHT_DOCK_PREFERENCE;
  }
}

export function saveRightDockPreference(
  preference: RightDockPreference,
  storage: Pick<Storage, "setItem"> | null = safeStorage(),
): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // 保存できなくても、その回の操作には影響しない。
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
