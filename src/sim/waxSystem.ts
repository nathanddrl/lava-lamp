import type { ContainerShape } from './lampProfile';
import { mulberry32 } from './random';
import { SpatialHashGrid } from './spatialHashGrid';

/**
 * Cire en particules, méthode « double density relaxation » de Clavet, Beaudoin
 * & Poulin 2005 (Particle-based Viscoelastic Fluid Simulation) :
 *
 *   1. forces externes sur v (gravité, flottabilité thermique, traînée du liquide)
 *   2. viscosité par impulsions radiales entre paires (sur v) + conduction thermique
 *   3. prédiction : x_prev = x ; x += v·dt
 *   4. relaxation de double densité (sur x) : pression + pression « near »
 *      → cohésion et pseudo tension de surface sans résoudre Navier-Stokes
 *   5. collisions avec le récipient (sur x)
 *   6. v = (x − x_prev) / dt
 *
 * Thermique (par particule, T ∈ [0, 1]) :
 *   dT/dt = chauffe(y)·(1 − T) + échange(y)·exposition·(T_amb(y) − T) + conduction
 *   - chauffe(y, r) = heatRate · exp(−(y − yMin) / heatFalloff) · exp(−(r / heatRadius)²) :
 *     ampoule sous le centre du fond ;
 *   - échange avec le liquide vers T_amb(y) (stratifiée : chaude au fond, neutre au
 *     milieu, froide sous le capuchon), au taux coolRate · (1 + coolTopBoost · hauteur^coolTopExponent
 *     + wallCooling · (r / R(y))⁴) : plus fort en haut et contre le verre, par où la
 *     chaleur quitte la lampe ; le panache central garde sa chaleur ;
 *   - exposition : 1 en surface, `interiorCooling` au cœur (estimée par la densité
 *     locale), d'où un cœur de blob qui reste chaud plus longtemps que sa peau ;
 *   - conduction : échange κ·(1 − r/h)²·(Tj − Ti) entre voisins (conservatif).
 *   Flottabilité : a_y = −gravity + amax · tanh(buoyancy · (T − neutralTemperature) / amax),
 *   soit buoyancy · (T − Tn) près de la neutralité, saturé à ±amax (= buoyancyMax).
 *   Avec une hystérésis de fusion δ, Tn vaut Tn − δ/2 pour une particule fondue et
 *   Tn + δ/2 pour une particule figée (bascule de Schmitt) : c'est ce qui transforme
 *   la convection stationnaire en cycle de relaxation (gouttes qui montent et redescendent).
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
  /**
   * Facteur appliqué à la pression négative (ρ < ρ0), qui fait la cohésion.
   * 1 = papier ; plus bas, la cire se déchire plus facilement en gouttes.
   */
  cohesion: number;
  /** σ : viscosité linéaire. */
  viscosityLinear: number;
  /** β : viscosité quadratique. */
  viscosityQuadratic: number;
  /**
   * Multiplicateur de viscosité (σ et β) pour une paire de cire chaude : 1 = viscosité
   * uniforme ; < 1 = cire chaude fluide (le col des colonnes se rompt), cire froide
   * épaisse (le réservoir ne se laisse pas aspirer). Interpolé sur la bande d'hystérésis
   * selon la température moyenne de la paire.
   */
  viscosityHotFactor: number;
  /** Poids apparent résiduel (poids − poussée) à la température neutre, unités/s². */
  gravity: number;
  /** Accélération verticale par unité d'écart à la température neutre, unités/s². */
  buoyancy: number;
  /**
   * Plafond de l'accélération de flottabilité (saturation en tanh). Modélise la
   * dilatation brutale de la cire autour de sa fusion : gain fort près de la
   * température neutre, vitesse de croisière bornée. Infinity = linéaire pur.
   */
  buoyancyMax: number;
  /** Température à laquelle la cire a la densité du liquide. */
  neutralTemperature: number;
  /**
   * Hystérésis de fusion δ : la cire figée ne devient flottante qu'au-dessus de
   * Tn + δ/2, la cire fondue ne redevient dense qu'en dessous de Tn − δ/2
   * (chaleur latente, surfusion). 0 = flottabilité linéaire pure.
   */
  meltHysteresis: number;
  /** Taux de chauffe au fond du récipient, 1/s. */
  heatRate: number;
  /** Hauteur caractéristique de décroissance de la chauffe au-dessus du fond. */
  heatFalloff: number;
  /** Rayon caractéristique de la tache chaude au-dessus de l'ampoule (gaussienne). */
  heatRadius: number;
  /** Taux d'échange de base avec le liquide (relaxation vers T_amb), 1/s. */
  coolRate: number;
  /**
   * Température ambiante du liquide, stratifiée : `ambientBottom` près du fond,
   * `ambientMid` sur la zone médiane, `ambientTop` sous le capuchon. Placer la zone
   * médiane dans la bande morte de l'hystérésis empêche une goutte de changer d'état
   * en route. Tout à 0 = refroidissement vers 0 partout (modèle de l'étape 3).
   */
  ambientBottom: number;
  ambientMid: number;
  ambientTop: number;
  /** Hauteur normalisée où l'ambiance du fond rejoint celle de la zone médiane. */
  ambientBottomHeight: number;
  /** Hauteur normalisée où commence la transition vers l'ambiance du haut. */
  ambientTopStart: number;
  /** Surcroît de refroidissement en haut : × (1 + boost · hauteur normalisée^exposant). */
  coolTopBoost: number;
  /** Exposant du profil de refroidissement : plus il est grand, plus le froid est concentré en haut. */
  coolTopExponent: number;
  /** Surcroît de refroidissement près du verre : × (… + wallCooling · (r / R)⁴). */
  wallCooling: number;
  /** Fraction du refroidissement subie par une particule entièrement entourée. */
  interiorCooling: number;
  /** Conduction entre voisins, 1/s. */
  conductivity: number;
  /** Traînée linéaire du liquide environnant, 1/s. */
  drag: number;
  /** Coefficient de friction de Coulomb μ contre le verre (indépendant du dt). */
  wallFriction: number;
  /** Rayon de collision d'une particule avec les parois. */
  particleRadius: number;
  /** Vitesse verticale max donnée par le bouton « impulsion ». */
  impulseStrength: number;
  /** Largeur du jet d'impulsion, en fraction du rayon intérieur du verre. */
  impulseWidth: number;
  /** Garde-fou contre l'explosion numérique. */
  maxSpeed: number;
  substeps: number;
  seed: number;
}

/**
 * Réglage de référence = preset « équilibré » (800 particules, pas fixe 1/60 s ×
 * 2 sous-pas), réglé au banc headless (`npm run bench`). Voir CLAUDE.md pour la
 * démarche et src/sim/presets.ts pour les variantes.
 */
export const DEFAULT_WAX_PARAMS: WaxParams = {
  particleCount: 800,
  // Volume de cire constant par rapport à 400 particules / h = 0.13 : h ∝ N^(−1/3).
  interactionRadius: 0.103,
  // ≈ 30 voisins par particule au repos : cohésion correcte, coût maîtrisé.
  restDensity: 3,
  stiffness: 32,
  nearStiffness: 127,
  // Cohésion légèrement réduite : les colonnes peuvent se rompre en gouttes.
  cohesion: 0.8,
  // Viscosité forte pour la cire figée, ×0.05 pour la cire fondue : le réservoir
  // résiste, le col des colonnes se rompt plus tôt (utile avec wallCooling).
  viscosityLinear: 60,
  viscosityQuadratic: 20,
  viscosityHotFactor: 0.05,
  gravity: 0,
  // Forces fortes + traînée forte : assez pour vaincre le seuil d'écoulement du
  // fluide de Clavet, vitesse de croisière lente.
  buoyancy: 60,
  buoyancyMax: 1000,
  neutralTemperature: 0.5,
  meltHysteresis: 0.3,
  // Point chaud mince et étroit : seule une petite fraction du réservoir fond à la fois.
  heatRate: 4,
  heatFalloff: 0.03,
  heatRadius: 0.05,
  // Ambiance stratifiée : sous la bande morte au fond (le réservoir reste figé),
  // au centre de la bande au milieu (aucune bascule en route), froide sous le capuchon.
  coolRate: 0.1,
  ambientBottom: 0.2,
  ambientMid: 0.5,
  ambientTop: 0.05,
  ambientBottomHeight: 0.15,
  ambientTopStart: 0.9,
  coolTopBoost: 30,
  coolTopExponent: 8,
  wallCooling: 10,
  interiorCooling: 0.4,
  conductivity: 1,
  drag: 60,
  wallFriction: 0.3,
  particleRadius: 0.024,
  impulseStrength: 13,
  impulseWidth: 0.8,
  maxSpeed: 8,
  substeps: 2,
  seed: 1,
};

/** Paramètres qui coupent la thermique (étape 2 : gravité seule, cire passive). */
export const NO_THERMAL_PARAMS: Partial<WaxParams> = {
  gravity: 0.8,
  buoyancy: 0,
  heatRate: 0,
  coolRate: 0,
  conductivity: 0,
  meltHysteresis: 0,
  ambientBottom: 0,
  ambientMid: 0,
  ambientTop: 0,
  viscosityHotFactor: 1,
  cohesion: 1,
  drag: 0.6,
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
  /** Température par particule, 0 = froid, 1 = chaud. */
  temperatures = new Float32Array(0);
  /** Densité locale au dernier sous-pas (sert d'indicateur de surface). */
  densities = new Float32Array(0);
  /** État de fusion par particule (1 = fondue, flottante), cf. `meltHysteresis`. */
  molten = new Uint8Array(0);

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
      this.temperatures = new Float32Array(n);
      this.densities = new Float32Array(n);
      this.molten = new Uint8Array(n);
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
    this.temperatures.fill(0);
    this.densities.fill(this.params.restDensity);
    this.molten.fill(0);
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
      const radial = Math.max(0, 1 - Math.sqrt(x * x + z * z) / (this.params.impulseWidth * R));
      const vertical = Math.min(1, (y - yLow) * invSpan);
      velocities[3 * i + 1]! += s * radial * radial * vertical * vertical;
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
    this.applyViscosityAndConduction(dt);
    this.applyHeatExchange(dt);
    this.predict(dt);
    this.relaxDoubleDensity(dt);
    this.resolveCollisionsAndVelocities(dt);
  }

  private applyExternalForces(dt: number): void {
    const { velocities, temperatures, molten, count } = this;
    const { gravity, buoyancy, buoyancyMax, neutralTemperature, meltHysteresis, drag } = this.params;
    const damp = Math.max(0, 1 - drag * dt);
    const saturate = Number.isFinite(buoyancyMax) && buoyancyMax > 0;
    const half = 0.5 * Math.max(0, meltHysteresis);
    for (let i = 0; i < count; i++) {
      const t = temperatures[i]!;
      if (t > neutralTemperature + half) molten[i] = 1;
      else if (t < neutralTemperature - half) molten[i] = 0;
      const tn = molten[i] ? neutralTemperature - half : neutralTemperature + half;
      const linear = buoyancy * (t - tn);
      const lift = saturate ? buoyancyMax * Math.tanh(linear / buoyancyMax) : linear;
      const ay = lift - gravity;
      velocities[3 * i]! *= damp;
      velocities[3 * i + 1] = (velocities[3 * i + 1]! + ay * dt) * damp;
      velocities[3 * i + 2]! *= damp;
    }
  }

  /** Chauffe par le fond, refroidissement vers le liquide (pondéré par l'exposition). */
  private applyHeatExchange(dt: number): void {
    const { positions, temperatures: T, densities, count, container } = this;
    const { heatRate, heatFalloff, heatRadius, coolRate, coolTopBoost, coolTopExponent, wallCooling, interiorCooling, restDensity } =
      this.params;
    const { ambientBottom, ambientMid, ambientTop, ambientBottomHeight, ambientTopStart } = this.params;
    const invRadius2 = 1 / Math.max(1e-6, heatRadius * heatRadius);
    if (heatRate === 0 && coolRate === 0) return;
    const invFalloff = 1 / Math.max(1e-3, heatFalloff);
    const invHeight = 1 / (container.yMax - container.yMin);
    const invRest = 1 / Math.max(1e-6, restDensity);
    for (let i = 0; i < count; i++) {
      const above = Math.max(0, positions[3 * i + 1]! - container.yMin);
      const hn = Math.min(1, above * invHeight);
      const exposure = clamp(1 - densities[i]! * invRest, 0, 1);
      const shield = interiorCooling + (1 - interiorCooling) * exposure;
      const px = positions[3 * i]!;
      const pz = positions[3 * i + 2]!;
      const r2 = px * px + pz * pz;
      const heat = heatRate * Math.exp(-above * invFalloff - r2 * invRadius2);
      let wall = 0;
      if (wallCooling > 0) {
        const R = container.innerRadius(clamp(positions[3 * i + 1]!, container.yMin, container.yMax));
        const u = R > 1e-6 ? r2 / (R * R) : 1;
        wall = wallCooling * u * u;
      }
      const cool = coolRate * (1 + coolTopBoost * Math.pow(hn, coolTopExponent) + wall) * shield;
      const amb =
        ambientMid +
        (ambientBottom - ambientMid) * (1 - smoothstep(0, ambientBottomHeight, hn)) +
        (ambientTop - ambientMid) * smoothstep(ambientTopStart, 1, hn);
      const t = T[i]!;
      // dT = chauffe·(1 − T) + échange·(T_amb − T), implicite : stable quel que soit dt.
      T[i] = clamp((t + dt * (heat + cool * amb)) / (1 + dt * (heat + cool)), 0, 1);
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

  /**
   * Impulsions radiales entre paires qui se rapprochent (algorithme 5 du papier),
   * et conduction thermique sur les mêmes paires (une seule passe de distances).
   */
  private applyViscosityAndConduction(dt: number): void {
    const { positions: x, velocities: v, temperatures: T, count, neighbors, neighborCount } = this;
    // Borné pour la stabilité : Σ voisins ≈ ρ0, l'échange reste < 1/2 par pas.
    const kappa = Math.min(this.params.conductivity * dt, 0.5 / Math.max(1, this.params.restDensity));
    const h = this.params.interactionRadius;
    const invH = 1 / h;
    const sigma = this.params.viscosityLinear;
    const beta = this.params.viscosityQuadratic;
    const { viscosityHotFactor, neutralTemperature, meltHysteresis } = this.params;
    const thermalVisc = viscosityHotFactor !== 1;
    const viscLow = neutralTemperature - 0.5 * meltHysteresis;
    const invViscBand = 1 / Math.max(0.05, meltHysteresis);

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
        if (kappa > 0) {
          const w = 1 - q;
          const flux = kappa * w * w * (T[j]! - T[i]!);
          T[i]! += flux;
          T[j]! -= flux;
        }
        rx /= r;
        ry /= r;
        rz /= r;
        // u > 0 : i et j se rapprochent.
        const u =
          (v[3 * i]! - v[3 * j]!) * rx + (v[3 * i + 1]! - v[3 * j + 1]!) * ry + (v[3 * i + 2]! - v[3 * j + 2]!) * rz;
        if (u <= 0) continue;
        let visc = 1;
        if (thermalVisc) {
          const hot = clamp((0.5 * (T[i]! + T[j]!) - viscLow) * invViscBand, 0, 1);
          visc = 1 + (viscosityHotFactor - 1) * hot;
        }
        // Borné à u : l'impulsion annule au plus la vitesse relative, jamais ne l'inverse.
        const mag = Math.min(u, dt * (1 - q) * visc * (sigma * u + beta * u * u)) * 0.5;
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
    const { positions: x, densities, count, neighbors, neighborCount } = this;
    const { interactionRadius: h, restDensity, stiffness, nearStiffness, cohesion } = this.params;
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

      densities[i] = density;
      let pressure = stiffness * (density - restDensity);
      if (pressure < 0) pressure *= cohesion;
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

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / Math.max(1e-6, e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
