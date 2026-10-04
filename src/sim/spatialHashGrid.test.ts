import { describe, expect, it } from 'vitest';
import { mulberry32 } from './random';
import { SpatialHashGrid } from './spatialHashGrid';

function bruteForce(pos: Float32Array, count: number, i: number, radius: number): number[] {
  const out: number[] = [];
  const r2 = radius * radius;
  for (let j = 0; j < count; j++) {
    if (j === i) continue;
    const dx = pos[3 * j]! - pos[3 * i]!;
    const dy = pos[3 * j + 1]! - pos[3 * i + 1]!;
    const dz = pos[3 * j + 2]! - pos[3 * i + 2]!;
    if (dx * dx + dy * dy + dz * dz < r2) out.push(j);
  }
  return out;
}

function randomCloud(count: number, extent: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const pos = new Float32Array(3 * count);
  // Coordonnées négatives incluses pour couvrir le hachage des indices < 0.
  for (let k = 0; k < pos.length; k++) pos[k] = (rand() - 0.5) * extent;
  return pos;
}

function gridNeighbors(grid: SpatialHashGrid, pos: Float32Array, i: number, radius: number, out: Int32Array): number[] {
  const n = grid.query(pos, pos[3 * i]!, pos[3 * i + 1]!, pos[3 * i + 2]!, radius, out, 0, out.length, i);
  return Array.from(out.subarray(0, n)).sort((a, b) => a - b);
}

describe('SpatialHashGrid', () => {
  it.each([
    { count: 400, extent: 1.2, cellSize: 0.13, seed: 1 },
    { count: 1000, extent: 3, cellSize: 0.1, seed: 2 },
    // Table minuscule : beaucoup de collisions de hachage, aucun doublon toléré.
    { count: 300, extent: 2, cellSize: 0.2, seed: 3, tableSize: 16 },
  ])('donne les mêmes voisins que la force brute ($count pts, cellule $cellSize)', ({ count, extent, cellSize, seed, tableSize }) => {
    const pos = randomCloud(count, extent, seed);
    const grid = new SpatialHashGrid(count, tableSize);
    grid.build(pos, count, cellSize);
    const out = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      expect(gridNeighbors(grid, pos, i, cellSize, out)).toEqual(bruteForce(pos, count, i, cellSize));
    }
  });

  it('gère un rayon de requête plus grand que la cellule', () => {
    const count = 300;
    const pos = randomCloud(count, 2, 4);
    const grid = new SpatialHashGrid(count);
    grid.build(pos, count, 0.1);
    const out = new Int32Array(count);
    for (let i = 0; i < count; i += 7) {
      expect(gridNeighbors(grid, pos, i, 0.35, out)).toEqual(bruteForce(pos, count, i, 0.35));
    }
  });

  it('reste correct après reconstruction sur des positions déplacées', () => {
    const count = 200;
    const pos = randomCloud(count, 1, 5);
    const grid = new SpatialHashGrid(count);
    grid.build(pos, count, 0.15);
    for (let k = 0; k < pos.length; k++) pos[k]! += 0.37;
    grid.build(pos, count, 0.15);
    const out = new Int32Array(count);
    for (let i = 0; i < count; i++) {
      expect(gridNeighbors(grid, pos, i, 0.15, out)).toEqual(bruteForce(pos, count, i, 0.15));
    }
  });

  it('respecte maxOut', () => {
    const count = 50;
    const pos = new Float32Array(3 * count); // tous à l'origine
    const grid = new SpatialHashGrid(count);
    grid.build(pos, count, 0.1);
    const out = new Int32Array(count);
    expect(grid.query(pos, 0, 0, 0, 0.1, out, 0, 10, 0)).toBe(10);
  });
});
