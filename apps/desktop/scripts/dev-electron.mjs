#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildElectron } from './build-electron.mjs';
import { developmentCollaborationEnv } from './collaboration-build-config.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(root, '../..');
const env = developmentCollaborationEnv(repository);
delete env.ELECTRON_RUN_AS_NODE;
delete env.NEXT_PUBLIC_TARGET;
const session = randomUUID();
let renderer;
let electron;
let builder;
let stopping = false;
let restarting = false;
let rebuildTimer;

function start(command, args, extra = {}) {
  return spawn(command, args, {
    cwd: root, env, stdio: ['pipe', 'inherit', 'inherit'],
    // The supervisor handles Ctrl+C; Electron first gets its normal save/close handshake.
    detached: process.platform !== 'win32', ...extra,
  });
}
function stopRenderer() {
  if (renderer?.exitCode === null) {
    if (process.platform === 'win32') renderer.kill();
    else { try { process.kill(-renderer.pid, 'SIGTERM'); } catch {} }
  }
}
async function cleanup(code = 0) {
  stopping = true;
  clearTimeout(rebuildTimer);
  await builder?.dispose();
  stopRenderer();
  process.exitCode = code;
}
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearTimeout(rebuildTimer);
  process.exitCode = code;
  if (electron?.exitCode === null) {
    console.log('[desktop] Closing through the app save dialog; canceling leaves the app open.');
    electron.stdin.write('sigma:quit\n');
  } else await cleanup(code);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

function launchElectron(url) {
  if (stopping) return;
  restarting = false;
  electron = start(require('electron'), ['.'], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...env, SIGMA_STUDIO_DEV_SERVER_URL: url,
      SIGMA_STUDIO_USER_DATA_DIR: env.SIGMA_STUDIO_USER_DATA_DIR || path.join(repository, 'tmp/desktop-dev-profile') },
  });
  let pendingOutput = '';
  electron.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    pendingOutput += chunk.toString();
    const lines = pendingOutput.split('\n');
    pendingOutput = lines.pop().slice(-1024);
    if (lines.includes('[desktop] close-cancelled')) {
      restarting = false;
      stopping = false;
      process.exitCode = undefined;
      console.log('[desktop] Close canceled; development remains active.');
    }
  });
  electron.stdin.on('error', (error) => {
    if (error.code !== 'EPIPE') console.error(error);
  });
  console.log(`[desktop] Electron PID ${electron.pid}; renderer ${url}`);
  electron.on('error', (error) => { console.error(error); void shutdown(1); });
  electron.on('exit', (code) => {
    electron = undefined;
    if (restarting && !stopping) launchElectron(url);
    else void cleanup(code ?? process.exitCode ?? 0);
  });
}

async function run() {
  // Allocate a private port, then verify a per-launch header before exposing the bridge.
  const port = await new Promise((resolve, reject) => {
    const socket = createServer();
    socket.on('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
  if (stopping) return;
  const url = `http://127.0.0.1:${port}/`;
  renderer = start(process.execPath, [require.resolve('next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', String(port)], {
    env: { ...env, SIGMA_STUDIO_DEV_SESSION: session },
  });
  renderer.on('error', (error) => { console.error(error); void shutdown(1); });
  renderer.on('exit', (code) => { if (!stopping) void shutdown(code || 1); });
  let ready = false;
  const deadline = Date.now() + 120_000;
  while (!stopping && renderer.exitCode === null && Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (response.ok && response.headers.get('x-sigma-dev-session') === session) {
        await response.arrayBuffer();
        ready = true;
        break;
      }
      await response.body?.cancel();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (stopping) return;
  if (!ready) throw new Error('The private Electron development server did not become ready.');
  const brand = start(process.execPath, ['scripts/brand-dev-electron.mjs']);
  await new Promise((resolve, reject) => { brand.on('error', reject); brand.on('exit', resolve); });
  if (stopping) return;
  builder = await buildElectron({ watch: true, onBuilt() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      if (stopping) return;
      if (!electron) launchElectron(url);
      else {
        restarting = true;
        console.log('[desktop] Main/preload rebuilt. Restart requested through the save/close handshake.');
        electron.stdin.write('sigma:quit\n');
      }
    }, 150);
  } });
  // SIGINT can finish cleanup while context()/watch() is still starting. Once
  // that pending acquisition completes, dispose it instead of leaving a watcher.
  if (stopping) {
    await cleanup(process.exitCode ?? 0);
    return;
  }
  console.log('[desktop] Renderer: Fast Refresh. Main/preload/MCP dependencies: rebuild and restart.');
}

try {
  await run();
} catch (error) {
  console.error(error);
  await shutdown(1);
}
