/**
 * Starter library contract.
 *
 * A small set of ready clips ships with the plugin so a game can get sound
 * before, or without, a generation credential. It is deliberately not a
 * browsable asset library: there is no UI entry and no search parameters, only
 * a flat catalog the Agent lists and copies from. Anything a game actually
 * plays lives in that game's `assets/audio/`, never referenced out of the
 * plugin directory.
 */

export type StarterKind = 'sfx' | 'bgm';

export interface StarterEntry {
  /** Stable pick id, e.g. `sfx/ui/common-click-00`. */
  id: string;
  kind: StarterKind;
  /** Semantic folder with the delivery batch's ordering prefix stripped. */
  category: string;
  /** What the clip is for, in the curator's words. */
  usage: string;
  /** Path under `library/starter/`. */
  file: string;
  mime?: string;
  bytes?: number;
  durationMs?: number;
  /** Whether the clip is meant to be wired as a looping sound. */
  loop?: boolean;
  /** Ambience bed. Belongs on a scene loop, never on impact / pickup / ui. */
  ambient?: boolean;
  /**
   * Short enough for events that fire constantly (impact, pickup, ui, footstep).
   * False means the tail will pile up on itself — use it for rare beats only.
   */
  highFrequencySafe?: boolean;
  /** True when the source batch verified the loop point as seamless. */
  seamlessLoop?: boolean;
  mood?: string[];
  energy?: string;
  world?: string;
  /** Id in the delivery batch, kept so a clip can be traced to its review. */
  sourceAssetId?: string;
}

export interface StarterIndex {
  version: 1;
  entries: StarterEntry[];
}

/** Game-side assetId for a picked clip. Stable, so re-picking is idempotent. */
export function starterAssetId(id: string): string {
  return `starter-${id.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;
}
