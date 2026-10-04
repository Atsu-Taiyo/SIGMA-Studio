/** Only use when assigning a new name; existing paths and stored names are opaque. */
export function spaceFreeFileName(name: string): string {
  return name.trim().replace(/\s+/gu, "-");
}

/** Keep compound SigmaDoc extensions intact when adding a collision suffix. */
export function splitFileName(name: string): { stem: string; extension: string } {
  const match = /^(.*?)(\.(?:sigma|sigmadoc)\.json|\.[^.]+)$/iu.exec(name);
  return match && match[1] ? { stem: match[1], extension: match[2] } : { stem: name, extension: "" };
}
