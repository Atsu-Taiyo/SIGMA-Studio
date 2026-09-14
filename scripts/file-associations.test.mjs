import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const config = require('../apps/desktop/electron-builder.config.cjs');
// Initialize builder's public entry first; its target modules have a CommonJS cycle.
require('app-builder-lib');
const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget');
const { default: AppxTarget } = require('app-builder-lib/out/targets/AppxTarget');
const { LinuxTargetHelper } = require('app-builder-lib/out/targets/LinuxTargetHelper');
const { CancellationToken } = require('builder-util-runtime');

// Run the installed builder's real generators. Only resources and packager metadata are fixtures.
function packager() {
  return {
    config, fileAssociations: config.fileAssociations, platformSpecificBuildOptions: {},
    executableName: 'sigma-studio',
    appInfo: { productName: config.productName, sanitizedProductName: 'SigmaStudio', description: 'Sigma Studio' },
    info: { metadata: { dependencies: {} }, cancellationToken: new CancellationToken() },
    getResource: async () => null, resourceList: Promise.resolve([]),
  };
}

test('NSIS generates only the Sigma association and quotes the file argument', async () => {
  const target = new NsisTarget(packager(), '/unused', 'nsis', { refCount: 0 });
  const install = await target.computeFinalScript('', true, new Map());
  const uninstall = await target.computeFinalScript('', false, new Map());
  assert.match(install, /APP_ASSOCIATE "sigma"/);
  assert.ok(install.includes('$\\"%1$\\"'));
  assert.match(uninstall, /APP_UNASSOCIATE "sigma"/);
  assert.doesNotMatch(install + uninstall, /"(?:json|sigma\.json|sigmadoc\.json)"/);
});

test('AppX generates the dedicated file type without registering generic JSON', async () => {
  const xml = await AppxTarget.prototype.getExtensions.call({ packager: packager(), options: {} }, 'SigmaStudio.exe', 'Sigma Studio');
  assert.match(xml, /<uap:FileType>\.sigma<\/uap:FileType>/);
  assert.doesNotMatch(xml, /\.json/);
});

test('Linux generates a dedicated MIME glob and passes multiple local paths with %F', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sigma-file-associations-'));
  try {
    const metadata = packager();
    metadata.getTempFile = async () => path.join(root, 'sigma.xml');
    const helper = new LinuxTargetHelper(metadata);
    const desktop = await helper.computeDesktopEntry(config.linux);
    const mime = await readFile(await helper.mimeTypeFiles, 'utf8');
    assert.match(desktop, /Exec=.* %F\n/);
    assert.match(desktop, /MimeType=application\/x-sigma-studio;/);
    assert.match(mime, /<glob pattern="\*\.sigma"\/>/);
    assert.doesNotMatch(mime + desktop, /application\/json|\*\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
