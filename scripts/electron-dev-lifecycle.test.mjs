import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const loader = fileURLToPath(new URL('./fixtures/electron-dev-lifecycle-loader.mjs', import.meta.url));
const entry = fileURLToPath(new URL('../apps/desktop/scripts/dev-electron.mjs', import.meta.url));

for (const phase of ['renderer', 'brand', 'build']) {
  test(`SIGINT during ${phase} startup leaves no supervisor or late watcher`, {
    // Windows process.kill does not deliver a console Ctrl+C event to Node.
    skip: process.platform === 'win32',
    timeout: 10_000,
  }, async () => {
    const child = spawn(process.execPath, ['--import', loader, entry], {
      cwd: root,
      env: { ...process.env, SIGMA_DEV_TEST_PHASE: phase },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let interrupted = false;
    const childPids = new Set();
    const marker = `[fixture] ${phase === 'renderer' ? 'renderer-ready' : `${phase}-starting`}`;
    const capture = (chunk) => {
      output += chunk;
      for (const match of output.matchAll(/\[fixture\] child (\d+)/g)) childPids.add(Number(match[1]));
      if (!interrupted && output.includes(marker)) {
        interrupted = true;
        child.kill('SIGINT');
      }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    // A regression must fail the test rather than leave watch processes behind.
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      const [code, signal] = await once(child, 'exit');
      assert.ok(interrupted, output);
      assert.equal(signal, null, output);
      assert.equal(code, 0, output);
      if (phase === 'build') assert.match(output, /\[fixture\] build-disposed/);
      else assert.doesNotMatch(output, /\[fixture\] build-starting/);
      for (const pid of childPids) {
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, output);
      }
    } finally {
      clearTimeout(timeout);
      child.kill('SIGKILL');
      for (const pid of childPids) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* Already exited. */ }
      }
    }
  });
}
