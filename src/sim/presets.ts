import type { WaxParams } from './waxSystem';

/** Pas fixe de la simulation (s). La cire est lente : 60 Hz × 2 sous-pas suffisent. */
export const SIM_FIXED_DT = 1 / 60;

export type PresetName = 'équilibré' | 'calme' | 'agité';

/** Variantes thermiques, appliquées par-dessus DEFAULT_WAX_PARAMS (= « équilibré »). */
export const WAX_PRESETS: Record<PresetName, Partial<WaxParams>> = {
  'équilibré': {},
  // Chauffe plus douce, liquide plus visqueux : montées plus longues, plus rares.
  calme: { heatRate: 1.8, drag: 80 },
  // Chauffe forte, traînée et cohésion plus faibles : colonnes fréquentes, gouttes plus petites.
  'agité': { heatRate: 3.5, drag: 45, cohesion: 0.4 },
};

export const DEFAULT_PRESET: PresetName = 'équilibré';
