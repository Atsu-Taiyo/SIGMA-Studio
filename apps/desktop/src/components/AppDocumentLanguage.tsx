"use client";

import { useEffect } from "react";

import { useAppLocale } from "@/lib/i18n/react";

/**
 * `app/layout.tsx` の `<html lang="ja">` を実際の表示言語へ追随させる。
 *
 * `output: "export"` により `<html>` はビルド時に日本語で焼かれるので、正しい言語を
 * 差すのはクライアントの仕事になる。**ハイドレーション後の effect** でだけ書き換えるのが
 * 肝で、モジュール評価時に書くと焼かれた markup と `<html>` の属性が食い違う。
 *
 * ここを layout に置くのは、SDK 組み込み (`packages/editor`) がこの layout を通らない
 * ため。ホストページの `<html lang>` を勝手に塗り替えないという境界がこれで決まる。
 */
export function AppDocumentLanguage() {
  const locale = useAppLocale();

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return null;
}
