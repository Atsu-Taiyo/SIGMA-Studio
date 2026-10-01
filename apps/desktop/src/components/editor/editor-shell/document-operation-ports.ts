"use client";

import { type DocumentBlockClock,type DocumentBlockIdFactory } from "@/features/document";
import { createId } from "@/lib/id";

export const DOCUMENT_BLOCK_OPERATION_PORTS: DocumentBlockClock & DocumentBlockIdFactory = {
  now: () => new Date().toISOString(),
  createId,
};
