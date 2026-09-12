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

/**
 * 日本語辞書 = 全キーの SSoT。英語辞書はここから型を導出するので、
 * 新しいキーは必ずこちら側から生やす。
 *
 * namespace は 12 個で、i18n 移行の 12 の WI と 1:1 に対応する。
 */
export const ja = {
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
