import { z } from "zod";

import { InlineNodeSchema, RichBlockSchema, SIGMA_BLOCK_SCHEMA_MEMBERS } from "@/lib/sigma-doc-schema";

/**
 * tools/list の JSON Schema で、1つのツールの中に何度も現れる部品を1回だけ定義させる。
 *
 * MCP SDK は各ツールの zod スキーマを `toJSONSchema` (draft-07、既定の `globalRegistry`) で
 * 変換する。zod は再帰 (`z.lazy`) の部品だけを `definitions` へ出し、再帰でない共有部品は
 * 使う場所ごとに展開するので、本文ブロックの部品や3Dグラフの部品が同じツールの中で
 * 数十回複製されていた。`globalRegistry` で `id` を持つスキーマは、そのツールの
 * `definitions` へ1回だけ出て、使う場所は `#/definitions/<id>` への `$ref` になる
 * (再帰ブロックの既存の出し方と同じ系統)。`definitions` はツールごとに自己完結し、
 * ツールをまたいだ参照はない。
 *
 * `id` は公開用の名前付けだけで、受け付ける入力と検証の挙動は変えない。
 * MCP サーバー内で定義するスキーマは定義時に `.meta({ id })` を付ける。文書の正本スキーマ
 * (`lib/sigma-doc-schema`) は画面・公開パッケージと共有するので、そのファイルには書かず、
 * MCP サーバーの起動時に同じインスタンスへ名前を付ける。
 */
export function registerMcpSchemaDefinitions(): void {
  nameSchema(InlineNodeSchema, "InlineNode");
  nameSchema(RichBlockSchema, "RichBlock");
  for (const member of SIGMA_BLOCK_SCHEMA_MEMBERS) {
    nameSchema(member, blockDefinitionId(member));
  }
}

function nameSchema(schema: z.ZodType, id: string): void {
  // `register` は複製を作らずにこのインスタンスへ登録する (`.meta()` は複製を返す)。
  // 既存のメタデータ (description など) は残す。
  schema.register(z.globalRegistry, { ...z.globalRegistry.get(schema), id });
}

/** `paragraph` → `ParagraphNode`。ブロック種別の `type` リテラルから名前を決める。 */
function blockDefinitionId(member: z.ZodType): string {
  const target = member instanceof z.ZodLazy ? member.unwrap() : member;
  const type = target instanceof z.ZodObject ? target.shape.type : undefined;
  if (!(type instanceof z.ZodLiteral) || typeof type.value !== "string") {
    throw new Error("SigmaDoc block schema member must have a string type literal.");
  }
  return `${type.value.charAt(0).toUpperCase()}${type.value.slice(1)}Node`;
}
