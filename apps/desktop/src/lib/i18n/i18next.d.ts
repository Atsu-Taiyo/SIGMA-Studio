import type { ja } from "./dictionaries/ja";
import type { Widen } from "./dictionaries/types";

/**
 * 日本語辞書の形をそのまま i18next のキー型にする。これで `t()` の引数が
 * 実在するキーだけに絞られ、typo が `npm run typecheck` で落ちる。
 */
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    resources: Widen<typeof ja>;
    returnNull: false;
  }
}
