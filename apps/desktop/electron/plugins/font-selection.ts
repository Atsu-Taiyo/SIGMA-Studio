export interface LocalFontFace {
  family: string;
  fullName: string;
  postscriptName: string;
  style: string;
}

/** 表記ゆれ (全角半角・空白・日本語の字体名) を吸収して、書体名どうしを比べられる形にする。 */
export const normalizedFamily = (value: unknown): string => String(value).normalize("NFKC").toLowerCase().replace(/[\s_-]/gu, "")
  .replace(/明朝/gu, "mincho").replace(/創英/gu, "soei").replace(/角/gu, "kaku")
  .replace(/行書体/gu, "gyoshotai").replace(/正楷書体/gu, "seikaishotai")
  .replace(/丸/gu, "maru").replace(/ゴシック/gu, "gothic").replace(/ポップ体/gu, "poptai");

const MAX_FAMILIES = 16;
const MAX_FACES = 32;

/**
 * 変換が必要とする書体名から、このPCにある実体の書体を選ぶ。無い書体は近い系統の書体で代える。
 * 拡張機能が自分で同梱している書体 (`bundled`) は、このPCから読まない。
 */
export function selectLocalFontFaces(faces: LocalFontFace[], families: string[], bundled: ReadonlySet<string> = new Set()): LocalFontFace[] {
  const groups = new Map<string, LocalFontFace[]>();
  for (const face of faces) {
    const rows = groups.get(face.family) ?? [];
    rows.push(face);
    groups.set(face.family, rows);
  }
  const bundledNames = new Set([...bundled].map(normalizedFamily));
  const wanted = new Set<string>();
  const find = (family: string): string | undefined => [...groups.keys()].find((name) => normalizedFamily(name) === normalizedFamily(family))
    ?? faces.find((face) => [face.fullName, face.postscriptName].some((name) => normalizedFamily(name) === normalizedFamily(family)))?.family;
  for (const family of families) {
    if (bundledNames.has(normalizedFamily(family))) continue;
    const exact = find(family);
    if (exact) {
      wanted.add(exact);
      continue;
    }
    const candidates = /maru|丸/i.test(family)
      ? ["Hiragino Maru Gothic ProN", "Yu Gothic", "Meiryo", "Hiragino Sans"]
      : /mincho|明朝|serif|times|roman/i.test(family)
        ? ["MS Mincho", "Yu Mincho", "Hiragino Mincho ProN", "Noto Serif CJK JP", "Times New Roman"]
        : ["Yu Gothic", "Meiryo", "Hiragino Sans", "Noto Sans CJK JP", "Arial"];
    const fallback = candidates.map(find).find(Boolean);
    if (fallback) wanted.add(fallback);
  }
  const selected = new Map<string, LocalFontFace>();
  for (const family of [...wanted].slice(0, MAX_FAMILIES)) {
    const rows = groups.get(family) as LocalFontFace[];
    for (const [bold, italic] of [[false, false], [true, false], [false, true], [true, true]] as const) {
      const score = (face: LocalFontFace): number => {
        const weight = /w([0-9])/i.exec(face.style);
        return Number(bold !== /bold|heavy|black|w[6-9]/i.test(face.style)) * 10
          + Number(italic !== /italic|oblique/i.test(face.style)) * 10
          + (weight ? Math.abs(Number(weight[1]) - (bold ? 6 : 3)) / 10 : 0);
      };
      const face = [...rows].sort((a, b) => score(a) - score(b) || a.postscriptName.localeCompare(b.postscriptName))[0];
      selected.set(face.postscriptName, face);
    }
  }
  return [...selected.values()].slice(0, MAX_FACES);
}
