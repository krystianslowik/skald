// World helpers: boss progress. Raid and boss names live in src/i18n.

export interface BossProgress {
  /** Valheim global key, e.g. `defeated_eikthyr`. */
  key: string;
  /** null until the agent can read global keys from the save. */
  defeated: boolean | null;
}

export const BOSSES: readonly BossProgress[] = [
  { key: "defeated_eikthyr", defeated: null },
  { key: "defeated_gdking", defeated: null },
  { key: "defeated_bonemass", defeated: null },
  { key: "defeated_dragon", defeated: null },
  { key: "defeated_goblinking", defeated: null },
  { key: "defeated_queen", defeated: null },
  { key: "defeated_fader", defeated: null },
];
