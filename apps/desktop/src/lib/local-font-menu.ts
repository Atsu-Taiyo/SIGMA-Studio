import type { LocalFontFace } from "./local-font-contracts";

const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\s_-]/gu, "");
const bundled = new Set(["mplus1p", "notoserifjp"]);
interface FontOption { label: string; value: string }
interface FontGroup { id: string; label: string; options: FontOption[] }

/** Keep only installed faces, preserving bundled and generic application fonts. */
export function localFontMenuGroups<T extends FontGroup>(groups: T[], fonts: LocalFontFace[] | null): (T | FontGroup)[] {
  if (fonts === null) return groups;
  const known = new Set(fonts.flatMap(font => [font.family, font.fullName, font.postscriptName]).map(normalize));
  const claimed = new Set<string>();
  const result: (T | FontGroup)[] = [];
  for (const group of groups) {
    const options = group.options.filter(option => {
      const families = option.value.split(",").map(family => family.trim().replace(/^["']|["']$/gu, ""));
      const primary = normalize(families[0] ?? "");
      const aliases = families.filter((family, index) => index === 0 || (/^HG/iu.test(family) && /^HG/iu.test(families[0] ?? "")));
      if (![...aliases].some(family => known.has(normalize(family))) && !bundled.has(primary)
        && !["-apple-system", "ui-serif", "ui-sans-serif", "ui-monospace", "monospace", "serif", "sans-serif"].includes(families[0] ?? "")) return false;
      aliases.forEach(family => claimed.add(normalize(family)));
      return true;
    });
    if (options.length) result.push({ ...group, options });
  }
  const families = [...new Set(fonts.map(font => font.family))].filter(family => !claimed.has(normalize(family)));
  if (families.length) result.push({ id: "system", label: "Fonts on this PC", options: families
    .sort((a,b) => a.localeCompare(b,"ja")).map(family => ({ label: family, value: JSON.stringify(family) })) });
  return result;
}
