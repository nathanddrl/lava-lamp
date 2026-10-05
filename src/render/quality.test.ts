import { describe, expect, it } from 'vitest';
import { AdaptiveQuality, QUALITY_LEVELS } from './quality';

/** Fait tourner `seconds` secondes à `fps` images par seconde ; renvoie les changements. */
function run(q: AdaptiveQuality, fps: number | ((level: number) => number), seconds: number): number {
  let changes = 0;
  let t = 0;
  while (t < seconds) {
    const f = typeof fps === 'number' ? fps : fps(q.level);
    if (q.frame(1 / f)) changes++;
    t += 1 / f;
  }
  return changes;
}

describe('AdaptiveQuality', () => {
  it('reste au niveau courant à 60 fps', () => {
    const q = new AdaptiveQuality(1, { upDelay: 1000 });
    run(q, 60, 10);
    expect(q.level).toBe(1);
  });

  it('dégrade quand le GPU ne suit pas, jusqu’à tenir la cible', () => {
    const q = new AdaptiveQuality(0);
    // Chaque niveau en dessous gagne 8 fps : 30 fps à l'ultra, 54 (≥ 50) au niveau 3.
    run(q, (l) => Math.min(60, 30 + 8 * l), 20);
    expect(q.level).toBe(3);
  });

  it('annule une dégradation qui ne fait pas remonter le framerate (vsync 30 Hz)', () => {
    const q = new AdaptiveQuality(1);
    run(q, 30, 20);
    expect(q.level).toBe(1);
  });

  it('remonte quand il y a de la marge, sans osciller sur un niveau qui a échoué', () => {
    const q = new AdaptiveQuality(3, { upDelay: 2 });
    // Le niveau 1 décroche (40 fps), le 2 tient (60).
    const fps = (l: number) => (l <= 1 ? 40 : 60);
    run(q, fps, 30);
    expect(q.level).toBe(2);
    // Le niveau qui a échoué n'est pas réessayé pendant la minute qui suit.
    expect(run(q, fps, 25)).toBe(0);
  });

  it('ne sort jamais de l’échelle', () => {
    const q = new AdaptiveQuality(QUALITY_LEVELS.length - 1);
    run(q, (l) => 10 + l, 20);
    expect(q.level).toBeLessThan(QUALITY_LEVELS.length);
    expect(q.level).toBeGreaterThanOrEqual(0);
  });
});
