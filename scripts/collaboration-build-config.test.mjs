import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { developmentCollaborationEnv, releaseCollaborationDefaults } from '../apps/desktop/scripts/collaboration-build-config.mjs';
const valid = {
  SIGMA_STUDIO_REQUIRE_COLLABORATION_CONFIG: 'true',
  SIGMA_COLLABORATION_URL: 'https://sync.example.test',
  SIGMA_SUPABASE_URL: 'https://auth.example.test',
  SIGMA_SUPABASE_ANON_KEY: 'sb_publishable_fixture',
};
test('release embeds only public client settings, rejecting missing, local and privileged values', () => {
  assert.equal(releaseCollaborationDefaults({}), null);
  assert.deepEqual(Object.keys(releaseCollaborationDefaults({...valid, PRIVATE_KEY: 'do-not-ship'})), ['SIGMA_COLLABORATION_URL','SIGMA_SUPABASE_URL','SIGMA_SUPABASE_ANON_KEY']);
  for (const name of ['SIGMA_COLLABORATION_URL','SIGMA_SUPABASE_URL','SIGMA_SUPABASE_ANON_KEY']) {
    assert.throws(() => releaseCollaborationDefaults({...valid,[name]:''}), /requires/);
  }
  for (const address of ['http://127.0.0.1:54321','https://localhost','https://auth.example.test?secret=x','https://user:pass@auth.example.test']) {
    assert.throws(() => releaseCollaborationDefaults({...valid,SIGMA_SUPABASE_URL:address}), /HTTPS origin/);
  }
  for (const role of ['service_role','authenticated']) {
    const key='e30.'+Buffer.from(JSON.stringify({role})).toString('base64url')+'.signature';
    assert.throws(() => releaseCollaborationDefaults({...valid,SIGMA_SUPABASE_ANON_KEY:key}), /publishable\/anon/);
  }
  assert.throws(() => releaseCollaborationDefaults({...valid,SIGMA_SUPABASE_ANON_KEY:'sb_secret_do-not-ship'}), /publishable\/anon/);
});
test('dev loads cloud settings, keeps explicit overrides and excludes profile/server secrets', () => {
  const dir=mkdtempSync(path.join(tmpdir(),'sigma-config-'));
  try {
    assert.deepEqual(developmentCollaborationEnv(dir,{}),{});
    writeFileSync(path.join(dir,'.env.collaboration-desktop.local'),'SIGMA_SUPABASE_URL=https://cloud.example.test\nSIGMA_STUDIO_USER_DATA_DIR=wrong-profile\nPRIVATE_KEY=secret');
    writeFileSync(path.join(dir,'.env.collaboration.local'),'SIGMA_SUPABASE_URL=http://127.0.0.1:54321');
    assert.deepEqual(developmentCollaborationEnv(dir,{}),{SIGMA_SUPABASE_URL:'https://cloud.example.test'});
    assert.equal(developmentCollaborationEnv(dir,{SIGMA_SUPABASE_URL:'https://override.example.test'}).SIGMA_SUPABASE_URL,'https://override.example.test');
    assert.equal(developmentCollaborationEnv(dir,{SIGMA_STUDIO_COLLABORATION_ENV_FILE:'.env.collaboration.local'}).SIGMA_SUPABASE_URL,'http://127.0.0.1:54321');
    assert.throws(()=>developmentCollaborationEnv(dir,{SIGMA_STUDIO_COLLABORATION_ENV_FILE:'missing'}),/ENOENT/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
