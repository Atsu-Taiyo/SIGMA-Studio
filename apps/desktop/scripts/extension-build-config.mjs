import { createPublicKey } from 'node:crypto';

/**
 * 拡張機能の取得先と、検証に使う公開鍵。どちらも公開してよい値で、秘密鍵や認証情報は受け取らない。
 * 設定が無いビルドでは拡張機能の取得が「利用できません」になるだけで、ほかの機能は変わらない。
 * `SIGMA_STUDIO_REQUIRE_EXTENSIONS_CONFIG=true` のときは、無い・壊れている設定でビルドを止める。
 */
export function releaseExtensionDefaults(environment = process.env) {
  const catalogUrl = environment.SIGMA_EXTENSIONS_CATALOG_URL?.trim();
  const publicKey = environment.SIGMA_EXTENSIONS_PUBLIC_KEY?.replace(/\\n/g, '\n').trim();
  const required = environment.SIGMA_STUDIO_REQUIRE_EXTENSIONS_CONFIG === 'true';
  if (!catalogUrl && !publicKey) {
    if (required) throw new Error('Release requires SIGMA_EXTENSIONS_CATALOG_URL and SIGMA_EXTENSIONS_PUBLIC_KEY');
    return null;
  }
  if (!catalogUrl) throw new Error('Release requires SIGMA_EXTENSIONS_CATALOG_URL');
  if (!publicKey) throw new Error('Release requires SIGMA_EXTENSIONS_PUBLIC_KEY');
  let url;
  try { url = new URL(catalogUrl); } catch { throw new Error('Invalid release setting: SIGMA_EXTENSIONS_CATALOG_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/catalog')
    || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Release requires a public HTTPS catalog URL ending in /catalog');
  }
  // Node would derive the public half from a private key; refuse to touch one at all.
  if (/PRIVATE KEY/.test(publicKey)) throw new Error('Release requires a public key, never a private key');
  let key;
  try { key = createPublicKey(publicKey); } catch { throw new Error('Release requires a PEM public key'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Release requires an Ed25519 public key, never a private key');
  return { catalogUrl: url.href, publicKey: key.export({ type: 'spki', format: 'pem' }).toString().trim() };
}
