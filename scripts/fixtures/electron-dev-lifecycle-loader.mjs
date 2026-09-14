// Exercise the real supervisor with short-lived, isolated startup dependencies.
// No real Electron bundle, developer server or user data is touched by this test.
import childProcess from 'node:child_process';
import { registerHooks, syncBuiltinESMExports } from 'node:module';

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('/apps/desktop/scripts/build-electron.mjs')) return nextLoad(url, context);
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        export async function buildElectron() {
          const watcher = setInterval(() => {}, 1000);
          console.log('[fixture] build-starting');
          await new Promise(resolve => setTimeout(resolve, 300));
          return { async dispose() {
            clearInterval(watcher);
            console.log('[fixture] build-disposed');
          } };
        }
      `,
    };
  },
});

const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (args.includes('dev') && args.includes('--hostname')) {
    const port = Number(args[args.indexOf('--port') + 1]);
    args = ['--input-type=module', '-e', `
      import { createServer } from 'node:http';
      createServer((_, response) => {
        setTimeout(() => {
          response.setHeader('x-sigma-dev-session', process.env.SIGMA_STUDIO_DEV_SESSION);
          response.end('ready');
        }, process.env.SIGMA_DEV_TEST_PHASE === 'renderer' ? 300 : 0);
      }).listen(${port}, '127.0.0.1', () => console.log('[fixture] renderer-ready'));
    `];
  } else if (args[0] === 'scripts/brand-dev-electron.mjs') {
    args = ['-e', "console.log('[fixture] brand-starting'); setTimeout(() => {}, 300)"];
  } else {
    throw new Error(`Unexpected startup child: ${command}`);
  }
  const child = spawn(command, args, options);
  console.log(`[fixture] child ${child.pid}`);
  return child;
};
syncBuiltinESMExports();
