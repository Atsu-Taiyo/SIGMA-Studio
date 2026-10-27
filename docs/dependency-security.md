# 依存のセキュリティ補修

依存監査で検出された問題と、上流の公式advisoryから確認した対策の記録。
通常の `npm ci` で再現でき、`npm run security:audit` は再現・互換性テストとnpm監査を両方実行する。
警告の除外や監査対象の縮小は行っていない。

## Electron内蔵Node.jsのUndici

- 対象: [GHSA-qrxm-fqhp-jwvm](https://github.com/nodejs/undici/security/advisories/GHSA-qrxm-fqhp-jwvm)。
  npmの`undici`へのoverrideは、Electron内蔵Node.jsの`fetch`実装を更新しない。
- 2026-10-28に実runtimeを確認すると、Electron44.9.3と更新候補45.0.0はNode24.22.0 / Undici7.29.1だった。
  `npm audit`は0件でも、内蔵HTTP/1・HTTP/2のエラーハンドラには公式指摘のassertionが残っていた。
  認証・共同編集のElectron mainはglobal `fetch`を使う。TLS接続や認証情報の流出を実際に再現したという意味ではない。
- 更新候補をElectron45.1.0（Node24.22.1 / Undici7.30.1）へ進める。
  既存の45系更新PRの補修であり、44系からのメジャー更新の互換性は別に検証する。
  44系の保守版44.10.0もNode24.22.1への更新を公表しているが、本変更の実runtime検証は45.1.0を対象にする。
- `dependency-security.test.mjs`は、配布に使うElectronをNodeモードで起動し、内蔵ソースの実ハンドラへ
  合成した`ERR_TLS_CERT_ALTNAME_INVALID`を渡す。更新前はassertionで失敗、更新後はHTTP/1・HTTP/2の3経路で
  エラーを通知して戻ることを確認する。外部通信・TLS再交渉は行わず、ネットワーク全体の検証と区別する。
  内蔵ソースやハンドラ名が変わった場合は黙ってskipせず再確認を要求する。
- 同日に更新されたAgentの独自TLS検証・cache/decompress interceptor・WebSocketの公式指摘は、
  各機能の使用条件が異なるため、このクラッシュ検査だけで全指摘の到達性や修正を実証したとは扱わない。

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

## Electronの証明書失効対策

- 対象: [GHSA-jr5w-w6x2-84p9](https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9)
- 2026-10-24のnpm監査は、このElectron公式のhigh指摘を返さなかった。npm監査だけを安全性の根拠にせず、上流の公式advisoryも確認する。
- 44.9.0は影響範囲に含まれる。侵害された中間証明書と通信経路の傍受を組み合わせると、TLS接続先を偽装される条件がある。
  SIGMAの共同編集・認証はElectron mainのfetchで通信するため、ネットワークを使わないアプリという例外には当たらない。
  実際の傍受・認証情報の流出を確認したという意味ではない。
- 同じ44系の修正版44.9.3へ更新する。公式の最低修正版は44.9.1で、Chromiumの通信と同梱Node.jsのtls/https/fetchの両方に対策が入る。
  [44.9.3](https://releases.electronjs.org/release/v44.9.3) は追加のChromium等の補修も含む。メジャー更新やアプリ側での証明書検証の無効化は行わない。
- `dependency-security.test.mjs` は実際に解決されるElectronの安定版が44.9.1以上であることを要求する。
  `dependencies:check` がmanifest・lockfile・インストール済みruntime・配布設定の一致を検査するため、検査用と配布用の版を分けない。
  このバージョン検査は、侵害された証明書による攻撃を実行する検査や、すべての新しいadvisoryを自動検出する機能ではない。
