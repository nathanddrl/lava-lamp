/**
 * Grille de hachage spatial uniforme (Teschner et al. 2003), construite par
 * tri par comptage : O(n) par reconstruction, aucune allocation après le constructeur.
 *
 * Les collisions de hachage sont neutralisées : chaque particule mémorise sa
 * cellule entière, et une requête n'accepte une particule que lorsqu'elle visite
 * exactement cette cellule. Une particule n'est donc jamais retournée deux fois,
 * même si deux cellules voisines tombent dans le même seau.
 */
export class SpatialHashGrid {
  readonly capacity: number;
  readonly tableSize: number;

  private cellSize = 1;
  private invCellSize = 1;
  private count = 0;

  /** Début de chaque seau dans `sorted` (taille tableSize + 1). */
  private readonly bucketStart: Int32Array;
  private readonly bucketCursor: Int32Array;
  /** Indices de particules triés par seau. */
  private readonly sorted: Int32Array;
  /** Coordonnées entières de cellule par particule (ix, iy, iz). */
  private readonly cellCoords: Int32Array;
  private readonly bucketOf: Int32Array;

  constructor(capacity: number, tableSize = nextPowerOfTwo(Math.max(16, capacity * 2))) {
    if ((tableSize & (tableSize - 1)) !== 0) throw new Error('tableSize doit être une puissance de 2');
    this.capacity = capacity;
    this.tableSize = tableSize;
    this.bucketStart = new Int32Array(tableSize + 1);
    this.bucketCursor = new Int32Array(tableSize);
    this.sorted = new Int32Array(capacity);
    this.cellCoords = new Int32Array(capacity * 3);
    this.bucketOf = new Int32Array(capacity);
  }

  private hash(ix: number, iy: number, iz: number): number {
    return (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & (this.tableSize - 1);
  }

  /** Indexe les `count` premières particules de `positions` (xyz entrelacés). */
  build(positions: Float32Array, count: number, cellSize: number): void {
    if (count > this.capacity) throw new RangeError(`count ${count} > capacité ${this.capacity}`);
    this.count = count;
    this.cellSize = cellSize;
    this.invCellSize = 1 / cellSize;

    const { bucketStart, bucketCursor, sorted, cellCoords, bucketOf, invCellSize } = this;
    bucketStart.fill(0);

    for (let i = 0; i < count; i++) {
      const ix = Math.floor(positions[3 * i]! * invCellSize);
      const iy = Math.floor(positions[3 * i + 1]! * invCellSize);
      const iz = Math.floor(positions[3 * i + 2]! * invCellSize);
      cellCoords[3 * i] = ix;
      cellCoords[3 * i + 1] = iy;
      cellCoords[3 * i + 2] = iz;
      const b = this.hash(ix, iy, iz);
      bucketOf[i] = b;
      bucketStart[b + 1]!++;
    }
    for (let b = 0; b < this.tableSize; b++) {
      bucketStart[b + 1]! += bucketStart[b]!;
      bucketCursor[b] = bucketStart[b]!;
    }
    for (let i = 0; i < count; i++) {
      const b = bucketOf[i]!;
      sorted[bucketCursor[b]!++] = i;
    }
  }

  /**
   * Écrit dans `out[offset..]` les indices des particules strictement à moins de
   * `radius` de (x, y, z), en excluant `exclude`. Au plus `maxOut` résultats.
   * @returns le nombre d'indices écrits.
   */
  query(
    positions: Float32Array,
    x: number,
    y: number,
    z: number,
    radius: number,
    out: Int32Array,
    offset: number,
    maxOut: number,
    exclude = -1,
  ): number {
    const { invCellSize, sorted, cellCoords, bucketStart } = this;
    const r2 = radius * radius;
    const x0 = Math.floor((x - radius) * invCellSize);
    const x1 = Math.floor((x + radius) * invCellSize);
    const y0 = Math.floor((y - radius) * invCellSize);
    const y1 = Math.floor((y + radius) * invCellSize);
    const z0 = Math.floor((z - radius) * invCellSize);
    const z1 = Math.floor((z + radius) * invCellSize);
    let n = 0;

    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        for (let iz = z0; iz <= z1; iz++) {
          const b = this.hash(ix, iy, iz);
          const end = bucketStart[b + 1]!;
          for (let s = bucketStart[b]!; s < end; s++) {
            const j = sorted[s]!;
            if (j === exclude) continue;
            if (cellCoords[3 * j] !== ix || cellCoords[3 * j + 1] !== iy || cellCoords[3 * j + 2] !== iz) continue;
            const dx = positions[3 * j]! - x;
            const dy = positions[3 * j + 1]! - y;
            const dz = positions[3 * j + 2]! - z;
            if (dx * dx + dy * dy + dz * dz >= r2) continue;
            if (n >= maxOut) return n;
            out[offset + n++] = j;
          }
        }
      }
    }
    return n;
  }

  get indexedCount(): number {
    return this.count;
  }

  get currentCellSize(): number {
    return this.cellSize;
  }
}

export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
