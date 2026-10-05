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

/** Hauteur max (normalisée) atteinte par les amas qui touchent le fond (réservoir). */
function reservoirTop(sim: Simulation): number {
  const { positions: x, count: n } = sim.wax;
  const { yMin, yMax } = sim.container;
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
  const touching = new Set<number>();
  for (let i = 0; i < n; i++) if (x[3 * i + 1]! < yMin + 0.12) touching.add(find(i));
  let top = 0;
  for (let i = 0; i < n; i++) if (touching.has(find(i))) top = Math.max(top, x[3 * i + 1]!);
  return (top - yMin) / (yMax - yMin);
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

  it('cycle thermique (preset par défaut) : des têtes atteignent le haut, le réservoir tient, pas de colonne permanente, ça ne s\'arrête pas', () => {
    const sim = new Simulation(new LampProfile());
    const { yMin, yMax } = sim.container;
    const H = yMax - yMin;
    let highSamples = 0;
    let idle = 0;
    let longestIdle = 0;
    let minReservoir = 1;
    let columnSamples = 0;
    let samples = 0;
    for (let t = 0; t < 180; t += 2) {
      run(sim, 2);
      const { positions: x, temperatures: T, count: n } = sim.wax;
      let bottom = 0;
      let upper = 0;
      let high = false;
      for (let i = 0; i < n; i++) {
        expect(T[i]).toBeGreaterThanOrEqual(0);
        expect(T[i]).toBeLessThanOrEqual(1);
        const y = x[3 * i + 1]!;
        if (y < yMin + 0.2 * H) bottom++;
        if (y > yMin + 0.5 * H) upper++;
        if (y > yMin + 0.9 * H) high = true;
      }
      if (t < 60) continue;
      samples++;
      if (reservoirTop(sim) > 0.8) columnSamples++;
      if (high) highSamples++;
      minReservoir = Math.min(minReservoir, bottom / n);
      idle = upper < 0.01 * n ? idle + 2 : 0;
      longestIdle = Math.max(longestIdle, idle);
    }
    expect(highSamples).toBeGreaterThan(0); // des têtes dépassent 90 % de la hauteur
    expect(minReservoir).toBeGreaterThanOrEqual(0.4); // le réservoir garde au moins 40 %
    expect(longestIdle).toBeLessThan(60); // jamais de minute sans cire en haut
    // Pas de fontaine : le réservoir n'est relié au haut de la lampe que par intermittence.
    expect(columnSamples / samples).toBeLessThan(0.3);
  }, 120_000);

  it('disposition « settled » : cire froide tassée au fond, stable sans chauffe', () => {
    const profile = new LampProfile();
    const sim = new Simulation(profile, NO_THERMAL_PARAMS);
    sim.reset('settled');
    const w = sim.wax;
    const H = profile.yMax - profile.yMin;
    const check = () => {
      for (let i = 0; i < w.count; i++) {
        const x = w.positions[3 * i]!;
        const y = w.positions[3 * i + 1]!;
        const z = w.positions[3 * i + 2]!;
        expect(y).toBeGreaterThanOrEqual(profile.yMin);
        expect((y - profile.yMin) / H).toBeLessThan(0.15);
        expect(Math.hypot(x, z)).toBeLessThanOrEqual(profile.innerRadius(y) + 1e-6);
      }
    };
    check();
    for (let k = 0; k < 120; k++) sim.step(SIM_FIXED_DT);
    check();
  });
});
