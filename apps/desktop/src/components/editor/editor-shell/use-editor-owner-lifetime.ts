"use client";
import { useCallback,useEffect,useRef } from "react";

/** Capture a specific mounted lifetime before awaiting work. Strict Mode's
 * cleanup/setup cycle also invalidates work from the preceding lifetime. */
export function useEditorOwnerLifetime() {
  const active = useRef(true);
  const generation = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; generation.current += 1; };
  }, []);
  return useCallback(() => {
    const captured = generation.current;
    return () => active.current && generation.current === captured;
  }, []);
}
