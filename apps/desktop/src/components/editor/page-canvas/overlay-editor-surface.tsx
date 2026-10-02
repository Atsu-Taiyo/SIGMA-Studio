"use client";
import dynamic from "next/dynamic";

export const OverlayCanvasEditor = dynamic(() => import("../OverlayCanvasEditorClient"), {
  ssr: false,
  loading: () => <div className="overlay-canvas-loading" aria-hidden="true" />,
});

