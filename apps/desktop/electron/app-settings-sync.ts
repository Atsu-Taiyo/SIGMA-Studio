import type { SyncedPart } from "./authoring-style-sync";
import {
  isAiWebSearchEnabled, normalizeDesktopCommandShortcuts, normalizeDesktopCustomCommands,
  readDesktopSettingsSync, transactDesktopSettings, type DesktopSettings,
} from "./desktop-settings";

/**
 * The app's own settings that mean the same on every device, kept in step with the
 * account under the same switch as the writing style.
 *
 * Only what is listed here is ever sent. Left on the device on purpose:
 * the display language (each device keeps the language its user chose there; a
 * `uiLocale` that earlier versions wrote to the account is ignored and dropped),
 * paths to the AI command line tools, imported fonts and the editor font (the
 * files are on this machine), the page setup remembered from the last document
 * (it can hold images), whether verified AI proposals are applied without asking
 * (each device's user decides that), and anything to do with signing in.
 */
export const APP_SETTINGS_KEY = "app-settings";

export interface SyncedAppSettings {
  version: 1;
  kind: "app-settings";
  commandShortcuts: Record<string, unknown>;
  customCommands: { id: string }[];
  aiWebSearchEnabled: boolean;
}

export type AppSettingsChange = Pick<DesktopSettings, "commandShortcuts" | "customCommands" | "aiWebSearchEnabled">;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The same text whatever order an object's keys were written in. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
/** A value that is not there is not the same as one set to null: a shortcut set to null is one its user switched off. */
const same = (a: unknown, b: unknown) => a === undefined || b === undefined ? a === b : stable(a) === stable(b);

/**
 * One value on two devices. `agreed` is false while they have never been merged: then whatever either
 * side has is kept, and where both have something different the account's copy stands.
 */
function pick<T>(agreed: boolean, base: T | undefined, local: T | undefined, remote: T | undefined): T | undefined {
  if (same(local, remote)) return local;
  if (!agreed) return remote === undefined ? local : remote;
  return same(base, remote) ? local : remote;
}

function mergeRecord<T>(agreed: boolean, base: Record<string, T>, local: Record<string, T>, remote: Record<string, T>): Record<string, T> {
  const merged: Record<string, T> = {};
  for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const value = pick(agreed, base[key], local[key], remote[key]);
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

export function parseAppSettings(value: unknown): SyncedAppSettings | null {
  if (!isRecord(value) || value.version !== 1 || value.kind !== "app-settings") return null;
  // What arrives is read by the same checks as the settings file itself: nothing else gets through.
  // The display language stays on each device, so a `uiLocale` written by an earlier version is not read.
  return {
    version: 1, kind: "app-settings",
    commandShortcuts: normalizeDesktopCommandShortcuts(value.commandShortcuts),
    customCommands: normalizeDesktopCustomCommands(value.customCommands) as { id: string }[],
    aiWebSearchEnabled: value.aiWebSearchEnabled !== false,
  };
}

export function mergeAppSettings(base: SyncedAppSettings | null, local: SyncedAppSettings, remote: SyncedAppSettings): SyncedAppSettings {
  const agreed = base !== null;
  const byId = (list: readonly { id: string }[]) => Object.fromEntries(list.map(command => [command.id, command]));
  const commands = mergeRecord(agreed, byId(base?.customCommands ?? []), byId(local.customCommands), byId(remote.customCommands));
  // This device's order, then what another device added.
  const order = [...new Set([...local.customCommands, ...remote.customCommands].map(command => command.id))];
  return {
    version: 1, kind: "app-settings",
    commandShortcuts: mergeRecord(agreed, base?.commandShortcuts ?? {}, local.commandShortcuts, remote.commandShortcuts),
    customCommands: order.flatMap(id => commands[id] ? [commands[id]] : []),
    // Meeting for the first time, a device that has web search off keeps it off everywhere until its user says otherwise.
    aiWebSearchEnabled: agreed ? pick(true, base!.aiWebSearchEnabled, local.aiWebSearchEnabled, remote.aiWebSearchEnabled)! : local.aiWebSearchEnabled && remote.aiWebSearchEnabled,
  };
}

function comparable(settings: SyncedAppSettings): string {
  return stable([settings.commandShortcuts, [...settings.customCommands].sort((a, b) => a.id.localeCompare(b.id)), settings.aiWebSearchEnabled]);
}

export function readAppSettings(dataDir: string): SyncedAppSettings {
  return fromDesktop(readDesktopSettingsSync(dataDir));
}

function fromDesktop(settings: DesktopSettings): SyncedAppSettings {
  return {
    version: 1, kind: "app-settings",
    commandShortcuts: normalizeDesktopCommandShortcuts(settings.commandShortcuts),
    customCommands: normalizeDesktopCustomCommands(settings.customCommands) as { id: string }[],
    aiWebSearchEnabled: isAiWebSearchEnabled(settings),
  };
}

/**
 * `applied` is told which settings another device changed, after they are in the settings file:
 * the running app has to take them up (the AI's web search, the shortcuts on screen).
 */
export function appSettingsPart(dataDir: () => string, applied: (change: AppSettingsChange) => void): SyncedPart<SyncedAppSettings> {
  return {
    key: APP_SETTINGS_KEY,
    parse: parseAppSettings,
    merge: mergeAppSettings,
    comparable,
    empty: settings => !Object.keys(settings.commandShortcuts).length && !settings.customCommands.length && settings.aiWebSearchEnabled,
    // Read, merged and written in one go, in line with every other write to the settings file: a change the
    // user makes meanwhile is either read here or written after this, never lost in between.
    update: merge => transactDesktopSettings(dataDir(), async (current, write) => {
      const previous = fromDesktop(current);
      const next = merge(previous);
      const change: AppSettingsChange = {};
      if (!same(next.commandShortcuts, previous.commandShortcuts)) change.commandShortcuts = next.commandShortcuts;
      if (comparable({ ...previous, customCommands: next.customCommands }) !== comparable(previous)) change.customCommands = next.customCommands;
      if (next.aiWebSearchEnabled !== previous.aiWebSearchEnabled) change.aiWebSearchEnabled = next.aiWebSearchEnabled;
      if (Object.keys(change).length) {
        await write(change);
        applied(change);
      }
      return next;
    }),
  };
}
