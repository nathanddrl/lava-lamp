/**
 * Qualité adaptative : une échelle de niveaux, du plus beau au plus léger. On descend
 * quand le framerate tient mal sous la cible, on remonte prudemment quand il y a de la
 * marge. Logique pure (pas de Three) : testée dans quality.test.ts.
 */

export interface QualityLevel {
  label: string;
  /** Plafond du pixel ratio (multiplié par… rien : borne de devicePixelRatio). */
  maxPixelRatio: number;
  /** Résolution de la grille du champ (x, z). */
  gridResolution: number;
  /** Pas maximum du raymarch. */
  steps: number;
  /** MSAA de la cible HDR. */
  samples: number;
  bloom: boolean;
}

export const QUALITY_LEVELS: readonly QualityLevel[] = [
  { label: 'ultra', maxPixelRatio: 2, gridResolution: 48, steps: 96, samples: 4, bloom: true },
  { label: 'haute', maxPixelRatio: 1.5, gridResolution: 48, steps: 96, samples: 4, bloom: true },
  { label: 'moyenne', maxPixelRatio: 1.25, gridResolution: 44, steps: 80, samples: 2, bloom: true },
  { label: 'basse', maxPixelRatio: 1, gridResolution: 40, steps: 64, samples: 0, bloom: true },
  { label: 'très basse', maxPixelRatio: 0.8, gridResolution: 36, steps: 56, samples: 0, bloom: true },
  { label: 'minimale', maxPixelRatio: 0.6, gridResolution: 32, steps: 48, samples: 0, bloom: false },
];

export interface AdaptiveQualityParams {
  enabled: boolean;
  /** Framerate visé ; en dessous de `downFps` on dégrade. */
  targetFps: number;
  downFps: number;
  /** Fenêtre de mesure (s) avant toute décision. */
  window: number;
  /** Durée stable à la cible avant d'essayer de remonter (s). */
  upDelay: number;
}

export const DEFAULT_ADAPTIVE_PARAMS: AdaptiveQualityParams = {
  enabled: true,
  targetFps: 60,
  downFps: 50,
  window: 1.5,
  upDelay: 8,
};

export class AdaptiveQuality {
  readonly params: AdaptiveQualityParams;
  level: number;
  /** Framerate mesuré sur la dernière fenêtre. */
  fps = 0;

  private windowTime = 0;
  private windowFrames = 0;
  private stableTime = 0;
  /** Niveau le plus haut à ne plus réessayer (il a déjà échoué), et jusqu'à quand. */
  private ceiling = 0;
  private ceilingUntil = 0;
  private clock = 0;
  private lastChangeWasUp = false;
  /** Dernière dégradation, à vérifier : a-t-elle fait remonter le framerate ? */
  private pendingDown: { fps: number; level: number } | null = null;
  /** Plancher temporaire : dégrader plus n'aide pas (vsync à 30 Hz, physique CPU). */
  private floor = QUALITY_LEVELS.length - 1;
  private floorUntil = 0;

  constructor(initialLevel = 1, params: Partial<AdaptiveQualityParams> = {}) {
    this.params = { ...DEFAULT_ADAPTIVE_PARAMS, ...params };
    this.level = clampLevel(initialLevel);
  }

  get current(): QualityLevel {
    return QUALITY_LEVELS[this.level]!;
  }

  /** Réinitialise la mesure (après une pause, un changement d'onglet…). */
  resetWindow(): void {
    this.windowTime = 0;
    this.windowFrames = 0;
    this.stableTime = 0;
  }

  /**
   * À appeler à chaque frame avec la durée réelle de la frame. Renvoie true si le
   * niveau a changé (l'appelant applique alors `current`).
   */
  frame(dt: number): boolean {
    if (!this.params.enabled || dt <= 0) return false;
    this.clock += dt;
    this.windowTime += dt;
    this.windowFrames++;
    if (this.windowTime < this.params.window) return false;

    this.fps = this.windowFrames / this.windowTime;
    const elapsed = this.windowTime;
    this.windowTime = 0;
    this.windowFrames = 0;

    if (this.pendingDown) {
      const before = this.pendingDown;
      this.pendingDown = null;
      // Moins de 5 % de mieux : le GPU n'était pas le goulot. On rend la qualité et on
      // s'interdit de redescendre sous ce niveau pendant une minute.
      if (this.fps < before.fps * 1.05 + 0.5) {
        this.level = before.level;
        this.floor = before.level;
        this.floorUntil = this.clock + 60;
        this.stableTime = 0;
        return true;
      }
    }

    const maxLevel = this.clock < this.floorUntil ? this.floor : QUALITY_LEVELS.length - 1;
    if (this.fps < this.params.downFps && this.level < maxLevel) {
      // Si on vient de monter et que ça ne tient pas : ce niveau est interdit un moment.
      if (this.lastChangeWasUp) {
        this.ceiling = this.level + 1;
        this.ceilingUntil = this.clock + 60;
      }
      this.pendingDown = { fps: this.fps, level: this.level };
      this.level++;
      this.lastChangeWasUp = false;
      this.stableTime = 0;
      return true;
    }

    // « À la cible » : à 2 fps près (vsync, gigue de rAF).
    if (this.fps >= this.params.targetFps - 2) this.stableTime += elapsed;
    else this.stableTime = 0;

    const minLevel = this.clock < this.ceilingUntil ? this.ceiling : 0;
    if (this.stableTime >= this.params.upDelay && this.level > minLevel) {
      this.level--;
      this.lastChangeWasUp = true;
      this.stableTime = 0;
      return true;
    }
    return false;
  }
}

function clampLevel(l: number): number {
  return Math.max(0, Math.min(QUALITY_LEVELS.length - 1, Math.round(l)));
}
