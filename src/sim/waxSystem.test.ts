import { describe, expect, it } from 'vitest';
import { LampProfile } from './lampProfile';
import { Simulation } from './simulation';

const DT = 1 / 120;

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
    const sim = new Simulation(new LampProfile());
    run(sim, 10);

    const rest = stats(sim);
    expect(rest.outside).toBe(0);
    expect(rest.rmsSpeed).toBeLessThan(0.02);
    expect(clusters(sim)[0]).toBeGreaterThanOrEqual(sim.wax.count - 2);
    expect(rest.yTop).toBeLessThan(sim.container.yMin + 0.5);

    sim.impulse();
    let maxTop = 0;
    let maxBlobs = 1;
    for (let t = 0; t < 4; t += 0.25) {
      run(sim, 0.25);
      maxTop = Math.max(maxTop, stats(sim).yTop);
      maxBlobs = Math.max(maxBlobs, clusters(sim).filter((s) => s >= 5).length);
    }
    expect(maxTop).toBeGreaterThan(sim.container.yMin + 1.2);
    expect(maxBlobs).toBeGreaterThanOrEqual(2);

    run(sim, 8);
    const after = stats(sim);
    expect(after.outside).toBe(0);
    expect(after.rmsSpeed).toBeLessThan(0.02);
    expect(clusters(sim)[0]).toBeGreaterThanOrEqual(sim.wax.count - 2);
  }, 30_000);
});
