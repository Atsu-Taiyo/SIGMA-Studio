import { normalizePhysicsTex } from "@/lib/physics-tex";

interface PhysicsField {
  value?: string;
  setValue?: (value: string, ...options: unknown[]) => unknown;
  insert?: (value: string, ...options: unknown[]) => unknown;
}
interface InstalledField { overrides?: ReadonlySet<string> }
const installed = new WeakMap<object, InstalledField>();

/**
 * Normalize complete TeX at MathLive's public input boundaries. Do not rewrite
 * the live value on input events: doing so would move the caret and break IME.
 * Reconfiguration updates the document's overrides without stacking wrappers.
 */
export function installMathLivePhysics(field: object, overrides?: ReadonlySet<string>): void {
  const previous = installed.get(field);
  if (previous) {
    previous.overrides = overrides;
    return;
  }
  const state: InstalledField = { overrides };
  installed.set(field, state);
  const target = field as PhysicsField;
  for (const name of ["setValue", "insert"] as const) {
    const original = target[name];
    if (typeof original !== "function") continue;
    target[name] = function (value: string, ...options: unknown[]) {
      return original.call(this, typeof value === "string" ? normalizePhysicsTex(value, state.overrides) : value, ...options);
    };
  }
  // MathfieldElement.value calls setValue, but keep the setter boundary explicit
  // for alternate field adapters. Preserve the original getter and flags.
  let owner: object | null = field;
  let descriptor: PropertyDescriptor | undefined;
  while (owner && !descriptor) {
    descriptor = Object.getOwnPropertyDescriptor(owner, "value");
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  if (!descriptor?.set || descriptor.configurable === false) return;
  const setter = descriptor.set;
  Object.defineProperty(field, "value", {
    configurable: true,
    enumerable: descriptor.enumerable,
    get: descriptor.get,
    set(value: string) {
      setter.call(this, typeof value === "string" ? normalizePhysicsTex(value, state.overrides) : value);
    },
  });
}
