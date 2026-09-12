import { ai } from "./ai";
import { chrome } from "./chrome";
import { command } from "./command";
import { common } from "./common";
import { editor } from "./editor";
import { error } from "./error";
import { print } from "./print";
import { prompt } from "./prompt";
import { settings } from "./settings";
import { shape } from "./shape";
import { tex } from "./tex";
import { workspace } from "./workspace";

/** 英語辞書。各 namespace が `satisfies TranslationsOf<typeof ja>` で網羅性を型検査済み。 */
export const en = {
  ai,
  chrome,
  command,
  common,
  editor,
  error,
  print,
  prompt,
  settings,
  shape,
  tex,
  workspace,
} as const;
