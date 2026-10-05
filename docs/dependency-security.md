# 開発用依存のセキュリティ補修

2026-10-05時点の依存監査で検出された2種類の問題への対処。
通常の `npm ci` で再現でき、`npm run security:audit` は再現・互換性テストとnpm監査を両方実行する。
警告の除外や監査対象の縮小は行っていない。

## Next.jsのlint用ファイル検索

- 対象: [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
- `@next/eslint-plugin-next@16.3.8` → `fast-glob` → `micromatch` → `braces` の依存で発生する。
- この版のNextプラグインは `globSync(pattern, { onlyDirectories: true })` だけを使用する。
  その依存に限定して、既に本プロジェクトで使用している `tinyglobby@0.2.17` をnpm aliasで指定した。
- ルートの開発用依存にもNextプラグインを明示した。npm 11ではworkspaceからの間接依存だけだと
  既存lockfileのoverrideが反映されず、`npm ls` がaliasをinvalidと判定するため。
- ルート設定の単一パス・glob・brace・配列、深いbrace入力、実際の
  `no-html-link-for-pages` ルールを検証する。tinyglobbyの相対パス・末尾区切り文字は
  Nextの利用箇所で同じディレクトリを指すことを確認する。
- Nextプラグイン更新時は、使用APIとoverrideの対象版を見直す。

## ビルド用HTTPキャッシュ

- 対象: [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)
- `app-builder-lib` → `@electron/get@3.1.0` → `got` → `cacheable-request` から入る。
- `http-cache-semantics@4.3.0` はnpm監査の対象範囲外だが、実際には `max-stale` による
  Set-Cookie・proxy-revalidate・no-cacheの再利用が再現した。更新だけを修正完了とは扱わない。
- 4.3.0を固定し、ルートの `postinstall` で `evaluateRequest` に再利用禁止のチェックを追加する。
  保存禁止・no-cache、および共有キャッシュのproxy-revalidateと既存のSet-Cookie禁止条件を
  freshness/max-staleの判定より先に適用する。通常のpublicキャッシュとprivateキャッシュは維持する。
- 補修は配布tarballのソース全体のSHA-256を検証してから適用する。繰り返し実行可能で、
  未確認の版・ソース変更ではインストールを失敗させる。
- `npm ci --ignore-scripts` では補修されない。この場合、`security:audit` の再現テストが失敗する。
  開発用依存を除くインストールでは、この開発用ライブラリへの補修を省略する。
- 上流の修正版が出たら、再現テストを残したまま固定版と補修を取り除けることを確認する。

`scripts/dependency-security.test.mjs` は実際にビルドツールが解決する依存を使用する。
ローカルHTTP経由のartifact取得、SHA-256検証、artifactキャッシュ再利用も確認する。
このテストは本番の外部サービスや署名・公開処理には接続しない。
