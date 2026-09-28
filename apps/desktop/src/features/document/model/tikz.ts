/** The environment is snapshotted with each image so that it remains editable after copying. */
export interface TikzEnvironment {
  packages: string;
  libraries: string;
  preamble: string;
}

export interface TikzImageSource {
  source: string;
  environment: TikzEnvironment;
}
