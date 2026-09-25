import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

export const collaborationKeys = ['SIGMA_COLLABORATION_URL', 'SIGMA_SUPABASE_URL', 'SIGMA_SUPABASE_ANON_KEY'];

// Only client connection settings are read; profiles and server credentials stay separate.
export function developmentCollaborationEnv(repository, environment = process.env) {
  const explicit = environment.SIGMA_STUDIO_COLLABORATION_ENV_FILE;
  const file = path.resolve(repository, explicit || '.env.collaboration-desktop.local');
  let values;
  try { values = parseEnv(readFileSync(file, 'utf8')); }
  catch (error) { if (!explicit && error.code === 'ENOENT') return { ...environment }; throw error; }
  const result = { ...environment };
  for (const key of collaborationKeys) {
    if (result[key] === undefined && values[key] !== undefined) result[key] = values[key];
  }
  return result;
}

// Release builds fail closed. Never serialize the complete build environment.
export function releaseCollaborationDefaults(environment = process.env) {
  if (environment.SIGMA_STUDIO_REQUIRE_COLLABORATION_CONFIG !== 'true') return null;
  const result = Object.fromEntries(collaborationKeys.map(key => [key, environment[key]?.trim()]));
  for (const key of collaborationKeys) {
    if (!result[key]) throw new Error(`Release requires ${key}`);
  }
  for (const key of collaborationKeys.slice(0, 2)) {
    let url;
    try { url = new URL(result[key]); } catch { throw new Error(`Invalid release setting: ${key}`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        url.pathname !== '/' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
      throw new Error(`Release requires a public HTTPS origin: ${key}`);
    }
    result[key] = url.origin;
  }
  const key = result.SIGMA_SUPABASE_ANON_KEY;
  let publicKey = /^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
  if (!publicKey) {
    try { publicKey = key.split('.').length === 3 && JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role === 'anon'; }
    catch { /* Invalid keys are rejected without printing their value. */ }
  }
  if (!publicKey) throw new Error('Release requires a Supabase publishable/anon key, never a secret/service-role key');
  return result;
}
