"use client";
import { createContext, useContext } from "react";
import type { DocumentSession } from "@/features/document-session/contracts";

export const DocumentSessionContext = createContext<DocumentSession | undefined>(undefined);
export const useDocumentSession = (): DocumentSession | undefined => useContext(DocumentSessionContext);

/** Editing authority is separate from session presence (for example after logout). */
export const DocumentWritableContext = createContext(true);
export const useDocumentWritable = (): boolean => useContext(DocumentWritableContext);
