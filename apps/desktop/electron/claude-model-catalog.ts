import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Claude Code が自分で更新している「使えるモデルの一覧」を読む。
 *
 * Claude Code にはモデル一覧を返す RPC も CLI コマンドも無い。一方でアカウントごとの一覧
 * (最新の Sonnet / Opus / Fable / Haiku と旧版) をサーバーから取得して
 * `~/.claude/cache/model-catalog/` に置いている。アプリ側にモデル名を固定で持つと、
 * 新しいモデルが出るたびに表示が古くなる (Sonnet 5 のまま 5.5 が出ていた) ので、
 * このキャッシュを唯一の出典にする。形式は Claude Code の内部実装なので、読めない・
 * 想定外の形なら `null` を返し、呼び出し側が `--help` の別名だけに縮退する。
 */

export interface ClaudeCatalogModel {
  /** 完全なモデルID (例: claude-sonnet-5-5)。 */
  id: string;
  /** 表示名 (例: Sonnet 5.5)。 */
  name: string;
  /** ファミリー名 (例: Sonnet)。`--model` の別名は小文字のこれ。 */
  family: string;
  description?: string;
  /** main は今のラインナップ、overflow は旧版。 */
  section: "main" | "overflow";
  minClaudeCodeVersion?: string;
  /** 空なら推論強度を持たないモデル (Haiku など)。 */
  efforts: string[];
  defaultEffort?: string;
}

export interface ClaudeModelCatalogSnapshot {
  models: ClaudeCatalogModel[];
  fetchedAt: number;
}

export interface ClaudeModelOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts: Array<{ id: string }>;
}

export function defaultClaudeModelCatalogDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".claude", "cache", "model-catalog");
}

export function parseClaudeModelCatalog(raw: unknown): ClaudeModelCatalogSnapshot | null {
  const file = asRecord(raw);
  const config = asRecord(asRecord(file?.catalog)?.config);
  const entries = config?.models;
  if (!file || !Array.isArray(entries)) return null;
  const models = entries.flatMap((entry): ClaudeCatalogModel[] => {
    const record = asRecord(entry);
    const id = text(record?.id);
    const name = text(record?.name);
    if (!record || !id || !name) return [];
    const thinking = asRecord(record.thinking);
    const options = Array.isArray(thinking?.effort_options)
      ? thinking.effort_options.flatMap((option) => {
          const optionRecord = asRecord(option);
          const optionId = text(optionRecord?.id);
          return optionRecord && optionId ? [{ id: optionId, recommended: Boolean(optionRecord.badge) }] : [];
        })
      : [];
    return [{
      id,
      name,
      family: text(record.short_name) || name.replace(/\s+\d[\d.]*$/, ""),
      ...(text(record.description) ? { description: text(record.description) } : {}),
      section: record.section === "overflow" ? "overflow" : "main",
      ...(text(record.min_claude_code_version) ? { minClaudeCodeVersion: text(record.min_claude_code_version) } : {}),
      efforts: options.map((option) => option.id),
      ...(options.find((option) => option.recommended) ? { defaultEffort: options.find((option) => option.recommended)!.id } : {}),
    }];
  });
  if (models.length === 0) return null;
  const fetchedAt = typeof file.fetchedAt === "number" && Number.isFinite(file.fetchedAt) ? file.fetchedAt : 0;
  return { models, fetchedAt };
}

/** 複数アカウント分のキャッシュがあるときは、いちばん新しく取得されたものを使う。 */
export async function readClaudeModelCatalog(
  directory: string = defaultClaudeModelCatalogDir(),
): Promise<ClaudeModelCatalogSnapshot | null> {
  let names: string[];
  try {
    names = (await fs.readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch {
    return null;
  }
  const snapshots = await Promise.all(names.map(async (name) => {
    try {
      return parseClaudeModelCatalog(JSON.parse(await fs.readFile(path.join(directory, name), "utf8")));
    } catch {
      return null;
    }
  }));
  return snapshots.reduce<ClaudeModelCatalogSnapshot | null>(
    (latest, snapshot) => (snapshot && (!latest || snapshot.fetchedAt > latest.fetchedAt) ? snapshot : latest),
    null,
  );
}

/**
 * 一覧を選択肢にする。今のラインナップ (main) はファミリー名の別名 (`sonnet` など) を id にして、
 * 新しい版が出ても保存済みの選択が自然に最新へ追随するようにする。別名が `--help` に無い
 * ファミリーと旧版 (overflow) は完全なモデルIDで固定する (`--help` が読めなければ別名を信頼する)。インストール済みの Claude Code が
 * 対応していない (min_claude_code_version 未満の) モデルは選ばせない。
 */
export function buildClaudeModelOptions(
  models: readonly ClaudeCatalogModel[],
  context: {
    aliases: readonly string[];
    cliVersion: string | null;
    latestAliasDescription: string;
    olderModelDescription: string;
  },
): ClaudeModelOption[] {
  const usable = models.filter((model) => claudeVersionAtLeast(context.cliVersion, model.minClaudeCodeVersion));
  const seen = new Set<string>();
  const options: ClaudeModelOption[] = [];
  for (const model of [...usable.filter((item) => item.section === "main"), ...usable.filter((item) => item.section === "overflow")]) {
    const alias = model.section === "main" ? model.family.toLowerCase() : "";
    // `--help` が読めない (パイプ出力が途中で切れることがある) ときは、ファミリー名の別名は常に使える前提にする。
    const id = alias && (context.aliases.length === 0 || context.aliases.includes(alias)) ? alias : model.id;
    if (seen.has(id)) continue;
    seen.add(id);
    options.push({
      id,
      label: `Claude ${model.name}`,
      description: id === model.id
        ? (model.section === "overflow" ? context.olderModelDescription : model.description)
        : context.latestAliasDescription,
      ...(model.defaultEffort ? { defaultReasoningEffort: model.defaultEffort } : {}),
      supportedReasoningEfforts: model.efforts.map((effort) => ({ id: effort })),
    });
  }
  // 既定は Sonnet (軽快で日常の編集向き)。無ければ先頭。
  const fallbackDefault = options.find((option) => /^(?:claude-)?sonnet(?:-|$)/.test(option.id)) ?? options[0];
  return options.map((option) => (option === fallbackDefault ? { ...option, isDefault: true } : option));
}

/** "2.1.280" のようなバージョンの大小比較。読めない側があれば「満たす」扱いにする。 */
export function claudeVersionAtLeast(actual: string | null, required: string | undefined): boolean {
  if (!actual || !required) return true;
  const a = versionParts(actual);
  const b = versionParts(required);
  if (!a || !b) return true;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

export function parseClaudeVersion(output: string): string | null {
  return output.match(/\d+(?:\.\d+)+/)?.[0] ?? null;
}

function versionParts(value: string): number[] | null {
  const parts = value.match(/\d+/g)?.map(Number);
  return parts && parts.length > 0 ? parts : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
