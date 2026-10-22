import { createDocumentFromTemplate } from "@/lib/templates";
import { createDocumentFromSigmaDocument, type DocumentFileRecord } from "@/lib/storage";
import type { TemplateItem } from "@/types/template";
import type { NewMaterialLocation } from "./new-material-destination";

/**
 * テンプレートから新しい教材のファイルを作る (エディタの「テンプレートから新規」)。
 *
 * ワークスペース画面の「テンプレートから新規」と同じく、テンプレートの教材 (`createDocumentFromTemplate`) を
 * そのまま新しいファイルにする。用紙設定・余白・ヘッダー/フッター・背景・図形は、テンプレートの値のまま入る
 * (開いている教材や「直前の教材の用紙設定」は混ぜない)。作成先は `new-material-destination.ts` が決めた場所で、
 * テンプレートを保存したワークスペースは使わない。`location` が無いときは保存先の既定に任せる。
 */
export function createMaterialFromTemplate(
  template: TemplateItem,
  location?: NewMaterialLocation,
): Promise<DocumentFileRecord> {
  return createDocumentFromSigmaDocument(createDocumentFromTemplate(template), location);
}
