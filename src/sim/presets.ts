import type { WaxParams } from './waxSystem';

/** Pas fixe de la simulation (s). La cire est lente : 60 Hz × 2 sous-pas suffisent. */
export const SIM_FIXED_DT = 1 / 60;

export type PresetName = 'équilibré' | 'calme' | 'agité';

/** Variantes thermiques, appliquées par-dessus DEFAULT_WAX_PARAMS (= « équilibré »). */
export const WAX_PRESETS: Record<PresetName, Partial<WaxParams>> = {
  'équilibré': {},
  // Flottabilité plus faible : montées plus lentes, gouttes un peu plus grosses et deux
  // fois plus rares ; fusion un peu plus lente pour ne pas retomber dans le jet continu.
  // Attention : plus de chauffe ou plus de traînée ramènent la colonne permanente.
  calme: { buoyancy: 50, meltDelay: 2.75 },
  // Flottabilité et échange par le verre plus forts : départs fréquents et irréguliers,
  // gouttes plus petites, têtes qui redescendent parfois avant le capuchon.
  'agité': { buoyancy: 70, wallCooling: 15 },
};

export const DEFAULT_PRESET: PresetName = 'équilibré';
