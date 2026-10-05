import type { WaxParams } from './waxSystem';

/** Pas fixe de la simulation (s). La cire est lente : 60 Hz × 2 sous-pas suffisent. */
export const SIM_FIXED_DT = 1 / 60;

export type PresetName = 'équilibré' | 'calme' | 'agité';

/** Variantes thermiques, appliquées par-dessus DEFAULT_WAX_PARAMS (= « équilibré »). */
export const WAX_PRESETS: Record<PresetName, Partial<WaxParams>> = {
  'équilibré': {},
  // Flottabilité plus faible : montées plus lentes, gouttes plus grosses et deux fois plus
  // rares ; fusion plus lente pour ne pas retomber dans le jet continu. C'est le preset le
  // plus proche de la colonne permanente : ne pas y ajouter de chauffe ni de traînée.
  calme: { buoyancy: 50, meltDelay: 3 },
  // Flottabilité et échange par le verre plus forts : départs fréquents et irréguliers,
  // gouttes plus petites, têtes qui redescendent souvent avant le capuchon.
  'agité': { buoyancy: 70, wallCooling: 15, meltDelay: 2.5 },
};

export const DEFAULT_PRESET: PresetName = 'équilibré';
