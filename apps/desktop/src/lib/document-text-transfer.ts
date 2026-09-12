import { pruneUnusedDocumentOverlayAssets, type SigmaDocument } from "@/features/document";

/**
 * 教材をテキストとして受け渡すための橋渡し。
 *
 * 「ファイルを保存して渡す / ファイルを選んで開く」しか無いと、チャットやメールへ
 * 教材を貼るだけの用途にファイルの往復が要る。ここは **クリップボードのテキスト 1 本**
 * で書き出し・取り込みを閉じるための、画面に依存しない判定だけを持つ。
 *
 * 取り込みの実体 (スキーマ復旧・タブを開く・ワークスペース保存) は
 * `EditorShell.importDocumentFile` が唯一の出典なので、ここは
 * 「貼られたテキストがどの形式か」を決めて File へ載せ替えるところまでで止める。
 */

/** 貼り付けテキストの見立て。 */
export type PastedDocumentText =
  /** SigmaDoc の JSON。`value` は `recoverSigmaDocument` へそのまま渡せる解析済みの値。 */
  | { kind: "sigmadoc"; text: string; value: unknown }
  /** TeX ソース。 */
  | { kind: "tex"; text: string }
  /** 空 (空白のみを含む)。 */
  | { kind: "empty" }
  /** JSON のつもりで書かれているが構文が壊れている。 */
  | { kind: "invalidJson"; text: string };

/** 教材 1 件をテキストにする。書き出し経路 (ファイル保存・テキストコピー) の唯一の出典。 */
export function serializeDocumentText(document: SigmaDocument): string {
  return JSON.stringify(pruneUnusedDocumentOverlayAssets(document), null, 2);
}

/**
 * 貼られたテキストの形式を決める。
 *
 * JSON か TeX かは拡張子ではなく本文の先頭で見分ける — テキストで受け渡す以上、
 * ファイル名は残っていない。`{` / `[` で始まっていれば JSON のつもりだと見なし、
 * 構文が壊れているときは TeX へ落とさず `invalidJson` として突き返す
 * (壊れた JSON を TeX として解釈すると「取り込めた」まま中身が別物になる)。
 */
export function classifyPastedDocumentText(input: string): PastedDocumentText {
  const text = input.replace(/^\uFEFF/, "").trim();
  if (text.length === 0) {
    return { kind: "empty" };
  }
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return { kind: "sigmadoc", text, value: JSON.parse(text) };
    } catch {
      return { kind: "invalidJson", text };
    }
  }
  return { kind: "tex", text };
}

/**
 * 貼り付けテキストを取り込み経路へ渡す File にする。
 *
 * `importDocumentFile` は拡張子で形式を判定するので、見立てに合う拡張子を必ず付ける。
 * `baseName` は取り込み後の教材名の既定値にもなる (JSON 側にタイトルがあればそちらが勝つ)。
 */
export function pastedDocumentFile(
  pasted: Extract<PastedDocumentText, { kind: "sigmadoc" | "tex" }>,
  baseName: string,
): File {
  const extension = pasted.kind === "tex" ? ".tex" : ".sigmadoc.json";
  return new File([pasted.text], `${baseName}${extension}`, {
    type: pasted.kind === "tex" ? "text/plain" : "application/json",
  });
}
