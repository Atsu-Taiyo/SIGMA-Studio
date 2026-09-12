/** 教材本体と履歴 sidecar で共通の、パス区切りを許可しない永続 fileId。 */
export function isValidDocumentFileId(value: string): boolean {
  return /^file_[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(value);
}
