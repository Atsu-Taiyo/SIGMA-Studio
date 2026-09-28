import type { TikzImageSource } from "@/features/document";

export interface TikzRenderResult {
  src: string;
  width: number;
  height: number;
}

export type TikzRenderResponse =
  | { ok: true; image: TikzRenderResult }
  | { ok: false; error: string };

export interface TikzRenderAPI {
  render(input: TikzImageSource): Promise<TikzRenderResponse>;
}

export const OPEN_TIKZ_EDITOR_EVENT = "sigma:open-tikz-editor";
