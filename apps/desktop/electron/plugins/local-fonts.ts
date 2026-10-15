import type { IpcMainInvokeEvent, WebContents } from "electron";

import { isTrustedMainSender } from "../trusted-ipc";
import { selectLocalFontFaces, type LocalFontFace } from "./font-selection";
import type { LocalFontBytes } from "./worker-runner";

const MAX_FACE_BYTES = 24 * 1024 * 1024;
const MAX_TOTAL_BYTES = 96 * 1024 * 1024;
const MAX_CATALOG_FACES = 8192;
const MAX_FIELD_LENGTH = 256;

/**
 * このPCに入っている書体の実体を、メインウィンドウの `queryLocalFonts` で読む。
 * 読むのは、拡張機能のワーカーが家族名で頼んだものだけ。バイト列はワーカーへ渡すだけで、
 * アップロードも保存もしない。権限の許可は信頼できるメインウィンドウの最上位フレームに限る。
 */
export class LocalFontReader {
  private readonly sessions = new WeakSet<object>();

  constructor(private readonly getMainContents: () => WebContents | null) {}

  private trusted(contents: WebContents | null): contents is WebContents {
    return Boolean(contents && !contents.isDestroyed()
      && isTrustedMainSender({ sender: contents, senderFrame: contents.mainFrame } as IpcMainInvokeEvent));
  }

  private prepare(contents: WebContents): void {
    if (this.sessions.has(contents.session)) return;
    const allowed = (sender: WebContents | null, permission: string, details?: { isMainFrame?: boolean }): boolean =>
      // local-fonts 以外は、これまでの既定の扱い (許可) を変えない。
      permission !== "local-fonts" || (details?.isMainFrame !== false && this.trusted(sender));
    contents.session.setPermissionCheckHandler((sender, permission, _origin, details) => allowed(sender, permission, details as { isMainFrame?: boolean }));
    contents.session.setPermissionRequestHandler((sender, permission, callback, details) => callback(allowed(sender, permission, details as { isMainFrame?: boolean })));
    this.sessions.add(contents.session);
  }

  private async listFaces(contents: WebContents): Promise<LocalFontFace[]> {
    const rows: unknown = await contents.executeJavaScript(`(async () => {
      if (typeof queryLocalFonts !== 'function') throw new Error('LOCAL_FONTS_UNAVAILABLE');
      return (await queryLocalFonts()).map(({family,fullName,postscriptName,style}) => ({family,fullName,postscriptName,style}));
    })()`, true);
    const valid = (value: unknown): value is string => typeof value === "string" && value.length <= MAX_FIELD_LENGTH && !/[\u0000-\u001f\u007f]/u.test(value);
    if (!Array.isArray(rows) || rows.length > MAX_CATALOG_FACES
      || !rows.every((row) => row && [row.family, row.fullName, row.postscriptName, row.style].every(valid))) throw new Error("INVALID_FONT_CATALOG");
    return rows as LocalFontFace[];
  }

  async readFamilies(families: string[], bundled: ReadonlySet<string>, ownPrefixes: readonly string[] = []): Promise<LocalFontBytes[]> {
    const contents = this.getMainContents();
    if (!this.trusted(contents)) throw new Error("LOCAL_FONTS_UNAVAILABLE");
    this.prepare(contents);
    const selected = selectLocalFontFaces(await this.listFaces(contents), families, bundled, ownPrefixes);
    const names = selected.map((face) => face.postscriptName);
    const rows: unknown = names.length ? await contents.executeJavaScript(`(async () => {
      const rows = await queryLocalFonts({postscriptNames:${JSON.stringify(names)}});
      const fonts = []; let total = 0;
      for (const font of rows) {
        const blob = await font.blob(); total += blob.size;
        if (blob.size > ${MAX_FACE_BYTES} || total > ${MAX_TOTAL_BYTES}) throw new Error('LOCAL_FONTS_TOO_LARGE');
        fonts.push({family:font.family, postscriptName:font.postscriptName, bytes:await blob.arrayBuffer()});
      }
      return fonts;
    })()`, true) : [];
    if (!Array.isArray(rows) || rows.length > 32 || !rows.every((row) => row && names.includes(row.postscriptName)
      && row.bytes instanceof ArrayBuffer && row.bytes.byteLength <= MAX_FACE_BYTES)) throw new Error("INVALID_LOCAL_FONTS");
    return rows.map((row) => ({ family: row.family as string, bytes: new Uint8Array(row.bytes as ArrayBuffer) }));
  }
}
