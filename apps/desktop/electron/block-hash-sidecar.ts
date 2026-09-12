import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * ブロックハッシュ履歴 (sidecar) の唯一の出典。
 *
 * 読み手が 2 つある (`LocalSigmaDocStore` と `LocalMcpEditProposalStore`) ので、
 * 置き場所・拡張子・行の形をここ 1 箇所に集める。以前は両方が自前の定数と
 * パーサを持っていて、書き手だけ形式を変えたときに読み手が黙って何も読めなくなり、
 * AI 提案の自動 rebase が「履歴が読めない時の安全側フォールバック」に落ち続けた。
 */
export const BLOCK_HASH_FILE_SUFFIX = ".blockhashes.jsonl";

/** 読み出しで遡れる revision 数。 */
export const MAX_BLOCK_HASH_REVISIONS = 100;

/** 旧形式 (全体を書き直していた頃)。読まないが、残骸を消すために名前だけ知っておく。 */
const LEGACY_BLOCK_HASH_FILE_SUFFIX = ".blockhashes.json";

export type BlockHashRevisions = Record<string, Record<string, string>>;

export function resolveBlockHashPath(dir: string, fileId: string): string {
  return path.join(dir, `${encodeURIComponent(fileId)}${BLOCK_HASH_FILE_SUFFIX}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 履歴 1 行を読む。壊れていれば null (追記の途中でクラッシュした行など)。 */
export function parseBlockHashLine(
  line: string,
): { revision: number; hashes: Record<string, string> } | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!isPlainRecord(parsed) || typeof parsed.revision !== "number" || !isPlainRecord(parsed.hashes)) {
      return null;
    }
    const entries = Object.entries(parsed.hashes);
    if (entries.some(([, hash]) => typeof hash !== "string")) {
      return null;
    }
    return { revision: parsed.revision, hashes: Object.fromEntries(entries) as Record<string, string> };
  } catch {
    return null;
  }
}

/** 追記ファイルの行を返す。空行は落とす。ファイルが無ければ null。 */
export async function readBlockHashLines(dir: string, fileId: string): Promise<string[] | null> {
  try {
    const raw = await fs.readFile(resolveBlockHashPath(dir, fileId), "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    return lines.length > 0 ? lines : null;
  } catch {
    return null;
  }
}

/** 直近 `MAX_BLOCK_HASH_REVISIONS` 件の revision → ハッシュ表。 */
export async function readBlockHashRevisions(
  dir: string,
  fileId: string,
): Promise<BlockHashRevisions | null> {
  const lines = await readBlockHashLines(dir, fileId);
  if (!lines) {
    return null;
  }
  const revisions: BlockHashRevisions = {};
  // 追記型なので後の行が新しい。同じ revision が 2 度出たら後勝ち。
  for (const line of lines.slice(-MAX_BLOCK_HASH_REVISIONS)) {
    const entry = parseBlockHashLine(line);
    if (entry) {
      revisions[String(entry.revision)] = entry.hashes;
    }
  }
  return Object.keys(revisions).length > 0 ? revisions : null;
}

/**
 * 1 revision を追記する。行数が上限の 2 倍を超えたときだけ書き直す。
 *
 * 改行は**行の前**に置く。末尾に置くと、追記の途中でクラッシュして切れた行に
 * 次の追記が連結され、壊れた 1 行が「その revision」と「次の revision」の
 * 2 つを道連れにする。前置きなら切れた行は次の追記で終端され、失うのは 1 つで済む。
 */
export async function appendBlockHashRevision(
  dir: string,
  fileId: string,
  revision: number,
  hashes: Record<string, string>,
  lineCounts: Map<string, number>,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const targetPath = resolveBlockHashPath(dir, fileId);
  const record = JSON.stringify({ revision, hashes });

  let count = lineCounts.get(fileId);
  if (count === undefined) {
    // プロセス起動後の初回だけ実ファイルを数える。ついでに旧形式の残骸を捨てる
    // (読まないので置いておく意味がなく、教材ごとに十数 MB 残り続ける)。
    count = (await readBlockHashLines(dir, fileId))?.length ?? 0;
    await fs.rm(path.join(dir, `${encodeURIComponent(fileId)}${LEGACY_BLOCK_HASH_FILE_SUFFIX}`), {
      force: true,
    }).catch(() => undefined);
  }

  if (count >= MAX_BLOCK_HASH_REVISIONS * 2) {
    const existing = (await readBlockHashLines(dir, fileId)) ?? [];
    const kept = [...existing.slice(-(MAX_BLOCK_HASH_REVISIONS - 1)), record];
    // 診断用の読み取り専用履歴なので、台帳や本文と違い fsync までは求めない。
    const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, `${kept.join("\n")}\n`, "utf8");
      await fs.rename(temporaryPath, targetPath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
    lineCounts.set(fileId, kept.length);
    return;
  }

  await fs.appendFile(targetPath, count === 0 ? `${record}\n` : `\n${record}\n`, "utf8");
  lineCounts.set(fileId, count + 1);
}
