## 何を変えるか

<!-- 1〜3 行。「なぜ」が分かるように書く。 -->

## 性能への影響

<!--
以下のどちらかを必ず埋める。
- 該当なし: 性能に影響しない理由を 1 行で（例: テストのみ / ドキュメントのみ / 実行経路を通らない）
- 影響あり: `npm run perf:probe` の数値を貼る（before / after）。
  **貼るのは `perf-reports/<timestamp>/summary.md` の表**（端末出力をそのまま貼ると
  ローカルの絶対パスが混ざる）。summary.md の先頭に予算 assert の有効/無効と
  計測したビルドの revision が入っているので、それも一緒に貼ると「何を測ったか」が伝わる。
  計測の作法と予算は docs/performance-budget.md。
  main プロセス側の変更は probe に映らないので、vitest の実測を貼る。
-->

- [ ] 該当なし（理由: ）
- [ ] 計測した（下に before/after）

| 指標 | before | after |
| --- | ---: | ---: |
|  |  |  |

## 確認したこと

<!-- lint / typecheck / vitest / e2e のうち走らせたもの。落ちたものがあれば base でも落ちるかを書く。 -->

- [ ] `npm run lint` / `npx tsc --noEmit`
- [ ] vitest
- [ ] 影響する e2e（spec 名: ）
