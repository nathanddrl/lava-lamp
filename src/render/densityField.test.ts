import { describe, expect, it } from 'vitest';
import { DensityField, OCCUPANCY_BLOCK } from './densityField';

const BOUNDS = { radius: 0.5, yMin: 1, yMax: 3 };

/** Réseau cubique de particules, pas `spacing`, centré en (0, 2, 0), demi-côté `half`. */
function lattice(spacing: number, half: number): { positions: Float32Array; count: number } {
  const pts: number[] = [];
  for (let x = -half; x <= half + 1e-9; x += spacing) {
    for (let y = -half; y <= half + 1e-9; y += spacing) {
      for (let z = -half; z <= half + 1e-9; z += spacing) pts.push(x, 2 + y, z);
    }
  }
  return { positions: new Float32Array(pts), count: pts.length / 3 };
}

function totalDensity(f: DensityField): number {
  let s = 0;
  for (let k = 0; k < f.data.length; k += 2) s += f.data[k]!;
  return s;
}

describe('DensityField', () => {
  it('conserve la masse : Σ champ · voxel³ = N / n0', () => {
    const spacing = 0.04;
    const n0 = 1 / spacing ** 3;
    const { positions, count } = lattice(spacing, 0.2);
    const f = new DensityField(BOUNDS, n0, { smoothingTime: 0 });
    f.update(positions, positions, new Float32Array(count).fill(0.5), count, 0, 1 / 60);
    const mass = totalDensity(f) * f.cell ** 3;
    expect(mass).toBeCloseTo(count / n0, 2);
  });

  it('vaut ≈ 1 au cœur d’un bloc à la densité de référence, < 0.5 dehors', () => {
    const spacing = 0.04;
    const { positions, count } = lattice(spacing, 0.2);
    const f = new DensityField(BOUNDS, 1 / spacing ** 3, { smoothingTime: 0 });
    f.update(positions, positions, new Float32Array(count), count, 0, 1 / 60);
    expect(f.sampleNearest(0, 2, 0)).toBeGreaterThan(0.9);
    expect(f.sampleNearest(0, 2, 0)).toBeLessThan(1.1);
    expect(f.sampleNearest(0.3, 2, 0)).toBeLessThan(0.5);
  });

  it('stocke la température pondérée par la densité', () => {
    const { positions, count } = lattice(0.04, 0.1);
    const f = new DensityField(BOUNDS, 1 / 0.04 ** 3, { smoothingTime: 0 });
    f.update(positions, positions, new Float32Array(count).fill(0.7), count, 0, 1 / 60);
    for (let k = 0; k < f.data.length; k += 2) {
      if (f.data[k]! > 1e-3) expect(f.data[k + 1]! / f.data[k]!).toBeCloseTo(0.7, 4);
    }
  });

  it('interpole entre les deux derniers pas avec alpha', () => {
    const prev = new Float32Array([0, 2, 0]);
    const cur = new Float32Array([0.2, 2, 0]);
    const f = new DensityField(BOUNDS, 1, { smoothingTime: 0 });
    f.update(cur, prev, new Float32Array(1), 1, 0.5, 1 / 60);
    const atMid = f.sampleNearest(0.1, 2, 0);
    expect(atMid).toBeGreaterThan(f.sampleNearest(0, 2, 0));
    expect(atMid).toBeGreaterThan(f.sampleNearest(0.2, 2, 0));
  });

  it('le lissage temporel converge vers le champ instantané', () => {
    const { positions, count } = lattice(0.04, 0.1);
    const T = new Float32Array(count);
    const sharp = new DensityField(BOUNDS, 1 / 0.04 ** 3, { smoothingTime: 0 });
    sharp.update(positions, positions, T, count, 0, 1 / 60);
    const smooth = new DensityField(BOUNDS, 1 / 0.04 ** 3, { smoothingTime: 0.04 });
    smooth.update(positions, positions, T, count, 0, 1 / 60);
    expect(totalDensity(smooth)).toBeLessThan(0.5 * totalDensity(sharp));
    for (let i = 0; i < 60; i++) smooth.update(positions, positions, T, count, 0, 1 / 60);
    expect(totalDensity(smooth)).toBeCloseTo(totalDensity(sharp), 3);
  });

  it('marque occupé tout bloc où le champ n’est pas négligeable, et vide le reste', () => {
    const { positions, count } = lattice(0.04, 0.1);
    const f = new DensityField(BOUNDS, 1 / 0.04 ** 3, { smoothingTime: 0.04 });
    for (let i = 0; i < 10; i++) f.update(positions, positions, new Float32Array(count), count, 0, 1 / 60);
    let empty = 0;
    for (let z = 0; z < f.nz; z++) {
      for (let y = 0; y < f.ny; y++) {
        for (let x = 0; x < f.nx; x++) {
          const b = Math.floor(x / OCCUPANCY_BLOCK) + f.bx * (Math.floor(y / OCCUPANCY_BLOCK) + f.by * Math.floor(z / OCCUPANCY_BLOCK));
          const d = f.data[2 * (x + f.nx * (y + f.ny * z))]!;
          if (d > 1e-4) expect(f.occupancy[b]).toBe(255);
        }
      }
    }
    for (const o of f.occupancy) if (o === 0) empty++;
    expect(empty / f.occupancy.length).toBeGreaterThan(0.8);

    // Les particules partent : le bloc se vide une fois la contribution résiduelle éteinte.
    for (let i = 0; i < 30; i++) f.update(positions, positions, new Float32Array(count), 0, 0, 1 / 60);
    expect(f.occupancy.every((o) => o === 0)).toBe(true);
  });

  it('réalloue la grille quand la résolution change', () => {
    const f = new DensityField(BOUNDS, 1, { resolution: 32 });
    const v = f.version;
    expect(f.nx).toBe(32);
    f.params.resolution = 48;
    f.update(new Float32Array(0), new Float32Array(0), new Float32Array(0), 0, 0, 1 / 60);
    expect(f.version).toBe(v + 1);
    expect(f.nx).toBe(48);
    // Voxels cubiques, la grille couvre le liquide avec une marge.
    expect(f.size.y / f.ny).toBeCloseTo(f.cell, 6);
    expect(f.min.y).toBeLessThan(BOUNDS.yMin);
    expect(f.min.y + f.size.y).toBeGreaterThan(BOUNDS.yMax);
    expect(f.min.x + f.size.x).toBeGreaterThan(BOUNDS.radius);
  });
});
