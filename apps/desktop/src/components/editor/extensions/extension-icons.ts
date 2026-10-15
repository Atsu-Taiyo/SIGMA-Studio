import { BookOpen, Download, FileInput, FileText, FolderOpen, Image as ImageIcon, Puzzle, Sparkles, Table, Upload, type LucideIcon } from "lucide-react";

import type { ExtensionIconName } from "@/lib/extension-contracts";

/** 拡張機能がメニューのボタンに選べるアイコン。アプリが持つ固定の集合だけで、任意の画像は描かない。 */
export const EXTENSION_ICON_COMPONENTS: Record<ExtensionIconName, LucideIcon> = {
  "file-input": FileInput,
  "folder-open": FolderOpen,
  download: Download,
  upload: Upload,
  sparkles: Sparkles,
  puzzle: Puzzle,
  "file-text": FileText,
  image: ImageIcon,
  table: Table,
  "book-open": BookOpen,
};
