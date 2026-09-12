import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createLargePerformanceDocument } from "../../tests/fixtures/large-performance-document";
import { createPerfBodyDocument } from "../../tests/fixtures/perf-body-document";
import { createPerfProblemDocument } from "../../tests/fixtures/perf-problem-document";
import { isOverlayAsset } from "@/features/document";
import { createBlankDocument } from "./blank-document";
import {
  recoverSigmaDocument,
  SIGMA_BLOCK_SCHEMA_MEMBERS,
  SigmaBlockSchema,
  SigmaDocumentSchema,
} from "./sigma-doc-schema";

/**
 * `SigmaBlockSchema` を `z.union` から `z.discriminatedUnion` へ変えたとき、
 * **受理する値の集合が 1 ミリも変わっていない**ことを固定する。
 *
 * ここが崩れると「今まで開けていた教材が開かなくなる」あるいは逆に
 * 「壊れた教材が素通りする」という、どちらも静かに効く事故になる。
 * 比較対象は置き換え前と同じ並びの `z.union` を同じメンバーから組み直したもの。
 */
const legacyUnion = z.union(SIGMA_BLOCK_SCHEMA_MEMBERS as never);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function readJsonFixture(relativePath: string): unknown {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

/** 文書の中に現れる「オブジェクトらしきもの」を全部集める。 */
function collectCandidates(value: unknown, out: unknown[], depth = 0): void {
  if (depth > 40 || value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectCandidates(item, out, depth + 1);
    }
    return;
  }
  out.push(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    collectCandidates(child, out, depth + 1);
  }
}

const FIXTURES: Array<{ name: string; document: unknown }> = [
  { name: "perf-body", document: createPerfBodyDocument() },
  { name: "perf-problem", document: createPerfProblemDocument() },
  { name: "large-performance", document: createLargePerformanceDocument() },
  // `sample-document.ts` は complex-square-product-range.sigmadoc.json を再輸出しているだけなので、
  // 両方入れても 1 つ分にしかならない。実体の JSON だけを見る。
  { name: "complex-square-product-range", document: readJsonFixture("complex-square-product-range.sigmadoc.json") },
  { name: "examples/editor-react18", document: readJsonFixture("../../examples/editor-react18/src/sample-document.json") },
];

describe("SigmaBlockSchema: 旧 union と受理集合が同一", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name} の全ノードで success が一致する`, () => {
      const candidates: unknown[] = [];
      collectCandidates(fixture.document, candidates);
      expect(candidates.length).toBeGreaterThan(0);

      const mismatches: string[] = [];
      let accepted = 0;
      for (const candidate of candidates) {
        const legacy = legacyUnion.safeParse(candidate).success;
        const next = SigmaBlockSchema.safeParse(candidate).success;
        if (legacy !== next) {
          const type = (candidate as { type?: unknown }).type;
          mismatches.push(`type=${String(type)} legacy=${legacy} next=${next}`);
        }
        if (legacy) {
          accepted += 1;
        }
      }
      expect(mismatches).toEqual([]);
      // 「全部 false で一致」では検証にならないので、実際に受理された節点があることを確かめる。
      expect(accepted).toBeGreaterThan(0);
    });
  }

  it("受理された値は中身も一致する (片方だけ既定値を足していない)", () => {
    const candidates: unknown[] = [];
    collectCandidates(createPerfProblemDocument(), candidates);
    let compared = 0;
    for (const candidate of candidates) {
      const legacy = legacyUnion.safeParse(candidate);
      if (!legacy.success) {
        continue;
      }
      const next = SigmaBlockSchema.safeParse(candidate);
      expect(next.success).toBe(true);
      if (next.success) {
        expect(next.data).toEqual(legacy.data);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(0);
  });
});

describe("SigmaBlockSchema: 不正な値の扱いも一致", () => {
  const invalid: Array<[string, unknown]> = [
    ["未知の type", { id: "b1", type: "unknown-kind", text: "x" }],
    ["type が無い", { id: "b1", text: "x" }],
    ["type が文字列でない", { id: "b1", type: 42 }],
    ["type が null", { id: "b1", type: null }],
    ["空オブジェクト", {}],
    ["null", null],
    ["配列", []],
    ["文字列", "paragraph"],
    ["数値", 1],
    ["id が無い paragraph", { type: "paragraph", children: [] }],
    ["id が空の paragraph", { id: "", type: "paragraph", children: [] }],
    ["children が配列でない paragraph", { id: "b1", type: "paragraph", children: "x" }],
    ["heading に level が無い", { id: "b1", type: "heading", children: [] }],
    ["list に items が無い", { id: "b1", type: "list", ordered: false }],
    ["layoutSection に children が無い", { id: "b1", type: "layoutSection", layout: { columnCount: 2 } }],
    ["boxBlock に blocks が無い", { id: "b1", type: "boxBlock" }],
    ["problem に必須欄が無い", { id: "b1", type: "problem" }],
  ];

  for (const [name, value] of invalid) {
    it(`拒否が一致: ${name}`, () => {
      const legacy = legacyUnion.safeParse(value).success;
      const next = SigmaBlockSchema.safeParse(value).success;
      expect(next).toBe(legacy);
      expect(next).toBe(false);
    });
  }

  it("`__proto__` を持つ入力でも挙動が一致し、汚染も起きない", () => {
    // オブジェクトリテラルの `__proto__` はプロトタイプ設定になってしまうので、
    // 「実データと同じ経路」= JSON から作る (こちらは own property になる)。
    const value = JSON.parse('{"id":"b1","type":"paragraph","children":[],"__proto__":{"polluted":true}}');
    expect(SigmaBlockSchema.safeParse(value).success).toBe(legacyUnion.safeParse(value).success);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("未知の type でも読めるエラーになる", () => {
    const result = SigmaBlockSchema.safeParse({ id: "b1", type: "unknown-kind" });
    expect(result.success).toBe(false);
    if (!result.success) {
      // `describeSigmaDocumentSchemaFailures` が扱える形であること。
      expect(result.error.issues.length).toBeGreaterThan(0);
      expect(typeof result.error.issues[0].code).toBe("string");
    }
  });
});

describe("recoverSigmaDocument: 速い道と復旧の道", () => {
  function baseDocument(content: unknown[]): unknown {
    // 実データと同じ形から作る (必須欄を手書きすると、schema が育ったときに
    // 「テストの文書が古いだけ」で落ちる)。
    return { ...JSON.parse(JSON.stringify(createBlankDocument())), content };
  }

  const paragraph = (id: string) => ({
    id,
    type: "paragraph",
    children: [{ type: "text", text: id }],
  });

  it("健全な文書は速い道で通り、issues は空", () => {
    const result = recoverSigmaDocument(baseDocument([paragraph("b1"), paragraph("b2")]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issues).toEqual([]);
      expect(result.document.content).toHaveLength(2);
    }
  });

  it("速い道を通った結果は、全体スキーマを直接通した結果と同じ", () => {
    const input = baseDocument([paragraph("b1")]);
    const result = recoverSigmaDocument(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 速い道は「同じ検証を 1 回で済ませる」だけで、値を変えてはいけない。
      const direct = SigmaDocumentSchema.parse(
        JSON.parse(JSON.stringify(input)),
      );
      expect(result.document).toEqual(direct);
    }
  });

  it("壊れたブロックが混ざると復旧の道へ落ち、そのブロックだけ落として続行する", () => {
    const result = recoverSigmaDocument(baseDocument([
      paragraph("b1"),
      { id: "broken", type: "unknown-kind" },
      paragraph("b2"),
    ]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 受理集合を狭めない = 健全なブロックは残る。
      expect(result.document.content.map((block) => block.id)).toEqual(["b1", "b2"]);
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it("根本が壊れていれば従来どおり失敗し、読めるメッセージを返す", () => {
    const result = recoverSigmaDocument({ nope: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("SigmaDoc");
      expect(result.failures.length).toBeGreaterThan(0);
    }
  });
});

describe("discriminator の前提", () => {
  it("10 メンバーがそれぞれ固有の type リテラルを持つ", () => {
    // zod は discriminator を持たないメンバーや重複があると、**safeParse の中から
    // 素の Error を投げる** (最初のパース時)。`recoverSigmaDocument` はそれを捕まえないので、
    // 壊れた教材の失敗画面にすら乗らずレンダラごと落ちる。ここで型ではなく実体を固定する。
    const seen = new Set<string>();
    SIGMA_BLOCK_SCHEMA_MEMBERS.forEach((member, index) => {
      const values = (member as unknown as {
        _zod: { propValues?: Record<string, Set<unknown>> };
      })._zod.propValues?.type;
      expect(values, `member ${index} に type リテラルが無い`).toBeDefined();
      expect(values!.size, `member ${index} の type が 1 つでない`).toBe(1);
      const value = String([...values!][0]);
      expect(seen.has(value), `type "${value}" が重複している`).toBe(false);
      seen.add(value);
    });
    expect([...seen].sort()).toEqual(
      [
        "boxBlock",
        "codeBlock",
        "divider",
        "heading",
        "layoutSection",
        "list",
        "paragraph",
        "problem",
        "quote",
        "section",
      ],
    );
  });

  it("全種別が実際に受理される (fixture に出てこない種別も)", () => {
    // fixture 走査だけでは `section` が一度も肯定されない = そのメンバーが
    // discrimination から外れても緑のままになる。
    //
    // 実データに出てくる種別は **fixture から現物を拾う** (手書きすると schema が
    // 育つたびにテストだけ古くなる)。実データに出てこない種別だけ最小の正例を置く。
    const harvested = new Map<string, unknown>();
    for (const fixture of FIXTURES) {
      const candidates: unknown[] = [];
      collectCandidates(fixture.document, candidates);
      for (const candidate of candidates) {
        const type = (candidate as { type?: unknown }).type;
        if (typeof type !== "string" || harvested.has(type)) {
          continue;
        }
        if (legacyUnion.safeParse(candidate).success) {
          harvested.set(type, candidate);
        }
      }
    }

    const samples = new Map<string, unknown>([
      ...harvested,
      // 実データ (TeX 取り込み) にはあるが、リポジトリの fixture には出てこない。
      ["section", { id: "s1", type: "section", title: "章" }],
    ]);

    const expectedTypes = [
      "boxBlock", "heading", "layoutSection", "list", "paragraph", "problem", "section",
    ];
    for (const type of expectedTypes) {
      const sample = samples.get(type);
      expect(sample, `${type} の正例が用意できていない`).toBeDefined();
      expect(SigmaBlockSchema.safeParse(sample).success, `${type} が新スキーマで受理されない`).toBe(true);
      expect(legacyUnion.safeParse(sample).success, `${type} が旧スキーマで受理されない`).toBe(true);
    }
  });
});

describe("速い道が「黙って落とす」を素通りさせない", () => {
  function documentWithAssetSrc(src: string): unknown {
    const base = JSON.parse(JSON.stringify(createBlankDocument()));
    base.pageLayout = {
      ...base.pageLayout,
      overlay: {
        overlaySnapshot: {
          version: 1,
          shapes: [],
          assets: {
            // **構造としては完全に正しい**素材にすること。必須欄が欠けていると
            // 前処理が早期 return して全体スキーマ側が落ち、速い道に乗らないまま
            // 復旧経路へ行ってしまう = このテストが「守りたい分岐」を通らずに緑になる。
            asset_1: {
              id: "asset_1",
              type: "image",
              props: {
                src,
                w: 10,
                h: 10,
                name: "image.png",
                isAnimated: false,
                mimeType: "image/png",
                fileSize: 100,
              },
            },
          },
        },
      },
    };
    return base;
  }

  it("この分岐が実在すること (素材の構造自体は正しい)", () => {
    // 構造が正しいことを先に確かめる。ここが false だと、下のテストは
    // 「速い道の取りこぼし」ではなく単なる構造エラーを見ていることになる。
    const document = documentWithAssetSrc("https://attacker.example/beacon.png") as {
      pageLayout: { overlay: { overlaySnapshot: { assets: Record<string, unknown> } } };
    };
    expect(isOverlayAsset(document.pageLayout.overlay.overlaySnapshot.assets.asset_1)).toBe(true);
  });

  // `asset-source.ts` が防いでいる出所。これらは前処理で黙って捨てられるので、
  // 速い道に乗せると「除外した」ことが誰にも伝わらない (警告も .bak も出ない)。
  const hostile = [
    "file:///Users/victim/Desktop/private.png",
    "https://attacker.example/beacon.png",
    "javascript:alert(1)",
  ];

  for (const src of hostile) {
    it(`許可外の src を落としたら必ず報告する: ${src.slice(0, 28)}`, () => {
      const result = recoverSigmaDocument(documentWithAssetSrc(src));
      expect(result.ok).toBe(true);
      if (result.ok) {
        // 素材は落ちている (無害化はどちらの道でも同じ)。
        const assets = result.document.pageLayout?.overlay?.overlaySnapshot?.assets ?? {};
        expect(Object.keys(assets)).toEqual([]);
        // かつ、落としたことが issues に出ている = 警告と .bak が動く。
        expect(result.issues.length).toBeGreaterThan(0);
        expect(result.issues.some((issue) => issue.kind === "overlayAsset")).toBe(true);
      }
    });
  }

  it("許可された素材だけの文書は速い道のまま (issues 空)", () => {
    const result = recoverSigmaDocument(documentWithAssetSrc(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
    ));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.issues).toEqual([]);
    }
  });
});
