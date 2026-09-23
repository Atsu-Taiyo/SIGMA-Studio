import { build } from 'esbuild';
await build({ entryPoints: ['scripts/collaboration-benchmark.ts'], bundle: true, platform: 'node', format: 'esm', outfile: 'tmp/collaboration-benchmark.mjs' });
await import('../tmp/collaboration-benchmark.mjs');
