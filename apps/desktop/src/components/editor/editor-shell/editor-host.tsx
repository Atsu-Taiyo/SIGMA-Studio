"use client";
import { createContext, useContext, useState, type ReactNode } from "react";
import type { EditorHostServices } from "./editor-host-contracts";
import { DEFAULT_EDITOR_HOST } from "./editor-host-defaults";

const EditorHostContext = createContext<EditorHostServices>(DEFAULT_EDITOR_HOST);

/** Supply stable services for this editor's entire mounted lifetime. */
export function EditorHostProvider({ services, children }: { services: EditorHostServices; children: ReactNode }) {
  // A different host may have a different hook implementation. Switch only by remounting.
  const [mountedServices] = useState(() => services);
  return <EditorHostContext.Provider value={mountedServices}>{children}</EditorHostContext.Provider>;
}

export function useEditorHost(): EditorHostServices {
  return useContext(EditorHostContext);
}
