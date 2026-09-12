import type { HTMLAttributes, ReactNode } from "react";

import styles from "./Layout.module.css";

export const SPACE_TOKENS = ["none", "xs", "sm", "md", "lg", "xl", "2xl", "3xl", "4xl"] as const;

export type SpaceToken = (typeof SPACE_TOKENS)[number];
type LayoutElement = "div" | "section" | "main" | "aside" | "header" | "footer" | "nav" | "ul" | "ol";
type LayoutAlign = "start" | "center" | "end" | "stretch" | "baseline";
type LayoutJustify = "start" | "center" | "end" | "between";

interface LayoutBaseProps extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  as?: LayoutElement;
  children?: ReactNode;
}

interface FlowProps extends LayoutBaseProps {
  gap?: SpaceToken;
  align?: LayoutAlign;
  justify?: LayoutJustify;
}

function joinClasses(...classes: Array<string | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

/**
 * 縦方向の並びと兄弟要素間の余白だけを管理するレイアウトプリミティブ。
 * 色や境界線などの見た目は持たず、業務コンポーネント側へ委ねる。
 */
export function Stack({ as: Element = "div", className, gap = "sm", align = "stretch", justify = "start", ...props }: FlowProps) {
  return (
    <Element
      className={joinClasses(styles.stack, className)}
      data-gap={gap}
      data-align={align}
      data-justify={justify}
      {...props}
    />
  );
}

/**
 * 横方向の配置、折り返し、整列を共通トークンで管理するプリミティブ。
 * ツールバーやラベルと操作の行を同じリズムへ揃えるために使う。
 */
export function Inline({
  as: Element = "div",
  className,
  gap = "sm",
  align = "center",
  justify = "start",
  wrap = false,
  ...props
}: FlowProps & { wrap?: boolean }) {
  return (
    <Element
      className={joinClasses(styles.inline, className)}
      data-gap={gap}
      data-align={align}
      data-justify={justify}
      data-wrap={wrap}
      {...props}
    />
  );
}

/**
 * カード、パネル、入力面の内側余白を外側レイアウトから分離するプリミティブ。
 * 任意のpx値を受け取らず、デザインシステムのスペーシングだけを許可する。
 */
export function Inset({ as: Element = "div", className, space = "lg", ...props }: LayoutBaseProps & { space?: SpaceToken }) {
  return <Element className={joinClasses(styles.inset, className)} data-space={space} {...props} />;
}

/**
 * 集中画面やモーダルの主役を中央へ置き、最大幅と画面端ガターを統一する。
 * 内容の縦方向レイアウトは持たないため、必要に応じてStackと組み合わせる。
 */
export function Center({
  as: Element = "div",
  className,
  size = "md",
  gutter = "2xl",
  ...props
}: LayoutBaseProps & { size?: "sm" | "md" | "lg" | "xl"; gutter?: "none" | "lg" | "2xl" }) {
  return <Element className={joinClasses(styles.center, className)} data-size={size} data-gutter={gutter} {...props} />;
}

/**
 * 同種の項目を規則的な列へ並べるプリミティブ。
 * 狭い画面で一列へ戻す責務までを持ち、カード固有の装飾は持たない。
 */
export function Grid({
  as: Element = "div",
  className,
  columns = 2,
  gap = "sm",
  responsive = true,
  ...props
}: LayoutBaseProps & { columns?: 1 | 2 | 3 | 4; gap?: SpaceToken; responsive?: boolean }) {
  return (
    <Element
      className={joinClasses(styles.grid, className)}
      data-columns={columns}
      data-gap={gap}
      data-responsive={responsive}
      {...props}
    />
  );
}
