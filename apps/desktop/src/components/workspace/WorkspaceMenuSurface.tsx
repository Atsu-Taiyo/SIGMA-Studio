"use client";
import { useEffect, useRef, type HTMLAttributes } from "react";

/** Keyboard focus stays inside an open action menu and returns to its trigger. */
export function WorkspaceMenuSurface({ children, ...props }: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => { if (trigger?.isConnected) trigger.focus({ preventScroll: true }); };
  }, []);
  return <div {...props} ref={ref} role="menu" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>{children}</div>;
}
