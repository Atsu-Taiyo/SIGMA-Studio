import type { CSSProperties, ReactNode } from "react";

import styles from "./MarkdownTable.module.css";

export type MarkdownTableAlign = "left" | "center" | "right" | null;

export interface MarkdownTableProps {
  /** 見出し行のセル。列の数はここで決まる。 */
  header: readonly ReactNode[];
  /** 本文の行。足りないセルは空欄にし、余るセルは捨てる。 */
  rows: readonly (readonly ReactNode[])[];
  /** 列ごとの寄せ。省略した列は左寄せ。 */
  alignments?: readonly MarkdownTableAlign[];
}

/**
 * 文章に含まれる表を、静かな罫と見出し行だけで見せる。Markdownの解析やセルの中身
 * (数式・太字など)の描画は呼び出し側が済ませて渡す。SigmaDocの表(tableShape)は
 * ここでは扱わない。
 */
export function MarkdownTable({ header, rows, alignments = [] }: MarkdownTableProps) {
  const alignStyle = (column: number): CSSProperties | undefined => {
    const align = alignments[column];
    return align ? { textAlign: align } : undefined;
  };
  return (
    <div className={styles.wrap} data-markdown-table="">
      <table className={styles.table}>
        <thead>
          <tr>
            {header.map((cell, column) => (
              <th key={column} className={`${styles.cell} ${styles.head}`} style={alignStyle(column)}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {header.map((_, column) => (
                <td key={column} className={styles.cell} style={alignStyle(column)}>{row[column] ?? null}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
