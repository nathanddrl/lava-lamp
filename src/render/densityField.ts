/**
 * Champ de densité de la cire, échantillonné sur une grille 3D alignée sur le
 * récipient. Construit sur CPU à chaque frame en « splattant » les particules
 * avec un noyau lisse, puis uploadé en texture 3D (src/render/waxSurfaceView.ts).
 *
 * Aucune dépendance à Three.js : testable et mesurable en headless.
 *
 * Deux canaux entrelacés par voxel (format RG de la texture) :
 *   R = densité normalisée (≈ 1 au cœur de la cire, 0.5 à sa surface),
 *   G = température × densité (la température locale est G / R).
 *
 * Noyau séparable à support compact : w = k(dx)·k(dy)·k(dz), k(u) = (1 − u²)³ sur
 * [−1, 1] (C², proche d'une gaussienne). La séparabilité ramène le coût d'une
 * particule à 3 petits tableaux de poids + une multiplication-addition par voxel.
 *
 * Lissage temporel : champ ← keep·champ + (1 − keep)·splat, keep = exp(−dt / τ).
 * On applique `keep` au champ puis on splatte directement avec le poids (1 − keep) :
 * pas de second tampon. Les lignes de voxels que plus aucune particule n'atteint
 * sont remises à zéro une fois puis ignorées (ni coût, ni flottants dénormalisés).
 *
 * Occupation : grille grossière (blocs de 4³ voxels), 255 si une particule a pu y
 * déposer une densité non négligeable récemment, 0 sinon. Le raymarch traverse les
 * blocs vides d'un seul saut (la cire occupe une petite fraction du récipient).
 */

export interface DensityFieldParams {
  /** Nombre de voxels sur x et z ; la hauteur suit les proportions du récipient (voxels cubiques). */
  resolution: number;
  /** Rayon du noyau de splatting (unités monde). */
  kernelRadius: number;
  /** Constante de temps du lissage temporel (s). 0 = aucun lissage. */
  smoothingTime: number;
}

export const DEFAULT_DENSITY_FIELD_PARAMS: DensityFieldParams = {
  resolution: 48,
  kernelRadius: 0.085,
  smoothingTime: 0.04,
};

/** Boîte englobant le liquide : la grille la recouvre avec une petite marge. */
export interface FieldBounds {
  /** Rayon intérieur maximal du récipient. */
  radius: number;
  yMin: number;
  yMax: number;
}

/** Intégrale de (1 − u²)³ sur [−1, 1]. */
const KERNEL_1D_INTEGRAL = 32 / 35;
/** Après ce nombre de frames sans contribution, une ligne vaut moins de keep^N ≈ 0 : on la vide. */
const IDLE_FRAMES_BEFORE_CLEAR = 120;
/** Au plus 2·R/cell + 2 voxels par axe ; borne large pour les tableaux de poids. */
const MAX_FOOTPRINT = 64;
/** Côté d'un bloc de la grille d'occupation, en voxels. */
export const OCCUPANCY_BLOCK = 4;
/** Fraction résiduelle d'une contribution sous laquelle un bloc est considéré vide. */
const OCCUPANCY_RESIDUAL = 0.02;

export class DensityField {
  readonly params: DensityFieldParams;
  readonly bounds: FieldBounds;

  nx = 0;
  ny = 0;
  nz = 0;
  /** Taille d'un voxel (cubique), unités monde. */
  cell = 0;
  /** Coin minimal de la grille ; le voxel (i, j, k) est centré en min + (i + ½)·cell. */
  readonly min = { x: 0, y: 0, z: 0 };
  /** Taille de la grille, unités monde (= n·cell par axe). */
  readonly size = { x: 0, y: 0, z: 0 };
  /** Voxels RG entrelacés, index = 2·(x + nx·(y + ny·z)). Uploadé tel quel. */
  data = new Float32Array(0);
  /** Incrémenté à chaque réallocation (la texture doit être recréée). */
  version = 0;
  /** Dimensions de la grille d'occupation (blocs de OCCUPANCY_BLOCK³ voxels). */
  bx = 0;
  by = 0;
  bz = 0;
  /** 255 = bloc pouvant contenir de la cire, 0 = vide. index = x + bx·(y + by·z). */
  occupancy = new Uint8Array(0);

  /**
   * Densité de référence (particules / unité³) : celle du cœur de la cire au repos.
   * Le champ vaut Σ noyaux / (n0 · volume du noyau), donc ≈ 1 dans la masse quel que
   * soit le rayon du noyau : le seuil garde son sens quand on change ce rayon.
   */
  referenceDensity: number;

  private rowLastTouched = new Int32Array(0);
  private rowCleared = new Uint8Array(0);
  private blockLastTouched = new Int32Array(0);
  private frame = 0;
  private allocatedResolution = -1;
  private readonly wx = new Float32Array(MAX_FOOTPRINT);
  private readonly wy = new Float32Array(MAX_FOOTPRINT);
  private readonly wz = new Float32Array(MAX_FOOTPRINT);

  constructor(bounds: FieldBounds, referenceDensity: number, params: Partial<DensityFieldParams> = {}) {
    this.bounds = bounds;
    this.referenceDensity = referenceDensity;
    this.params = { ...DEFAULT_DENSITY_FIELD_PARAMS, ...params };
    this.allocate();
  }

  /** (Ré)alloue la grille si la résolution a changé. */
  private allocate(): void {
    const res = Math.max(8, Math.min(160, Math.round(this.params.resolution)));
    if (res === this.allocatedResolution) return;
    this.allocatedResolution = res;
    const { radius, yMin, yMax } = this.bounds;
    // Marge d'un voxel et demi autour du liquide : la surface ne touche jamais le bord.
    const width = 2 * radius;
    const cell = width / (res - 3);
    const ny = Math.ceil((yMax - yMin) / cell) + 3;
    this.nx = res;
    this.nz = res;
    this.ny = ny;
    this.cell = cell;
    this.min.x = -radius - 1.5 * cell;
    this.min.z = -radius - 1.5 * cell;
    this.min.y = 0.5 * (yMin + yMax) - 0.5 * ny * cell;
    this.size.x = res * cell;
    this.size.y = ny * cell;
    this.size.z = res * cell;
    this.data = new Float32Array(2 * res * ny * res);
    this.rowLastTouched = new Int32Array(ny * res).fill(-IDLE_FRAMES_BEFORE_CLEAR - 1);
    this.rowCleared = new Uint8Array(ny * res).fill(1);
    this.bx = Math.ceil(res / OCCUPANCY_BLOCK);
    this.by = Math.ceil(ny / OCCUPANCY_BLOCK);
    this.bz = Math.ceil(res / OCCUPANCY_BLOCK);
    this.occupancy = new Uint8Array(this.bx * this.by * this.bz);
    this.blockLastTouched = new Int32Array(this.bx * this.by * this.bz).fill(-1 << 30);
    this.frame = 0;
    this.version++;
  }

  /**
   * Reconstruit le champ à partir des particules, interpolées entre les deux
   * derniers pas fixes (`alpha` ∈ [0, 1]).
   *
   * @param frameDt temps réel écoulé depuis la frame précédente (lissage temporel).
   */
  update(
    positions: Float32Array,
    previousPositions: Float32Array,
    temperatures: Float32Array,
    count: number,
    alpha: number,
    frameDt: number,
  ): void {
    this.allocate();
    const { nx, ny, nz, cell, data, rowLastTouched, rowCleared, wx, wy, wz } = this;
    const { bx, by, bz, blockLastTouched } = this;
    const tau = this.params.smoothingTime;
    const keep = tau > 0 && frameDt > 0 ? Math.exp(-frameDt / tau) : 0;
    const frame = ++this.frame;

    // 1. Atténuation du champ précédent (ou remise à zéro des lignes inactives).
    const rows = ny * nz;
    const rowLen = 2 * nx;
    for (let row = 0; row < rows; row++) {
      if (rowCleared[row]) continue;
      const o = row * rowLen;
      if (keep === 0 || frame - rowLastTouched[row]! > IDLE_FRAMES_BEFORE_CLEAR) {
        data.fill(0, o, o + rowLen);
        rowCleared[row] = 1;
      } else {
        for (let k = o; k < o + rowLen; k++) data[k]! *= keep;
      }
    }

    // 2. Splatting, pondéré par (1 − keep).
    const R = Math.max(cell * 0.5, this.params.kernelRadius);
    const rc = R / cell; // rayon du noyau en voxels
    const invRc = 1 / rc;
    const kernelVolume = (KERNEL_1D_INTEGRAL * R) ** 3;
    const gain = (1 - keep) / (this.referenceDensity * kernelVolume);
    const invCell = 1 / cell;
    const ox = this.min.x;
    const oy = this.min.y;
    const oz = this.min.z;
    const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;

    for (let p = 0; p < count; p++) {
      const p3 = 3 * p;
      const px0 = previousPositions[p3]!;
      const py0 = previousPositions[p3 + 1]!;
      const pz0 = previousPositions[p3 + 2]!;
      // Coordonnées continues de grille : le voxel i est centré en g = i.
      const gx = (px0 + (positions[p3]! - px0) * a - ox) * invCell - 0.5;
      const gy = (py0 + (positions[p3 + 1]! - py0) * a - oy) * invCell - 0.5;
      const gz = (pz0 + (positions[p3 + 2]! - pz0) * a - oz) * invCell - 0.5;

      const x0 = Math.max(0, Math.ceil(gx - rc));
      const x1 = Math.min(nx - 1, Math.floor(gx + rc));
      const y0 = Math.max(0, Math.ceil(gy - rc));
      const y1 = Math.min(ny - 1, Math.floor(gy + rc));
      const z0 = Math.max(0, Math.ceil(gz - rc));
      const z1 = Math.min(nz - 1, Math.floor(gz + rc));
      if (x1 < x0 || y1 < y0 || z1 < z0) continue;

      // Blocs couverts par l'empreinte, dilatée d'un voxel (le filtrage trilinéaire
      // du shader lit jusqu'à un voxel plus loin).
      const bx0 = Math.max(0, Math.floor((x0 - 1) / OCCUPANCY_BLOCK));
      const bx1 = Math.min(bx - 1, Math.floor((x1 + 1) / OCCUPANCY_BLOCK));
      const by0 = Math.max(0, Math.floor((y0 - 1) / OCCUPANCY_BLOCK));
      const by1 = Math.min(by - 1, Math.floor((y1 + 1) / OCCUPANCY_BLOCK));
      const bz0 = Math.max(0, Math.floor((z0 - 1) / OCCUPANCY_BLOCK));
      const bz1 = Math.min(bz - 1, Math.floor((z1 + 1) / OCCUPANCY_BLOCK));
      for (let k = bz0; k <= bz1; k++) {
        for (let j = by0; j <= by1; j++) {
          const o = bx * (j + by * k);
          for (let i = bx0; i <= bx1; i++) blockLastTouched[o + i] = frame;
        }
      }

      const t = temperatures[p]!;
      for (let i = x0; i <= x1; i++) wx[i - x0] = kernel1d((i - gx) * invRc);
      for (let j = y0; j <= y1; j++) wy[j - y0] = kernel1d((j - gy) * invRc);
      for (let k = z0; k <= z1; k++) wz[k - z0] = kernel1d((k - gz) * invRc) * gain;

      for (let k = z0; k <= z1; k++) {
        const wk = wz[k - z0]!;
        if (wk === 0) continue;
        for (let j = y0; j <= y1; j++) {
          const wjk = wy[j - y0]! * wk;
          if (wjk === 0) continue;
          const row = j + ny * k;
          rowLastTouched[row] = frame;
          rowCleared[row] = 0;
          const wt = wjk * t;
          let idx = 2 * (x0 + nx * row);
          for (let i = 0; i <= x1 - x0; i++) {
            const w = wx[i]!;
            data[idx]! += w * wjk;
            data[idx + 1]! += w * wt;
            idx += 2;
          }
        }
      }
    }

    // 3. Occupation : un bloc reste occupé tant que sa dernière contribution n'a pas
    // décru sous OCCUPANCY_RESIDUAL.
    const persist = keep > 0 ? Math.ceil(Math.log(OCCUPANCY_RESIDUAL) / Math.log(keep)) : 0;
    const occ = this.occupancy;
    for (let b = 0; b < occ.length; b++) occ[b] = frame - blockLastTouched[b]! <= persist ? 255 : 0;
  }

  /** Valeur du canal densité au voxel le plus proche de (x, y, z) (debug / tests). */
  sampleNearest(x: number, y: number, z: number): number {
    const i = Math.round((x - this.min.x) / this.cell - 0.5);
    const j = Math.round((y - this.min.y) / this.cell - 0.5);
    const k = Math.round((z - this.min.z) / this.cell - 0.5);
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return 0;
    return this.data[2 * (i + this.nx * (j + this.ny * k))]!;
  }
}

function kernel1d(u: number): number {
  const s = 1 - u * u;
  return s > 0 ? s * s * s : 0;
}

/**
 * Densité de particules au cœur d'une cire de Clavet au repos : la densité de Clavet
 * ρ = Σ (1 − r/h)² sur les voisins vaut ρ0, et ∫ (1 − r/h)² dV = (2π/15)·h³ sur la boule.
 * Corrigée empiriquement (×`fudge`) : la double relaxation laisse la masse un peu plus
 * dense que ρ0 (pression near).
 */
export function clavetReferenceDensity(restDensity: number, interactionRadius: number, fudge = 1): number {
  return (fudge * restDensity) / ((2 * Math.PI) / 15 * interactionRadius ** 3);
}
