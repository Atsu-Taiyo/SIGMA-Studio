/**
 * サイドバーの「ファイル」に出す教材の木と検索。フォルダ→教材の親子と並び順、名前検索だけを
 * 決める純粋なモデルで、読み込み・表示・教材を開く操作は持たない。
 */

export interface FileTreeFolderInput {
  id: string;
  parentFolderId: string | null;
  name: string;
}

export interface FileTreeFileInput {
  fileId: string;
  folderId: string | null;
  title: string;
}

export type FileTreeNode =
  | { kind: "folder"; id: string; name: string; children: FileTreeNode[]; fileCount: number }
  | { kind: "file"; id: string; title: string; folderPath: string[] };

export interface FileTreeRow {
  node: FileTreeNode;
  depth: number;
}

// 「教材2」が「教材10」より前に来る日本語・数字混在の並び (ワークスペース一覧と同じ規則)。
const COLLATOR = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });

/** 全角/半角・大文字小文字の違いで検索に漏れないよう揃える。 */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim();
}

/** 親をたどると自分に戻ってくるフォルダ (壊れた台帳) は、消さずに最上位へ出す。 */
function detachCycles(folders: readonly FileTreeFolderInput[]): FileTreeFolderInput[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  return folders.map((folder) => {
    const seen = new Set<string>([folder.id]);
    for (let id = folder.parentFolderId; id && byId.has(id); id = byId.get(id)!.parentFolderId) {
      if (seen.has(id)) return { ...folder, parentFolderId: null };
      seen.add(id);
    }
    return folder;
  });
}

export function buildFileTree(
  inputFolders: readonly FileTreeFolderInput[],
  files: readonly FileTreeFileInput[],
  untitled: string,
): FileTreeNode[] {
  const folders = detachCycles(inputFolders);
  const folderIds = new Set(folders.map((folder) => folder.id));
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const pathOf = (folderId: string | null): string[] => {
    const path: string[] = [];
    const seen = new Set<string>();
    for (let id = folderId; id && byId.has(id) && !seen.has(id); id = byId.get(id)!.parentFolderId) {
      seen.add(id);
      path.unshift(byId.get(id)!.name);
    }
    return path;
  };
  const childrenOf = (parentId: string | null): FileTreeNode[] => {
    // 親が一覧に無い (壊れた参照) フォルダ・教材は、消さずに最上位へ置く。
    const isHere = (parent: string | null) => (parentId === null ? parent === null || !folderIds.has(parent) : parent === parentId);
    const folderNodes = folders
      .filter((folder) => folder.id !== parentId && isHere(folder.parentFolderId))
      .sort((a, b) => COLLATOR.compare(a.name, b.name))
      .map((folder): FileTreeNode => {
        const children = childrenOf(folder.id);
        return { kind: "folder", id: folder.id, name: folder.name, children, fileCount: countFiles(children) };
      });
    const fileNodes = files
      .filter((file) => isHere(file.folderId))
      .map((file): FileTreeNode => ({ kind: "file", id: file.fileId, title: file.title || untitled, folderPath: pathOf(file.folderId) }))
      .sort((a, b) => COLLATOR.compare((a as { title: string }).title, (b as { title: string }).title));
    return [...folderNodes, ...fileNodes];
  };
  return childrenOf(null);
}

function countFiles(nodes: readonly FileTreeNode[]): number {
  return nodes.reduce((sum, node) => sum + (node.kind === "file" ? 1 : node.fileCount), 0);
}

/** 展開中のフォルダの中身だけを、深さ付きで一列に並べる。 */
export function flattenVisibleRows(nodes: readonly FileTreeNode[], expanded: ReadonlySet<string>, depth = 0): FileTreeRow[] {
  return nodes.flatMap((node): FileTreeRow[] => (
    node.kind === "folder" && expanded.has(node.id)
      ? [{ node, depth }, ...flattenVisibleRows(node.children, expanded, depth + 1)]
      : [{ node, depth }]
  ));
}

/** 名前に検索語(空白区切り、すべて含む)が入る教材だけを、フォルダの階層なしで並べる。 */
export function searchFiles(nodes: readonly FileTreeNode[], query: string): FileTreeRow[] {
  const terms = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const rows: FileTreeRow[] = [];
  const visit = (list: readonly FileTreeNode[]) => {
    for (const node of list) {
      if (node.kind === "folder") visit(node.children);
      else {
        const haystack = normalizeSearchText([...node.folderPath, node.title].join(" "));
        if (terms.every((term) => haystack.includes(term))) rows.push({ node, depth: 0 });
      }
    }
  };
  visit(nodes);
  return rows;
}

/** 開いている教材を含むフォルダの id (最初に見せるとき展開しておく)。 */
export function ancestorFolderIds(
  folders: readonly FileTreeFolderInput[],
  folderId: string | null,
): string[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const ids: string[] = [];
  for (let id = folderId; id && byId.has(id) && !ids.includes(id); id = byId.get(id)!.parentFolderId) ids.push(id);
  return ids;
}
