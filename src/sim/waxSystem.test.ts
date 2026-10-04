import { describe, expect, it } from 'vitest';
import { LampProfile } from './lampProfile';
import { SIM_FIXED_DT } from './presets';
import { Simulation } from './simulation';
import { NO_THERMAL_PARAMS } from './waxSystem';

const DT = SIM_FIXED_DT;

function run(sim: Simulation, seconds: number): void {
  const steps = Math.round(seconds / DT);
  for (let k = 0; k < steps; k++) sim.step(DT);
}

/** Tailles des amas (liens < 0.9 h), triées décroissantes. */
function clusters(sim: Simulation): number[] {
  const { positions: x, count: n } = sim.wax;
  const link = 0.9 * sim.wax.params.interactionRadius;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]!]!;
    return a;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d2 = (x[3 * i]! - x[3 * j]!) ** 2 + (x[3 * i + 1]! - x[3 * j + 1]!) ** 2 + (x[3 * i + 2]! - x[3 * j + 2]!) ** 2;
      if (d2 < link * link) parent[find(i)] = find(j);
    }
  }
  const sizes = new Map<number, number>();
  for (let i = 0; i < n; i++) sizes.set(find(i), (sizes.get(find(i)) ?? 0) + 1);
  return [...sizes.values()].sort((a, b) => b - a);
}

function stats(sim: Simulation) {
  const { positions: x, velocities: v, count: n } = sim.wax;
  const c = sim.container;
  let ke = 0;
  let yTop = -Infinity;
  let outside = 0;
  for (let i = 0; i < n; i++) {
    ke += v[3 * i]! ** 2 + v[3 * i + 1]! ** 2 + v[3 * i + 2]! ** 2;
    const y = x[3 * i + 1]!;
    expect(Number.isFinite(y)).toBe(true);
    yTop = Math.max(yTop, y);
    const r = Math.hypot(x[3 * i]!, x[3 * i + 2]!);
    if (y < c.yMin - 1e-4 || y > c.yMax + 1e-4 || r > c.innerRadius(Math.min(Math.max(y, c.yMin), c.yMax)) + 1e-4) outside++;
  }
  return { rmsSpeed: Math.sqrt(ke / n), yTop, outside };
}

describe('WaxSystem (Clavet 2005)', () => {
  it('forme au fond une masse compacte et calme, puis s\'étire, se scinde et refusionne après une impulsion', () => {
    const sim = new Simulation(new LampProfile(), NO_THERMAL_PARAMS);
    run(sim, 10);

    const rest = stats(sim);
    expect(rest.outside).toBe(0);
    expect(rest.rmsSpeed).toBeLessThan(0.02);
    expect(clusters(sim)[0]).toBeGreaterThanOrEqual(sim.wax.count - 2);
    expect(rest.yTop).toBeLessThan(sim.container.yMin + 0.5);

    sim.impulse();
    let maxTop = 0;
    let biggestDrop = 0;
    for (let t = 0; t < 4; t += 0.25) {
      run(sim, 0.25);
      maxTop = Math.max(maxTop, stats(sim).yTop);
      biggestDrop = Math.max(biggestDrop, clusters(sim)[1] ?? 0);
    }
    expect(maxTop).toBeGreaterThan(sim.container.yMin + 1.2);
    // Une goutte d'au moins 30 particules se détache de la masse.
    expect(biggestDrop).toBeGreaterThanOrEqual(30);

    run(sim, 8);
    const after = stats(sim);
    expect(after.outside).toBe(0);
    expect(after.rmsSpeed).toBeLessThan(0.02);
    expect(clusters(sim)[0]).toBeGreaterThanOrEqual(sim.wax.count - 2);
  }, 60_000);

  it('cycle thermique (preset par défaut) : la cire monte, redescend, le réservoir reste', () => {
    const sim = new Simulation(new LampProfile());
    const { yMin, yMax } = sim.container;
    const H = yMax - yMin;
    let reachedHigh = 0;
    let minReservoir = 1;
    let maxReservoir = 0;
    for (let t = 0; t < 150; t += 5) {
      run(sim, 5);
      const { positions: x, temperatures: T, count: n } = sim.wax;
      let bottom = 0;
      for (let i = 0; i < n; i++) {
        expect(T[i]).toBeGreaterThanOrEqual(0);
        expect(T[i]).toBeLessThanOrEqual(1);
        const y = x[3 * i + 1]!;
        if (y < yMin + 0.2 * H) bottom++;
        if (y > yMin + 0.6 * H) reachedHigh++;
      }
      if (t >= 60) {
        minReservoir = Math.min(minReservoir, bottom / n);
        maxReservoir = Math.max(maxReservoir, bottom / n);
      }
    }
    expect(reachedHigh).toBeGreaterThan(0); // de la cire a atteint le haut
    expect(minReservoir).toBeGreaterThan(0.2); // le réservoir ne se vide jamais
    expect(maxReservoir).toBeGreaterThan(minReservoir + 0.15); // et ça bouge : pas d'état figé
  }, 120_000);
});
