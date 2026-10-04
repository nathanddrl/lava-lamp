import type { WaxParams } from './waxSystem';

/** Pas fixe de la simulation (s). La cire est lente : 60 Hz × 2 sous-pas suffisent. */
export const SIM_FIXED_DT = 1 / 60;

export type PresetName = 'équilibré' | 'calme' | 'agité';

/** Variantes thermiques, appliquées par-dessus DEFAULT_WAX_PARAMS (= « équilibré »). */
export const WAX_PRESETS: Record<PresetName, Partial<WaxParams>> = {
  'équilibré': {},
  // Pas d'échange par le verre (départs plus rares), traînée plus forte (montées plus
  // lentes), chauffe un peu relevée pour rester au-dessus du seuil de démarrage :
  // en dessous de ~4, le point chaud ne fond plus et tout se fige.
  calme: { wallCooling: 0, drag: 70, heatRate: 4.3 },
  // Chauffe et échange par le verre plus forts, flottabilité plus forte : départs
  // rapprochés et irréguliers, nombreuses fusions en vol.
  'agité': { heatRate: 4.5, wallCooling: 15, buoyancy: 70 },
};

export const DEFAULT_PRESET: PresetName = 'équilibré';
