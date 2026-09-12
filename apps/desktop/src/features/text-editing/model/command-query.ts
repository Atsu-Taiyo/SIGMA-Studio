export interface TextFlowCommandDefinition {
  id: string;
  commandName: string;
  displayName: string;
  description: string;
  aliases: readonly string[];
}

export interface TextFlowCommandTriggerQuery {
  query: string;
  triggerLength: number;
}

export interface FilterTextFlowCommandDefinitionsOptions {
  query: string;
  allowedIds?: readonly string[];
  limit: number;
}

export function parseTextFlowCommandTrigger(
  beforeCursor: string,
): TextFlowCommandTriggerQuery | null {
  const match = beforeCursor.match(/^\s*([/／])([^\s]*)$/);
  if (!match) {
    return null;
  }

  const query = match[2] ?? "";
  return {
    query,
    triggerLength: (match[1]?.length ?? 1) + query.length,
  };
}

/**
 * 名前が前方一致していれば 0、別名や説明でしか当たっていなければ 1。
 *
 * 絞り込み ({@link filterTextFlowCommandDefinitions}) は別名や説明まで見るので、`/引用` は
 * 引用ブロックにも「引用」を別名に持つ箱 (leftbar) にも当たる。一覧に並べる順番はこの値で
 * 決める — 打った名前そのものの候補を必ず先頭にするため。種別 (箱・ブロック・素材) をまたいで
 * 比べるので、絞り込みの中ではなく外で使う。
 */
export function textFlowCommandNameMatchRank(commandName: string, query: string): number {
  const normalizedQuery = query.normalize("NFKC").trim().toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }
  return commandName.normalize("NFKC").toLowerCase().startsWith(normalizedQuery) ? 0 : 1;
}

export function filterTextFlowCommandDefinitions<T extends TextFlowCommandDefinition>(
  definitions: readonly T[],
  options: FilterTextFlowCommandDefinitionsOptions,
): T[] {
  const normalizedQuery = options.query.normalize("NFKC").trim().toLowerCase();
  const allowed = options.allowedIds ? new Set(options.allowedIds) : null;
  const candidates = definitions.filter((definition) => (
    !allowed || allowed.has(definition.id)
  ));

  if (!normalizedQuery) {
    return candidates.slice(0, options.limit);
  }

  return candidates
    .filter((candidate) => [
      candidate.commandName,
      candidate.displayName,
      candidate.description,
      ...candidate.aliases,
    ].some((value) => (
      value.normalize("NFKC").toLowerCase().includes(normalizedQuery)
    )))
    .slice(0, options.limit);
}
