/** Normalize new names; printable spaces and hyphens remain, existing names stay opaque. */
export function normalizeNewFileName(name: string): string {
  return name.trim().replace(/[\t\n\r\v\f]+/gu, "-");
}

/** Keep compound SigmaDoc extensions intact when adding a collision suffix. */
export function splitFileName(name: string): { stem: string; extension: string } {
  const match = /^(.*?)(\.(?:sigma|sigmadoc)\.json|\.[^.]+)$/iu.exec(name);
  return match && match[1] ? { stem: match[1], extension: match[2] } : { stem: name, extension: "" };
}
