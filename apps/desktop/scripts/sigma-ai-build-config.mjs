import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

export const sigmaAiKeys = ['SIGMA_AI_GATEWAY_URL', 'SIGMA_AI_GATEWAY_TOKEN'];

// 内蔵AIの接続先を、開発時だけリポジトリ直下の `.env.sigma-ai.local` から読む。
// 読むのはこの 2 項目だけで、既に指定された環境変数を優先する。ファイルが無ければ何もしない
// (内蔵AIは「利用できません」と表示され、他のAIはそのまま使える)。
export function developmentSigmaAiEnv(repository, environment = process.env) {
  const explicit = environment.SIGMA_STUDIO_SIGMA_AI_ENV_FILE;
  const file = path.resolve(repository, explicit || '.env.sigma-ai.local');
  let values;
  try { values = parseEnv(readFileSync(file, 'utf8')); }
  catch (error) { if (!explicit && error.code === 'ENOENT') return { ...environment }; throw error; }
  const result = { ...environment };
  for (const key of sigmaAiKeys) {
    if (result[key] === undefined && values[key] !== undefined) result[key] = values[key];
  }
  return result;
}
