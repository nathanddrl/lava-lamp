import type { ContainerShape } from './lampProfile';
import { mulberry32 } from './random';
import { SpatialHashGrid } from './spatialHashGrid';

/**
 * Cire en particules, méthode « double density relaxation » de Clavet, Beaudoin
 * & Poulin 2005 (Particle-based Viscoelastic Fluid Simulation) :
 *
 *   1. forces externes sur v (gravité, traînée du liquide environnant)
 *   2. viscosité par impulsions radiales entre paires (sur v)
 *   3. prédiction : x_prev = x ; x += v·dt
 *   4. relaxation de double densité (sur x) : pression + pression « near »
 *      → cohésion et pseudo tension de surface sans résoudre Navier-Stokes
 *   5. collisions avec le récipient (sur x)
 *   6. v = (x − x_prev) / dt
 *
 * Toutes les données sont dans des TypedArrays alloués au reset ; `step()`
 * n'alloue rien.
 */

export interface WaxParams {
  /** Nombre de particules (appliqué au prochain reset). */
  particleCount: number;
  /** h : rayon d'interaction, aussi taille de cellule de la grille. */
  interactionRadius: number;
  /** ρ0 : densité de repos (somme des noyaux (1 − r/h)²). */
  restDensity: number;
  /** k : raideur de la pression. */
  stiffness: number;
  /** k near : raideur de la pression proche (anti-agglutinement, tension de surface). */
  nearStiffness: number;
  /** σ : viscosité linéaire. */
  viscosityLinear: number;
  /** β : viscosité quadratique. */
  viscosityQuadratic: number;
  /** Gravité apparente (poids − poussée), unités/s². */
  gravity: number;
  /** Traînée linéaire du liquide environnant, 1/s. */
  drag: number;
  /** Coefficient de friction de Coulomb μ contre le verre (indépendant du dt). */
  wallFriction: number;
  /** Rayon de collision d'une particule avec les parois. */
  particleRadius: number;
  /** Vitesse verticale max donnée par le bouton « impulsion ». */
  impulseStrength: number;
  /** Garde-fou contre l'explosion numérique. */
  maxSpeed: number;
  substeps: number;
  seed: number;
}

export const DEFAULT_WAX_PARAMS: WaxParams = {
  particleCount: 400,
  interactionRadius: 0.13,
  // ≈ 30 voisins par particule au repos : cohésion correcte, coût maîtrisé.
  restDensity: 3,
  stiffness: 40,
  nearStiffness: 160,
  // Viscosité forte : dt·σ ≈ 0.25 par sous-pas, la cire reste épaisse et lente.
  viscosityLinear: 60,
  viscosityQuadratic: 20,
  gravity: 0.8,
  drag: 0.6,
  wallFriction: 0.3,
  particleRadius: 0.03,
  impulseStrength: 10,
  maxSpeed: 8,
  substeps: 2,
  seed: 1,
};

export const MAX_PARTICLES = 4000;
/** Voisins mémorisés par particule ; au-delà, les plus lointains sont ignorés. */
const MAX_NEIGHBORS = 128;

export class WaxSystem {
  readonly params: WaxParams;
  readonly container: ContainerShape;

  count = 0;
  /** Positions xyz entrelacées, état courant. */
  positions = new Float32Array(0);
  /** Positions au début du dernier `step()`, pour l'interpolation du rendu. */
  previousStepPositions = new Float32Array(0);
  velocities = new Float32Array(0);

  private predictedFrom = new Float32Array(0);
  private neighborCount = new Int32Array(0);
  private neighbors = new Int32Array(0);
  private grid = new SpatialHashGrid(1);

  constructor(container: ContainerShape, params: WaxParams = { ...DEFAULT_WAX_PARAMS }) {
    this.container = container;
    this.params = params;
    this.reset();
  }

  /** (Ré)alloue les buffers et redistribue les particules en l'air, au centre du récipient. */
  reset(): void {
    const n = Math.max(1, Math.min(MAX_PARTICLES, Math.round(this.params.particleCount)));
    if (n !== this.count || this.positions.length !== 3 * n) {
      this.positions = new Float32Array(3 * n);
      this.previousStepPositions = new Float32Array(3 * n);
      this.velocities = new Float32Array(3 * n);
      this.predictedFrom = new Float32Array(3 * n);
      this.neighborCount = new Int32Array(n);
      this.neighbors = new Int32Array(n * MAX_NEIGHBORS);
      this.grid = new SpatialHashGrid(n);
    }
    this.count = n;

    // Nuage cylindrique lâche, assez haut pour qu'on voie la masse tomber.
    const rand = mulberry32(this.params.seed);
    const { yMin, yMax } = this.container;
    const yCenter = yMin + 0.55 * (yMax - yMin);
    const cloudRadius = 0.6 * this.container.innerRadius(yCenter);
    const spacing = 0.5 * this.params.interactionRadius;
    const height = (n * spacing ** 3) / (Math.PI * cloudRadius * cloudRadius);
    for (let i = 0; i < n; i++) {
      const a = rand() * 2 * Math.PI;
      const r = cloudRadius * Math.sqrt(rand());
      this.positions[3 * i] = r * Math.cos(a);
      this.positions[3 * i + 1] = yCenter + (rand() - 0.5) * height;
      this.positions[3 * i + 2] = r * Math.sin(a);
    }
    this.velocities.fill(0);
    this.previousStepPositions.set(this.positions);
  }

  /**
   * Pousse la masse vers le haut avec un gradient : fort au sommet et près de
   * l'axe, nul à la base et contre le verre. La base reste posée pendant que
   * le cœur part, d'où une colonne qui s'étire au lieu d'un bloc qui décolle.
   * Le sommet de référence est moyenne + 1.5 écart-type des hauteurs, pour
   * qu'une particule isolée ne fausse pas le gradient.
   */
  impulse(): void {
    const { positions, velocities, count, container } = this;
    const s = this.params.impulseStrength;
    let yLow = Infinity;
    let sum = 0;
    let sum2 = 0;
    for (let i = 0; i < count; i++) {
      const y = positions[3 * i + 1]!;
      if (y < yLow) yLow = y;
      sum += y;
      sum2 += y * y;
    }
    const mean = sum / count;
    const std = Math.sqrt(Math.max(0, sum2 / count - mean * mean));
    const invSpan = 1 / Math.max(1e-3, mean + 1.5 * std - yLow);
    for (let i = 0; i < count; i++) {
      const x = positions[3 * i]!;
      const y = positions[3 * i + 1]!;
      const z = positions[3 * i + 2]!;
      const R = Math.max(1e-3, container.innerRadius(clamp(y, container.yMin, container.yMax)));
      const radial = Math.max(0, 1 - Math.sqrt(x * x + z * z) / (0.6 * R));
      const vertical = Math.min(1, (y - yLow) * invSpan);
      velocities[3 * i + 1]! += s * radial * radial * vertical;
    }
  }

  /** Avance d'un pas fixe `dt`, découpé en `substeps` sous-pas. */
  step(dt: number): void {
    this.previousStepPositions.set(this.positions);
    const substeps = Math.max(1, Math.round(this.params.substeps));
    const h = dt / substeps;
    for (let s = 0; s < substeps; s++) this.substep(h);
  }

  private substep(dt: number): void {
    this.applyExternalForces(dt);
    this.findNeighbors();
    this.applyViscosity(dt);
    this.predict(dt);
    this.relaxDoubleDensity(dt);
    this.resolveCollisionsAndVelocities(dt);
  }

  private applyExternalForces(dt: number): void {
    const { velocities, count } = this;
    const dvy = -this.params.gravity * dt;
    const damp = Math.max(0, 1 - this.params.drag * dt);
    for (let i = 0; i < count; i++) {
      velocities[3 * i]! *= damp;
      velocities[3 * i + 1] = (velocities[3 * i + 1]! + dvy) * damp;
      velocities[3 * i + 2]! *= damp;
    }
  }

  private findNeighbors(): void {
    const { positions, count, grid, neighbors, neighborCount } = this;
    const h = this.params.interactionRadius;
    grid.build(positions, count, h);
    for (let i = 0; i < count; i++) {
      neighborCount[i] = grid.query(
        positions,
        positions[3 * i]!,
        positions[3 * i + 1]!,
        positions[3 * i + 2]!,
        h,
        neighbors,
        i * MAX_NEIGHBORS,
        MAX_NEIGHBORS,
        i,
      );
    }
  }

  /** Impulsions radiales entre paires qui se rapprochent (algorithme 5 du papier). */
  private applyViscosity(dt: number): void {
    const { positions: x, velocities: v, count, neighbors, neighborCount } = this;
    const h = this.params.interactionRadius;
    const invH = 1 / h;
    const sigma = this.params.viscosityLinear;
    const beta = this.params.viscosityQuadratic;

    for (let i = 0; i < count; i++) {
      const base = i * MAX_NEIGHBORS;
      const nc = neighborCount[i]!;
      for (let k = 0; k < nc; k++) {
        const j = neighbors[base + k]!;
        if (j <= i) continue; // chaque paire une seule fois
        let rx = x[3 * j]! - x[3 * i]!;
        let ry = x[3 * j + 1]! - x[3 * i + 1]!;
        let rz = x[3 * j + 2]! - x[3 * i + 2]!;
        const r = Math.sqrt(rx * rx + ry * ry + rz * rz);
        const q = r * invH;
        if (q >= 1 || r < 1e-9) continue;
        rx /= r;
        ry /= r;
        rz /= r;
        // u > 0 : i et j se rapprochent.
        const u =
          (v[3 * i]! - v[3 * j]!) * rx + (v[3 * i + 1]! - v[3 * j + 1]!) * ry + (v[3 * i + 2]! - v[3 * j + 2]!) * rz;
        if (u <= 0) continue;
        // Borné à u : l'impulsion annule au plus la vitesse relative, jamais ne l'inverse.
        const mag = Math.min(u, dt * (1 - q) * (sigma * u + beta * u * u)) * 0.5;
        const ix = mag * rx;
        const iy = mag * ry;
        const iz = mag * rz;
        v[3 * i]! -= ix;
        v[3 * i + 1]! -= iy;
        v[3 * i + 2]! -= iz;
        v[3 * j]! += ix;
        v[3 * j + 1]! += iy;
        v[3 * j + 2]! += iz;
      }
    }
  }

  private predict(dt: number): void {
    const { positions, velocities, predictedFrom, count } = this;
    predictedFrom.set(positions);
    const n3 = 3 * count;
    for (let k = 0; k < n3; k++) positions[k]! += velocities[k]! * dt;
  }

  /** Algorithme 2 du papier, en Gauss-Seidel (déplacements appliqués au fil de l'eau). */
  private relaxDoubleDensity(dt: number): void {
    const { positions: x, count, neighbors, neighborCount } = this;
    const { interactionRadius: h, restDensity, stiffness, nearStiffness } = this.params;
    const invH = 1 / h;
    const dt2 = dt * dt;

    for (let i = 0; i < count; i++) {
      const base = i * MAX_NEIGHBORS;
      const nc = neighborCount[i]!;
      const xi = x[3 * i]!;
      const yi = x[3 * i + 1]!;
      const zi = x[3 * i + 2]!;

      let density = 0;
      let nearDensity = 0;
      for (let k = 0; k < nc; k++) {
        const j = neighbors[base + k]!;
        const dx = x[3 * j]! - xi;
        const dy = x[3 * j + 1]! - yi;
        const dz = x[3 * j + 2]! - zi;
        const q = Math.sqrt(dx * dx + dy * dy + dz * dz) * invH;
        if (q >= 1) continue;
        const w = 1 - q;
        density += w * w;
        nearDensity += w * w * w;
      }

      const pressure = stiffness * (density - restDensity);
      const nearPressure = nearStiffness * nearDensity;

      let dix = 0;
      let diy = 0;
      let diz = 0;
      for (let k = 0; k < nc; k++) {
        const j = neighbors[base + k]!;
        const dx = x[3 * j]! - xi;
        const dy = x[3 * j + 1]! - yi;
        const dz = x[3 * j + 2]! - zi;
        const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const q = r * invH;
        if (q >= 1 || r < 1e-9) continue;
        const w = 1 - q;
        const d = (dt2 * (pressure * w + nearPressure * w * w) * 0.5) / r;
        const ddx = d * dx;
        const ddy = d * dy;
        const ddz = d * dz;
        x[3 * j]! += ddx;
        x[3 * j + 1]! += ddy;
        x[3 * j + 2]! += ddz;
        dix -= ddx;
        diy -= ddy;
        diz -= ddz;
      }
      x[3 * i] = xi + dix;
      x[3 * i + 1] = yi + diy;
      x[3 * i + 2] = zi + diz;
    }
  }

  /** Projette dans le récipient, puis déduit les vitesses et applique la friction de paroi. */
  private resolveCollisionsAndVelocities(dt: number): void {
    const { positions: x, velocities: v, predictedFrom: xp, count, container } = this;
    const { particleRadius: pr, wallFriction, maxSpeed } = this.params;
    const yLow = container.yMin + pr;
    const yHigh = container.yMax - pr;
    const invDt = 1 / dt;
    const mu = Math.max(0, wallFriction);
    const maxSpeed2 = maxSpeed * maxSpeed;
    const eps = 1e-3;

    for (let i = 0; i < count; i++) {
      const rawX = x[3 * i]!;
      const rawY = x[3 * i + 1]!;
      const rawZ = x[3 * i + 2]!;
      let px = rawX;
      let py = rawY;
      let pz = rawZ;

      // Normale sortante du contact (0 si pas de contact).
      let nx = 0;
      let ny = 0;
      let nz = 0;

      if (py < yLow) {
        py = yLow;
        ny = -1;
      } else if (py > yHigh) {
        py = yHigh;
        ny = 1;
      }

      const R = container.innerRadius(py) - pr;
      const r = Math.sqrt(px * px + pz * pz);
      if (r > R && r > 1e-9) {
        const s = Math.max(0, R) / r;
        px *= s;
        pz *= s;
        // Gradient de f(x, y, z) = r − R(y) : tient compte de la pente du verre.
        const slope = (container.innerRadius(py + eps) - container.innerRadius(py - eps)) / (2 * eps);
        const wx = px / Math.max(1e-9, Math.sqrt(px * px + pz * pz));
        const wz = pz / Math.max(1e-9, Math.sqrt(px * px + pz * pz));
        nx += wx;
        ny += -slope;
        nz += wz;
      }

      x[3 * i] = px;
      x[3 * i + 1] = py;
      x[3 * i + 2] = pz;

      let vx = (px - xp[3 * i]!) * invDt;
      let vy = (py - xp[3 * i + 1]!) * invDt;
      let vz = (pz - xp[3 * i + 2]!) * invDt;

      const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (nLen > 0) {
        nx /= nLen;
        ny /= nLen;
        nz /= nLen;
        // Vitesse normale annulée par la projection (pénétration / dt).
        const pushed = Math.abs((px - rawX) * nx + (py - rawY) * ny + (pz - rawZ) * nz) * invDt;
        let vn = vx * nx + vy * ny + vz * nz;
        // Pas de vitesse sortante après contact.
        if (vn > 0) {
          vx -= vn * nx;
          vy -= vn * ny;
          vz -= vn * nz;
          vn = 0;
        }
        // Friction de Coulomb : la vitesse tangentielle perd au plus μ · |Δv_n|.
        const tx = vx - vn * nx;
        const ty = vy - vn * ny;
        const tz = vz - vn * nz;
        const vt = Math.sqrt(tx * tx + ty * ty + tz * tz);
        if (vt > 1e-9) {
          const keep = Math.max(0, 1 - (mu * pushed) / vt);
          vx = vn * nx + tx * keep;
          vy = vn * ny + ty * keep;
          vz = vn * nz + tz * keep;
        }
      }

      const speed2 = vx * vx + vy * vy + vz * vz;
      if (speed2 > maxSpeed2) {
        const s = maxSpeed / Math.sqrt(speed2);
        vx *= s;
        vy *= s;
        vz *= s;
      }

      v[3 * i] = vx;
      v[3 * i + 1] = vy;
      v[3 * i + 2] = vz;
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
