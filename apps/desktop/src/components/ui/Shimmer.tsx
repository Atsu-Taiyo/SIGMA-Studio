import type { CSSProperties, ReactNode } from "react";

type ShimmerVariant = "text" | "marker" | "surface" | "icon";

interface ShimmerProps {
  children?: ReactNode;
  className?: string;
  variant?: ShimmerVariant;
  style?: CSSProperties;
  title?: string;
}

export function Shimmer({
  children,
  className = "",
  variant = "text",
  style,
  title,
}: ShimmerProps) {
  const variantClass = variant === "surface"
    ? "ui-shimmer-surface"
    : variant === "icon"
      ? "ui-shimmer-icon"
      : variant === "marker"
        ? "ui-shimmer-marker"
        : "ui-shimmer-text";

  return (
    <span
      className={`${variantClass} ${className}`.trim()}
      style={style}
      title={title}
      aria-hidden={children ? undefined : true}
    >
      {children}
    </span>
  );
}