import type {
  OverlaySnapshot,
  SigmaBlock,
} from "@/features/document";

export interface MaterialContent {
  blocks: SigmaBlock[];
  overlaySnapshot: OverlaySnapshot;
}

export interface MaterialUsage {
  useCases?: string[];
  avoidWhen?: string[];
  aliases?: string[];
}

export interface MaterialTransformPolicy {
  scale?: boolean;
  rotate?: boolean;
}

export interface MaterialPort {
  id: string;
  label?: string;
  x: number;
  y: number;
  kind?: "point" | "leftEnd" | "rightEnd" | "start" | "end" | "center";
}

export interface MaterialItem {
  version: 1;
  id: string;
  name: string;
  source?: "user" | "official";
  /** 短い用途説明。カードや/候補の副題に表示する。 */
  description?: string;
  /** 検索用タグ（用途・別名・「箱」「枠」など）。 */
  tags?: string[];
  /** AIが素材の使いどころを判断するための用途カード。 */
  usage?: MaterialUsage;
  /** 画像理解や図形部品検索で使う意味タグ。 */
  visualConcepts?: string[];
  /** 図に合わせた素材変形の許可範囲。 */
  transformPolicy?: MaterialTransformPolicy;
  /** バネの左右端など、他の部品へ合わせるための素材内基準点。 */
  ports?: MaterialPort[];
  content: MaterialContent;
  createdAt: string;
  updatedAt: string;
}
