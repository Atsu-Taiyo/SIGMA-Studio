import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { releaseExtensionDefaults } from '../apps/desktop/scripts/extension-build-config.mjs';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString().trim();
const valid = { SIGMA_EXTENSIONS_CATALOG_URL: 'https://example.test/functions/v1/plugins/catalog', SIGMA_EXTENSIONS_PUBLIC_KEY: pem };

test('extensions are optional in a build, and embed only the URL and public key', () => {
  assert.equal(releaseExtensionDefaults({}), null);
  const config = releaseExtensionDefaults({ ...valid, SIGMA_SERVICE_ROLE_KEY: 'do-not-ship' });
  assert.deepEqual(Object.keys(config).sort(), ['catalogUrl', 'publicKey']);
  assert.equal(config.catalogUrl, valid.SIGMA_EXTENSIONS_CATALOG_URL);
  assert.equal(config.publicKey, pem);
});

test('a key written on one line with \\n escapes is accepted', () => {
  const config = releaseExtensionDefaults({ ...valid, SIGMA_EXTENSIONS_PUBLIC_KEY: pem.replace(/\n/g, '\\n') });
  assert.equal(config.publicKey, pem);
});

test('a required but missing configuration stops the build', () => {
  assert.throws(() => releaseExtensionDefaults({ SIGMA_STUDIO_REQUIRE_EXTENSIONS_CONFIG: 'true' }), /requires/);
});

test('half a configuration, local or unsafe URLs, and non-Ed25519 or private keys are rejected', () => {
  assert.throws(() => releaseExtensionDefaults({ SIGMA_EXTENSIONS_CATALOG_URL: valid.SIGMA_EXTENSIONS_CATALOG_URL }), /PUBLIC_KEY/);
  assert.throws(() => releaseExtensionDefaults({ SIGMA_EXTENSIONS_PUBLIC_KEY: pem }), /CATALOG_URL/);
  for (const address of ['http://example.test/plugins/catalog', 'https://localhost/plugins/catalog', 'https://127.0.0.1/plugins/catalog',
    'https://example.test/plugins', 'https://example.test/plugins/catalog?x=1', 'https://user:pass@example.test/plugins/catalog', 'not a url']) {
    assert.throws(() => releaseExtensionDefaults({ ...valid, SIGMA_EXTENSIONS_CATALOG_URL: address }));
  }
  assert.throws(() => releaseExtensionDefaults({ ...valid, SIGMA_EXTENSIONS_PUBLIC_KEY: 'not a key' }), /PEM/);
  assert.throws(() => releaseExtensionDefaults({ ...valid, SIGMA_EXTENSIONS_PUBLIC_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }), /public key/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
  assert.throws(() => releaseExtensionDefaults({ ...valid, SIGMA_EXTENSIONS_PUBLIC_KEY: rsa }), /Ed25519/);
});
