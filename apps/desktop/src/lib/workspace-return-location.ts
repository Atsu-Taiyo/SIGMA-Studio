/**
 * 編集画面からワークスペース画面へ戻るときの行き先。
 *
 * ワークスペース画面は、何も指定しなければ「編集中の教材があるワークスペース」を開く
 * (台帳の activeWorkspaceId は保存のたびに開いている教材へ追従する)。そのため、
 * 教材を削除して別の教材へ切り替わったあとなどは、直前まで見ていたワークスペースとは
 * 違う場所へ戻ってしまう。ワークスペース画面で最後に見ていた場所をウィンドウごと
 * (sessionStorage) に覚えておき、戻るときにそこを指定する。
 *
 * 覚えた場所が消えていても、ワークスペース画面は見つからない ID を無視して既定の
 * ワークスペースを開くので、ここでは存在確認をしない。
 */

export interface WorkspaceReturnLocation {
  workspaceId: string;
  folderId: string | null;
}

const STORAGE_KEY = "sigma-studio:workspace-return-location";

export function rememberWorkspaceReturnLocation(location: WorkspaceReturnLocation): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(location));
  } catch {
    // 保存できない環境では、従来どおり編集中の教材のワークスペースへ戻る。
  }
}

export function readWorkspaceReturnLocation(): WorkspaceReturnLocation | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { workspaceId, folderId } = parsed as Record<string, unknown>;
    if (typeof workspaceId !== "string" || !workspaceId) return null;
    return { workspaceId, folderId: typeof folderId === "string" && folderId ? folderId : null };
  } catch {
    return null;
  }
}

/** navigateToAppRoute("/workspace", ...) に渡す検索条件。覚えていなければ指定しない。 */
export function workspaceReturnSearch(): Record<string, string> | undefined {
  const location = readWorkspaceReturnLocation();
  if (!location) return undefined;
  return location.folderId
    ? { workspaceId: location.workspaceId, folderId: location.folderId }
    : { workspaceId: location.workspaceId };
}

/*
 * 編集画面のタブ一覧 (ウィンドウごと)。ワークスペース画面はこれを見て
 * 「編集画面に戻る」ボタンと、開いている教材の「編集中」表示を出す。
 * 空の配列は「編集画面のタブを全部閉じた (最後の教材を削除した)」を表し、
 * 次に教材を開くときは保存済みのタブを復元せず、その教材だけで始める。
 */
const EDITOR_TABS_KEY = "sigma-studio:editor-open-file-ids";

export function rememberEditorOpenFileIds(fileIds: readonly string[]): void {
  try {
    window.sessionStorage.setItem(EDITOR_TABS_KEY, JSON.stringify(fileIds));
  } catch {
    // 保存できない環境では、戻るボタンと編集中の表示を出さないだけ。
  }
}

/** 記録そのもの (useSyncExternalStore の snapshot 用に文字列のまま返す)。 */
export function editorOpenFileIdsSnapshot(): string | null {
  try {
    return window.sessionStorage.getItem(EDITOR_TABS_KEY);
  } catch {
    return null;
  }
}

/** 記録が無ければ null (このウィンドウでまだ編集画面を開いていない)。 */
export function readEditorOpenFileIds(raw = editorOpenFileIdsSnapshot()): string[] | null {
  try {
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return null;
  }
}
