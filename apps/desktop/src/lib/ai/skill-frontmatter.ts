// SKILL.md フロントマターの parse/compose を一元化する共有モジュール。
// - electron/ai-resource-store.ts (グローバルskillスキャンのname/description読み取り)
// - AiSettingsDialog のスキル編集ビュー (「説明」「内容」2フィールドとfrontmatterの相互変換)
// の双方が使う。UI側はfrontmatterをユーザーに見せないが、Codex/Claude/Antigravityのskill探索が読む
// name/description は維持し、name/description 以外の既存キーは round-trip で保持する。

export interface SkillFrontmatterFields {
  name?: string;
  description?: string;
}

/** スキル本文(content)の最大文字数。AiSettingsDialog の textarea maxLength と
 * electron/ai-skill-draft.ts (AI下書き生成の出力サニタイズ) の両方が参照する唯一の定義。 */
export const SKILL_CONTENT_MAX_LENGTH = 12_000;

export interface ParsedSkillFile extends SkillFrontmatterFields {
  /** frontmatterフェンスを除いた本文(フェンス直後の空行1つも除去)。frontmatterが無ければ全文。 */
  body: string;
  /** name/description 以外のfrontmatter行(verbatim・順序維持)。composeSkillFileで書き戻す。 */
  extraFrontmatterLines: string[];
}

/**
 * frontmatterからname/descriptionを読む。単一行スカラーに加え、公式skillでも使われる
 * `description: >-` / `|` 形式のblock scalarを意味値へ畳み込む。
 * 閉じフェンスが無い場合は全体を無効として空を返す。
 */
export function parseSkillFrontmatter(raw: string): SkillFrontmatterFields {
  const lines = raw.split(/\r?\n/);
  const closeIndex = findFrontmatterCloseIndex(lines);
  if (closeIndex < 0) {
    return {};
  }
  const result: SkillFrontmatterFields = {};
  for (let i = 1; i < closeIndex; i += 1) {
    const line = lines[i];
    // Indented lines are nested values, not top-level keys.
    if (/^\s/.test(line)) {
      continue;
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1];
    if (key !== "name" && key !== "description") {
      continue;
    }
    const parsed = parseFrontmatterValue(lines, i, closeIndex, match[2].trim());
    if (parsed.value) {
      result[key] = parsed.value;
    }
    i = parsed.endIndex;
  }
  return result;
}

/**
 * SKILL.md を { name, description, body, その他のfrontmatter行 } に分解する。
 * name/description のキー行(および直後のインデント継続行=その値)は取り除かれ、
 * composeSkillFile が常に書き直す。それ以外の行は verbatim に保持する。
 */
export function parseSkillFile(raw: string): ParsedSkillFile {
  const lines = raw.split(/\r?\n/);
  const closeIndex = findFrontmatterCloseIndex(lines);
  if (closeIndex < 0) {
    return { body: raw, extraFrontmatterLines: [] };
  }
  const fields: SkillFrontmatterFields = {};
  const extraFrontmatterLines: string[] = [];
  for (let i = 1; i < closeIndex; i += 1) {
    const line = lines[i];
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    const key = match?.[1];
    if (match && (key === "name" || key === "description")) {
      const parsed = parseFrontmatterValue(lines, i, closeIndex, match[2].trim());
      if (parsed.value) {
        fields[key] = parsed.value;
      }
      // このキーの値はcomposeSkillFileが置き換えるため、キー行に続くインデント行
      // (block scalar本体・複数行スカラーの継続)ごと捨てる。
      i = parsed.endIndex;
      while (i + 1 < closeIndex && /^\s/.test(lines[i + 1])) {
        i += 1;
      }
      continue;
    }
    extraFrontmatterLines.push(line);
  }
  let bodyStart = closeIndex + 1;
  if (lines[bodyStart] === "") {
    bodyStart += 1;
  }
  return { ...fields, body: lines.slice(bodyStart).join("\n"), extraFrontmatterLines };
}

/**
 * name/description/本文(+保持しているその他frontmatter行)からSKILL.mdを組み立てる。
 * descriptionは「図の配色: 白黒」のような ": " 入りでもYAMLが壊れないよう、常に
 * double-quoted(JSON.stringify=YAMLのdouble-quotedスタイルと互換)でエスケープする。
 */
export function composeSkillFile(input: {
  name: string;
  description: string;
  body: string;
  extraFrontmatterLines?: string[];
}): string {
  const description = input.description.replace(/[\r\n]+/g, " ").trim();
  return [
    "---",
    `name: ${input.name}`,
    `description: ${JSON.stringify(description)}`,
    ...(input.extraFrontmatterLines ?? []),
    "---",
    "",
    input.body,
  ].join("\n");
}

/** manifestの sourcePath (`skills/<slug>/SKILL.md`) からスキルの内部slugを導出する。 */
export function skillSlugFromSourcePath(sourcePath: string): string | null {
  const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(sourcePath);
  return match ? match[1] : null;
}

function findFrontmatterCloseIndex(lines: string[]): number {
  if (lines[0]?.trim() !== "---") {
    return -1;
  }
  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === "---" || trimmed === "...") {
      return i;
    }
  }
  return -1;
}

function isBlockScalarIndicator(value: string): boolean {
  return /^[|>][0-9]*[+-]?$/.test(value);
}

function parseFrontmatterValue(
  lines: string[],
  keyIndex: number,
  closeIndex: number,
  rawValue: string,
): { value?: string; endIndex: number } {
  const value = unquoteFrontmatterScalar(rawValue);
  if (!isBlockScalarIndicator(value)) {
    return { value: value || undefined, endIndex: keyIndex };
  }

  const blockLines: string[] = [];
  let endIndex = keyIndex;
  for (let i = keyIndex + 1; i < closeIndex; i += 1) {
    const line = lines[i];
    if (line !== "" && !/^\s/.test(line)) {
      break;
    }
    blockLines.push(line);
    endIndex = i;
  }
  const nonEmptyLines = blockLines.filter((line) => line.trim() !== "");
  if (nonEmptyLines.length === 0) {
    return { endIndex };
  }
  const explicitIndent = /\d+/.exec(value.slice(1))?.[0];
  const indent = explicitIndent
    ? Number.parseInt(explicitIndent, 10)
    : Math.min(...nonEmptyLines.map((line) => /^\s*/.exec(line)?.[0].length ?? 0));
  const deindented = blockLines.map((line) => line.slice(Math.min(indent, line.length)));
  const blockValue = value.startsWith(">")
    ? foldBlockScalarLines(deindented)
    : deindented.join("\n");
  return { value: blockValue.trimEnd() || undefined, endIndex };
}

function foldBlockScalarLines(lines: string[]): string {
  let result = "";
  for (let i = 0; i < lines.length; i += 1) {
    if (i > 0) {
      result += lines[i - 1] === "" || lines[i] === "" ? "\n" : " ";
    }
    result += lines[i];
  }
  return result;
}

function unquoteFrontmatterScalar(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if (first === '"' && last === '"') {
      // composeSkillFileがJSON.stringifyで書いた値はJSON.parseで正確に復元できる
      // (YAML double-quotedはJSON互換)。手書き等でparse不能なら外側だけ剥がす。
      try {
        const parsed = JSON.parse(value) as unknown;
        if (typeof parsed === "string") {
          return parsed;
        }
      } catch {
        // fall through
      }
      return value.slice(1, -1);
    }
    if (first === "'" && last === "'") {
      return value.slice(1, -1);
    }
  }
  return value;
}
