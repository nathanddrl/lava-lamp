import * as THREE from 'three';

/** Palette cire / liquide / ampoule. Couleurs en hexadécimal sRGB (comme lil-gui). */
export interface Theme {
  /** Libellé affiché. */
  label: string;
  waxColor: string;
  waxHotColor: string;
  waxDeepColor: string;
  liquidColor: string;
  bulbColor: string;
  /** Densité optique du liquide : un liquide sombre ou saturé est plus dense. */
  liquidDensity: number;
  /** Couleur du halo projeté sur la table. */
  haloColor: string;
}

export const THEMES = {
  classique: {
    label: 'Classique',
    waxColor: '#e2381a',
    waxHotColor: '#ff7a24',
    waxDeepColor: '#ff5418',
    liquidColor: '#ffbe45',
    bulbColor: '#ffe0bc',
    liquidDensity: 0.45,
    haloColor: '#ff8a3a',
  },
  ocean: {
    label: 'Océan',
    waxColor: '#e8eef8',
    waxHotColor: '#fff4e6',
    waxDeepColor: '#cfe6ff',
    liquidColor: '#2f7dff',
    bulbColor: '#ffd2a0',
    liquidDensity: 0.6,
    haloColor: '#3d7dff',
  },
  neon: {
    label: 'Néon',
    waxColor: '#ff2a8a',
    waxHotColor: '#ff6fc8',
    waxDeepColor: '#ff3fae',
    liquidColor: '#8a46ff',
    bulbColor: '#ffb8c8',
    liquidDensity: 0.55,
    haloColor: '#c03cff',
  },
  absinthe: {
    label: 'Absinthe',
    waxColor: '#9be22a',
    waxHotColor: '#e6ff6a',
    waxDeepColor: '#b6ff3c',
    liquidColor: '#21c9a0',
    bulbColor: '#fff0b0',
    liquidDensity: 0.5,
    haloColor: '#5ee28a',
  },
  crepuscule: {
    label: 'Crépuscule',
    waxColor: '#6a2cff',
    waxHotColor: '#b07aff',
    waxDeepColor: '#9a4bff',
    liquidColor: '#ff7a3c',
    bulbColor: '#ffb070',
    liquidDensity: 0.5,
    haloColor: '#ff6a3c',
  },
} satisfies Record<string, Theme>;

export type ThemeName = keyof typeof THEMES;
export const DEFAULT_THEME: ThemeName = 'classique';
export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

type ColorKey = 'waxColor' | 'waxHotColor' | 'waxDeepColor' | 'liquidColor' | 'bulbColor' | 'haloColor';
const COLOR_KEYS: readonly ColorKey[] = ['waxColor', 'waxHotColor', 'waxDeepColor', 'liquidColor', 'bulbColor', 'haloColor'];

/** Ce que le blender écrit : les mêmes champs qu'un thème, sans le libellé. */
export type ThemeTarget = Record<ColorKey, string> & { liquidDensity: number };

/**
 * Transition douce d'un thème à l'autre : interpolation en espace linéaire (pas en sRGB,
 * qui passerait par des teintes ternes), courbe smoothstep sur `duration` secondes.
 * N'écrit dans la cible que pendant une transition : les réglages du panneau de debug
 * restent libres le reste du temps.
 */
export class ThemeBlender {
  /** Durée d'une transition (s). */
  duration = 1.6;
  current: ThemeName;

  private readonly from = new Map<ColorKey, THREE.Color>();
  private readonly to = new Map<ColorKey, THREE.Color>();
  private readonly tmp = new THREE.Color();
  private fromDensity = 0;
  private toDensity = 0;
  private t = 1;

  constructor(initial: ThemeName = DEFAULT_THEME) {
    this.current = initial;
    for (const k of COLOR_KEYS) {
      this.from.set(k, new THREE.Color());
      this.to.set(k, new THREE.Color());
    }
  }

  /** Applique un thème immédiatement. */
  apply(target: ThemeTarget, name: ThemeName): void {
    this.current = name;
    const theme = THEMES[name];
    for (const k of COLOR_KEYS) target[k] = theme[k];
    target.liquidDensity = theme.liquidDensity;
    this.t = 1;
  }

  /** Démarre une transition depuis l'état actuel de la cible. */
  start(target: ThemeTarget, name: ThemeName): void {
    this.current = name;
    const theme = THEMES[name];
    for (const k of COLOR_KEYS) {
      this.from.get(k)!.set(target[k]);
      this.to.get(k)!.set(theme[k]);
    }
    this.fromDensity = target.liquidDensity;
    this.toDensity = theme.liquidDensity;
    this.t = 0;
  }

  get transitioning(): boolean {
    return this.t < 1;
  }

  update(target: ThemeTarget, dt: number): void {
    if (this.t >= 1) return;
    this.t = Math.min(1, this.t + dt / Math.max(1e-3, this.duration));
    const s = this.t * this.t * (3 - 2 * this.t);
    for (const k of COLOR_KEYS) {
      target[k] = `#${this.tmp.lerpColors(this.from.get(k)!, this.to.get(k)!, s).getHexString()}`;
    }
    target.liquidDensity = this.fromDensity + (this.toDensity - this.fromDensity) * s;
  }
}
