import { filterTextFlowCommandDefinitions, textFlowCommandNameMatchRank, type TextFlowCommandDefinition } from "@/features/text-editing";
import { resolveBoxStyles } from "@/lib/box-blocks";
import type { Translate } from "@/lib/i18n";
import { materialMatchesQuery } from "@/lib/materials";
import { isOfficialMaterial } from "@/lib/official-materials";
import type { MaterialItem } from "@/types/material";

export interface ActiveSlashCommandQuery {
  blockId: string;
  from: number;
  to: number;
  query: string;
  canInsertBox: boolean;
  /** いまのキャレット位置で置ける本文ブロックの id。空なら本文ブロックは出さない。 */
  availableBlockCommandIds: string[];
  rect: {
    bottom: number;
    left: number;
  };
  screenPoint: {
    x: number;
    y: number;
  };
}

export type SlashCommandCandidate =
  | { kind: "box"; box: TextFlowCommandDefinition }
  | { kind: "block"; block: TextFlowCommandDefinition }
  | { kind: "problem"; problem: TextFlowCommandDefinition }
  | { kind: "heading"; heading: TextFlowCommandDefinition & { level: 1 | 2 | 3 } }
  | { kind: "material"; material: MaterialItem };

export function getSlashCommandCandidateName(candidate: SlashCommandCandidate): string {
  if (candidate.kind === "problem") {
    return `/${candidate.problem.commandName}`;
  }
  if (candidate.kind === "block") {
    return `/${candidate.block.commandName}`;
  }
  if (candidate.kind === "heading") {
    return `/${candidate.heading.commandName}`;
  }
  return candidate.kind === "box" ? `/${candidate.box.commandName}` : `/${candidate.material.name}`;
}

const MAX_MATERIAL_CANDIDATES = 8;

const MAX_SLASH_COMMAND_CANDIDATES = 12;

const MAX_BOX_COMMAND_CANDIDATES = 6;

/**
 * `/` コマンドの一覧。**文言は毎回 `t` から解決する** (module 直下で作ると
 * 起動時の言語で焼き付き、切り替えても古い言語のまま残る)。
 */
function buildBoxCommandDefinitions(t: Translate<"editor">): TextFlowCommandDefinition[] {
  return resolveBoxStyles(t).map((style) => ({
    id: style.id,
    commandName: style.commandName,
    displayName: style.displayName,
    description: style.description,
    aliases: style.aliases,
  }));
}

/**
 * 本文ブロック (引用・コード・区切り線) の `/` コマンド。囲み枠と同じ一覧に並べる。
 *
 * `id` は**そのままブロック種別**として扱う ({@link insertBodyBlockCommandFromQuery})。
 * 打つ文字列 (`commandName`) は言語ごとに変わるので、分岐に使えるのは id だけ。
 */
const BODY_BLOCK_COMMAND_KINDS = ["quote", "codeBlock", "divider"] as const;

type BodyBlockCommandKind = (typeof BODY_BLOCK_COMMAND_KINDS)[number];

export function bodyBlockCommandId(kind: BodyBlockCommandKind): string {
  return `insert.${kind}`;
}

export function bodyBlockCommandKindFromId(id: string): BodyBlockCommandKind | null {
  return BODY_BLOCK_COMMAND_KINDS.find((kind) => bodyBlockCommandId(kind) === id) ?? null;
}

function buildBodyBlockCommandDefinitions(t: Translate<"editor">): TextFlowCommandDefinition[] {
  return BODY_BLOCK_COMMAND_KINDS.map((kind) => ({
    id: bodyBlockCommandId(kind),
    // コマンド名は打つ文字列そのもの。英語 UI では英語で打てないと使えない。
    commandName: t(`slash.block.${kind}.command` as never) as string,
    displayName: t(`slash.block.${kind}.displayName` as never) as string,
    description: t(`slash.block.${kind}.description` as never) as string,
    aliases: (t(`slash.block.${kind}.aliases` as never) as string).split(" ").filter(Boolean),
  }));
}

function buildProblemCommandDefinition(t: Translate<"editor">): TextFlowCommandDefinition {
  return {
    id: "insert.problem",
    // コマンド名は打つ文字列そのもの。英語 UI では英語で打てないと使えない。
    commandName: t("slash.problem.command"),
    displayName: t("slash.problem.displayName"),
    description: t("slash.problem.description"),
    aliases: (t("slash.problem.aliases") as string).split(" ").filter(Boolean),
  };
}

function buildHeadingCommandDefinitions(t: Translate<"editor">): Array<TextFlowCommandDefinition & { level: 1 | 2 | 3 }> {
  const headings = [
    { level: 1, key: "heading1" },
    { level: 2, key: "heading2" },
    { level: 3, key: "heading3" },
  ] as const;
  return headings.map(({ level, key }) => ({
    id: `insert.heading.${level}`,
    level,
    commandName: t(`slash.${key}.command`),
    displayName: t(`slash.${key}.displayName`),
    description: t(`slash.${key}.description`),
    aliases: (t(`slash.${key}.aliases`) as string).split(" ").filter(Boolean),
  }));
}

function filterMaterialCandidates(materials: MaterialItem[], query: string): MaterialItem[] {
  return materials
    .filter((material) => materialMatchesQuery(material, query))
    .sort((a, b) => Number(isOfficialMaterial(a)) - Number(isOfficialMaterial(b)))
    .slice(0, MAX_MATERIAL_CANDIDATES);
}

export function filterSlashCommandCandidates(
  materials: MaterialItem[],
  query: string,
  includeBoxCommands: boolean,
  t: Translate<"editor">,
  boxCommandStyleIds?: readonly string[],
  includeProblemCommand = false,
  blockCommandIds: readonly string[] = [],
  includeHeadingCommands = false,
): SlashCommandCandidate[] {
  const problemCandidates = includeProblemCommand
    ? filterTextFlowCommandDefinitions([buildProblemCommandDefinition(t)], {
        query,
        limit: 1,
      }).map((problem): SlashCommandCandidate => ({ kind: "problem", problem }))
    : [];
  const headingCandidates = includeHeadingCommands
    ? filterTextFlowCommandDefinitions(buildHeadingCommandDefinitions(t), {
        query,
        limit: 3,
      }).map((heading): SlashCommandCandidate => ({ kind: "heading", heading }))
    : [];
  const boxCandidates = includeBoxCommands
    ? filterTextFlowCommandDefinitions(buildBoxCommandDefinitions(t), {
        query,
        allowedIds: boxCommandStyleIds,
        limit: MAX_BOX_COMMAND_CANDIDATES,
      }).map((box): SlashCommandCandidate => ({ kind: "box", box }))
    : [];
  const blockCandidates = blockCommandIds.length > 0
    ? filterTextFlowCommandDefinitions(buildBodyBlockCommandDefinitions(t), {
        query,
        allowedIds: blockCommandIds,
        limit: BODY_BLOCK_COMMAND_KINDS.length,
      }).map((block): SlashCommandCandidate => ({ kind: "block", block }))
    : [];
  const materialCandidates = filterMaterialCandidates(materials, query)
    .map((material): SlashCommandCandidate => ({ kind: "material", material }));
  // 名前が前方一致した候補を先に出す。`/引用` は引用ブロックであって「引用」を別名に持つ箱
  // (leftbar) ではない、という当たり前の順番は、説明文や別名まで見る絞り込みだけでは作れない。
  const commandCandidates = [...problemCandidates, ...headingCandidates, ...blockCandidates, ...boxCandidates];
  const rankedCommands = [...commandCandidates].sort((a, b) => (
    textFlowCommandNameMatchRank(getSlashCommandCandidateName(a).slice(1), query)
    - textFlowCommandNameMatchRank(getSlashCommandCandidateName(b).slice(1), query)
  ));
  return [...rankedCommands, ...materialCandidates].slice(0, MAX_SLASH_COMMAND_CANDIDATES);
}

export function sameSlashCommandQuery(a: ActiveSlashCommandQuery | null, b: ActiveSlashCommandQuery | null): boolean {
  return a?.blockId === b?.blockId &&
    a?.from === b?.from &&
    a?.to === b?.to &&
    a?.query === b?.query &&
    a?.canInsertBox === b?.canInsertBox &&
    (a?.availableBlockCommandIds ?? []).join(" ") === (b?.availableBlockCommandIds ?? []).join(" ") &&
    a?.rect.left === b?.rect.left &&
    a?.rect.bottom === b?.rect.bottom;
}
