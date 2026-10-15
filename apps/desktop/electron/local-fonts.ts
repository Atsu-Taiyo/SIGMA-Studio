import type { IpcMainInvokeEvent, WebContents } from "electron";

import type { LocalFontFace } from "@/lib/local-font-contracts";

import { isTrustedMainSender } from "./trusted-ipc";

const MAX_FACES = 8192;
const MAX_FIELD_LENGTH = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
/** 一覧は書体メニューを開く・ウィンドウに戻るたびに頼まれる。続けて来た分は同じ結果で返す。 */
const CACHE_MS = 2_000;

/**
 * このPCにインストールされている書体の「名前だけ」の一覧。書体メニューを、実際に表示できる書体に合わせるために使う。
 *
 * メインウィンドウの `queryLocalFonts` (Local Font Access) で読む。書体のバイト列には触らず、保存もアップロードもしない。
 * 権限は信頼できるメインウィンドウの最上位フレームにだけ許し、それ以外の権限は Electron の既定のまま
 * (ハンドラを置いた時点で既定の判断が消えないように、local-fonts 以外は従来どおり許可を返す)。
 * 読めないとき (非対応・失敗・0件) は `null` を返し、画面側は固定のメニューに戻る。空の一覧を返すと、
 * 「何も入っていない」と受け取られて、メニューの書体がすべて消えてしまうため。
 */
export class LocalFontService {
  private readonly sessions = new WeakSet<object>();
  private pending: Promise<LocalFontFace[] | null> | null = null;
  private cached: { at: number; faces: LocalFontFace[] | null } | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  private trusted(contents: WebContents | null | undefined): contents is WebContents {
    return Boolean(contents && !contents.isDestroyed()
      && isTrustedMainSender({ sender: contents, senderFrame: contents.mainFrame } as IpcMainInvokeEvent));
  }

  private prepare(contents: WebContents): void {
    if (this.sessions.has(contents.session)) return;
    const allowed = (sender: WebContents | null, permission: string, details?: { isMainFrame?: boolean }): boolean =>
      permission !== "local-fonts" || (details?.isMainFrame !== false && this.trusted(sender));
    contents.session.setPermissionCheckHandler((sender, permission, _origin, details) => allowed(sender, permission, details as { isMainFrame?: boolean }));
    contents.session.setPermissionRequestHandler((sender, permission, callback, details) => callback(allowed(sender, permission, details as { isMainFrame?: boolean })));
    this.sessions.add(contents.session);
  }

  async list(contents: WebContents): Promise<LocalFontFace[] | null> {
    if (!this.trusted(contents)) return null;
    if (this.cached && this.now() - this.cached.at < CACHE_MS) return this.cached.faces;
    this.pending ??= this.read(contents).finally(() => { this.pending = null; });
    return this.pending;
  }

  private async read(contents: WebContents): Promise<LocalFontFace[] | null> {
    let faces: LocalFontFace[] | null = null;
    try {
      this.prepare(contents);
      const rows: unknown = await contents.executeJavaScript(`(async () => {
        if (typeof queryLocalFonts !== 'function') return null;
        return (await queryLocalFonts()).map(({ family, fullName, postscriptName, style }) => ({ family, fullName, postscriptName, style }));
      })()`, true);
      const valid = (value: unknown): value is string => typeof value === "string" && value.length <= MAX_FIELD_LENGTH && !CONTROL_CHARACTERS.test(value);
      if (Array.isArray(rows) && rows.length > 0 && rows.length <= MAX_FACES
        && rows.every((row) => row && [row.family, row.fullName, row.postscriptName, row.style].every(valid))) {
        faces = rows.map(({ family, fullName, postscriptName, style }) => ({ family, fullName, postscriptName, style }));
      }
    } catch {
      faces = null;
    }
    this.cached = { at: this.now(), faces };
    return faces;
  }
}
